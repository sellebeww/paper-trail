// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Chaos tests against the real RabbitMQ and Postgres: a worker that dies mid-job, a broker restart, and a
// database that stalls. In every case the anchor job must finish exactly once, with no job lost.
//
// The broker restart runs `docker restart` on the RabbitMQ container: CHAOS_RABBITMQ_CONTAINER (CI sets it
// to the service container id), else the `rabbitmq` service of the local docker compose project.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createMockTsa, type MockTsa } from '@paper-trail/verifier/testing';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrls } from '../../api/test/global-setup.js';
import { ledgerFixtures, waitFor, workerRole } from '../test/fixtures.js';
import { WORKER_TEST_DB } from '../test/global-setup.js';
import type { AnchorJob, Timestamper } from './anchor.js';
import { loadConfig } from './config.js';
import { allQueues, assertTopology, deadLetterQueue, publishJson, topology } from './messaging.js';
import { requestTimestamp } from './tsa.js';
import { startWorker } from './worker.js';

const DELAYS = [100, 200];
const PREFIX = `chaos${randomBytes(3).toString('hex')}.`;
const T = topology(PREFIX);

let admin: pg.Pool;
let role: Awaited<ReturnType<typeof workerRole>>;
let fx: ReturnType<typeof ledgerFixtures>;
let tsa: MockTsa;
const connections: ChannelModel[] = [];
const logs: Record<string, unknown>[] = [];

const connect = async () => {
  const c = await amqp.connect(process.env['AMQP_URL']!);
  c.on('error', () => undefined); // a broker restart emits 'error' before 'close'; the tests watch 'close'
  connections.push(c);
  return c;
};

const realTsa: Timestamper = (data) =>
  requestTimestamp({ urls: [tsa.url], timeoutMs: 2_000, trustedCerts: [tsa.caCert] }, data);

/**
 * A TSA call that hangs, so the job is in flight (unacked) when the chaos happens. `fail()` then makes it
 * fail, driving the consumer into its error path on a channel that is already gone.
 */
const hangingTsa = () => {
  let called!: () => void;
  let reject!: (err: Error) => void;
  const started = new Promise<void>((r) => (called = r));
  const timestamp: Timestamper = () => {
    called();
    return new Promise((_, r) => (reject = r));
  };
  return { started, timestamp, fail: () => reject(new Error('TSA call failed after the crash')) };
};

const start = async (connection: ChannelModel, timestamp: Timestamper) =>
  startWorker({
    config: loadConfig({
      AMQP_URL: process.env['AMQP_URL'],
      WORKER_DATABASE_URL: role.url,
      TSA_URLS: tsa.url,
      RETRY_DELAYS_MS: DELAYS.join(','),
      QUEUE_PREFIX: PREFIX,
    }),
    pool: role.pool,
    connection,
    timestamp,
    log: (f) => logs.push(f),
    notifier: { channel: 'test', send: async () => undefined },
  });

const jobFor = async (entries: number): Promise<AnchorJob> => {
  const ledgerId = await fx.newLedger(entries);
  const head = fx.chains.get(ledgerId)!.at(-1)!;
  return { ledger_id: ledgerId, head_seq: head.seq, head_hash: head.entry_hash };
};

const publish = async (connection: ChannelModel, job: AnchorJob) => {
  const ch = await connection.createConfirmChannel();
  await assertTopology(ch, T, DELAYS);
  await publishJson(ch, T.exchange, T.anchor, job, `anchor:${job.ledger_id}:${job.head_seq}`);
  await ch.close();
};

const anchorRows = async (job: AnchorJob) =>
  (
    await admin.query<{ status: string; attempts: number; has_token: boolean }>(
      'SELECT status, attempts, tst_token IS NOT NULL AS has_token FROM anchors WHERE ledger_id = $1',
      [job.ledger_id],
    )
  ).rows;

const anchoredOnce = async (job: AnchorJob) => {
  await waitFor(
    async () => (await fx.anchor(job.ledger_id, job.head_seq))?.status === 'ok',
    20_000,
  );
  const rows = await anchorRows(job);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'ok', has_token: true });
  return rows[0]!;
};

const rabbitContainer = () =>
  process.env['CHAOS_RABBITMQ_CONTAINER'] ||
  execFileSync('docker', ['compose', 'ps', '-q', 'rabbitmq'], {
    cwd: resolve(import.meta.dirname, '../../..'),
    encoding: 'utf8',
  }).trim();

beforeAll(async () => {
  const urls = testDatabaseUrls(WORKER_TEST_DB);
  admin = new pg.Pool({ connectionString: urls.test });
  fx = ledgerFixtures(admin);
  role = await workerRole(admin, urls.test);
  tsa = await createMockTsa();
});

// Every test stops its workers, so a leftover consumer never steals the next test's job.
const closeAll = async () => {
  for (const conn of connections.splice(0)) await conn.close().catch(() => undefined);
};
afterEach(closeAll);

afterAll(async () => {
  const c = await connect();
  const ch = await c.createChannel();
  for (const q of allQueues(T, DELAYS)) await ch.deleteQueue(q);
  await ch.deleteExchange(T.exchange);
  await closeAll();
  await role.drop();
  await admin.end();
  await tsa.close();
});

describe('chaos', () => {
  it('a worker that dies mid-anchor loses no job: another worker finishes it exactly once', async () => {
    const job = await jobFor(2);
    const doomed = hangingTsa();
    const connA = await connect();
    await start(connA, doomed.timestamp);
    await publish(connA, job);
    await doomed.started; // worker A holds the job, unacked, with a pending anchor row
    expect(await anchorRows(job)).toMatchObject([{ status: 'pending', attempts: 1 }]);

    // Dropping the connection is what the broker sees when the process is killed: unacked → requeued.
    await connA.close();
    doomed.fail();
    await start(await connect(), realTsa);

    const row = await anchoredOnce(job);
    expect(row.attempts).toBe(2); // A's attempt and B's
  });

  it('survives a RabbitMQ restart: the persistent in-flight job is redelivered and anchored once', async () => {
    const job = await jobFor(3);
    const doomed = hangingTsa();
    const connA = await connect();
    const closed = new Promise<void>((r) => connA.on('close', () => r()));
    await start(connA, doomed.timestamp);
    await publish(connA, job);
    await doomed.started;

    execFileSync('docker', ['restart', rabbitContainer()], { stdio: 'ignore' });
    await closed; // in production the worker exits here and its supervisor restarts it (src/index.ts)
    doomed.fail();

    const connB = await waitFor(() => connect().catch(() => undefined), 60_000);
    await start(connB, realTsa);
    await anchoredOnce(job);
  }, 120_000);

  it('a stalled database delays anchoring but loses or duplicates nothing', async () => {
    const job = await jobFor(1);
    const conn = await connect();
    const worker = await start(conn, realTsa);

    const locker = await admin.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE anchors IN ACCESS EXCLUSIVE MODE'); // every worker query on anchors now waits
      await publish(conn, job);
      await publish(conn, job); // a duplicate delivery, racing the first once the lock is released
      await new Promise((r) => setTimeout(r, 1_500));
      const during = await locker.query('SELECT 1 FROM anchors WHERE ledger_id = $1', [
        job.ledger_id,
      ]);
      expect(during.rowCount).toBe(0);
      expect((await worker.channel.checkQueue(deadLetterQueue(T.anchor))).messageCount).toBe(0);
      await locker.query('COMMIT');
    } finally {
      locker.release();
    }

    await anchoredOnce(job);
    const outcomes = () =>
      logs
        .filter((l) => l['message_id'] === `anchor:${job.ledger_id}:${job.head_seq}`)
        .filter((l) => l['msg'] === 'job done')
        .map((l) => l['outcome'])
        .sort();
    // The duplicate may still be finishing after the row turns ok.
    await waitFor(async () => outcomes().length === 2);
    expect(outcomes()).toEqual(['already-anchored', 'anchored']);
  });
});
