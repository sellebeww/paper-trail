// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// Real RabbitMQ (docker compose) + real Postgres + the local mock TSA. Queues use a random prefix and are
// deleted afterwards; the worker connects as a fresh member of the least-privilege pt_worker role.
import { randomBytes, randomUUID } from 'node:crypto';
import { buildEntry, type Entry } from '@paper-trail/chain';
import amqp, { type ChannelModel } from 'amqplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrls } from '../../api/test/global-setup.js';
import { WORKER_TEST_DB } from '../test/global-setup.js';
import { loadConfig } from './config.js';
import { createMockTsa, type MockTsa } from './dev/mock-tsa.js';
import { allQueues, deadLetterQueue, publishJson } from './messaging.js';
import type { Notification } from './notifier.js';
import { requestTimestamp } from './tsa.js';
import { startWorker } from './worker.js';

const DELAYS = [100, 200]; // 3 attempts in total
const PREFIX = `it${randomBytes(3).toString('hex')}.`;
const ROLE = `pt_worker_it_${randomBytes(4).toString('hex')}`;
const PASSWORD = randomBytes(16).toString('hex');

let admin: pg.Pool; // owner role: fixtures only
let workerPool: pg.Pool; // what the worker uses
let connection: ChannelModel;
let tsa: MockTsa;
let worker: Awaited<ReturnType<typeof startWorker>>;
const sent: Notification[] = [];
const logs: Record<string, unknown>[] = [];

const waitFor = async <T>(probe: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

// ---- fixtures: a ledger with a valid chain, written as the owner role ----
const chains = new Map<string, Entry[]>();
const append = async (ledgerId: string) => {
  const chain = chains.get(ledgerId)!;
  const prev = chain.at(-1) ?? null;
  const entry = buildEntry(
    {
      ledger_id: ledgerId,
      type: 'note',
      created_at: new Date(Date.now() - 60_000 + chain.length).toISOString(),
      author_ref: 'owner:0000',
      payload: { text: `catatan ${chain.length}` },
    },
    prev,
  );
  await admin.query(
    `INSERT INTO entries (id, ledger_id, seq, type, created_at, author_ref, payload_hash, payload, prev_hash, entry_hash)
     VALUES (gen_random_uuid(), $1, $2, 'note', $3, $4, $5, $6, $7, $8)`,
    [
      ledgerId,
      entry.seq,
      entry.created_at,
      entry.author_ref,
      entry.payload_hash,
      entry.payload,
      entry.prev_hash,
      entry.entry_hash,
    ],
  );
  await admin.query('UPDATE ledgers SET head_seq = $2, head_hash = $3 WHERE id = $1', [
    ledgerId,
    entry.seq,
    entry.entry_hash,
  ]);
  chain.push(entry);
  return entry;
};
const newUser = async () =>
  (
    await admin.query<{ id: string; email: string }>(
      `INSERT INTO users (id, email, password_hash) VALUES (gen_random_uuid(), $1, 'x') RETURNING id, email`,
      [`${randomUUID()}@example.test`],
    )
  ).rows[0]!;
const newLedger = async (entries: number) => {
  const user = await newUser();
  const { id } = (
    await admin.query<{ id: string }>(
      `INSERT INTO ledgers (id, owner_id, title, category) VALUES (gen_random_uuid(), $1, 'Uji worker', 'kerja') RETURNING id`,
      [user.id],
    )
  ).rows[0]!;
  chains.set(id, []);
  for (let i = 0; i < entries; i++) await append(id);
  return id;
};
const anchor = async (ledgerId: string, seq: number) =>
  (
    await admin.query<{
      status: string;
      attempts: number;
      tst_token: Buffer | null;
      tst_gen_time: Date | null;
      tsa_url: string;
      last_error: string | null;
      anchor_digest: string;
    }>(
      'SELECT status, attempts, tst_token, tst_gen_time, tsa_url, last_error, anchor_digest FROM anchors WHERE ledger_id = $1 AND anchored_head_seq = $2',
      [ledgerId, seq],
    )
  ).rows[0];
const dlqDepth = async (queue: string) =>
  (await worker.channel.checkQueue(deadLetterQueue(queue))).messageCount;
const outcomes = (messageId: string) =>
  logs
    .filter((l) => l['message_id'] === messageId && l['msg'] === 'job done')
    .map((l) => l['outcome']);

beforeAll(async () => {
  const urls = testDatabaseUrls(WORKER_TEST_DB); // also loads .env (AMQP_URL)
  admin = new pg.Pool({ connectionString: urls.test });
  await admin.query(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}' IN ROLE pt_worker`); // hex only: safe to inline
  const workerUrl = new URL(urls.test);
  workerUrl.username = ROLE;
  workerUrl.password = PASSWORD;
  workerPool = new pg.Pool({ connectionString: workerUrl.toString() });

  tsa = await createMockTsa();
  connection = await amqp.connect(process.env['AMQP_URL']!);
  const config = loadConfig({
    AMQP_URL: process.env['AMQP_URL'],
    WORKER_DATABASE_URL: workerUrl.toString(),
    TSA_URLS: tsa.url,
    RETRY_DELAYS_MS: DELAYS.join(','),
    QUEUE_PREFIX: PREFIX,
  });
  worker = await startWorker({
    config,
    pool: workerPool,
    connection,
    log: (f) => logs.push(f),
    notifier: { channel: 'test', send: async (n) => void sent.push(n) },
    timestamp: (data) =>
      requestTimestamp({ urls: [tsa.url], timeoutMs: 2_000, trustedCerts: [tsa.caCert] }, data),
  });
});

afterAll(async () => {
  await worker?.stop();
  const ch = await connection.createChannel();
  for (const q of allQueues(worker.topology, DELAYS)) await ch.deleteQueue(q);
  await ch.deleteExchange(worker.topology.exchange);
  await connection.close();
  await workerPool.end();
  await admin.query(`DROP ROLE ${ROLE}`);
  await admin.end();
  await tsa.close();
});

describe('least-privilege database role', () => {
  it('can read the chain and write anchors, but cannot write entries or read password hashes', async () => {
    const ledgerId = await newLedger(1);
    const [entry] = chains.get(ledgerId)!;
    const denied = /permission denied/;
    await expect(
      workerPool.query(`UPDATE entries SET author_ref = 'owner:1' WHERE ledger_id = $1`, [
        ledgerId,
      ]),
    ).rejects.toThrow(denied);
    await expect(
      workerPool.query('DELETE FROM entries WHERE ledger_id = $1', [ledgerId]),
    ).rejects.toThrow(denied);
    await expect(
      workerPool.query(
        `INSERT INTO entries (id, ledger_id, seq, type, created_at, author_ref, payload_hash, payload, prev_hash, entry_hash)
         VALUES (gen_random_uuid(), $1, 1, 'note', now(), 'owner:1', $2, '{}', $2, $2)`,
        [ledgerId, 'a'.repeat(64)],
      ),
    ).rejects.toThrow(denied);
    await expect(workerPool.query('UPDATE ledgers SET title = $1', ['x'])).rejects.toThrow(denied);
    await expect(workerPool.query('SELECT password_hash FROM users')).rejects.toThrow(denied);
    await expect(workerPool.query('SELECT * FROM sessions')).rejects.toThrow(denied);
    await expect(
      workerPool.query(
        'INSERT INTO users (id, email, password_hash) VALUES (gen_random_uuid(), $1, $2)',
        ['a@b.c', 'x'],
      ),
    ).rejects.toThrow(denied);

    expect(
      (await workerPool.query('SELECT entry_hash FROM entries WHERE ledger_id = $1', [ledgerId]))
        .rows[0].entry_hash,
    ).toBe(entry!.entry_hash);
    expect((await workerPool.query('SELECT email FROM users LIMIT 1')).rowCount).toBe(1);
  });
});

describe('anchoring', () => {
  it('anchors a changed ledger with a genTime, skips it while unchanged, and anchors again after a new entry', async () => {
    const ledgerId = await newLedger(3);
    const head = chains.get(ledgerId)![2]!;
    const before = tsa.requests;

    const queued = await worker.tickAnchors();
    expect(queued).toContainEqual({ ledger_id: ledgerId, head_seq: 2, head_hash: head.entry_hash });
    const done = await waitFor(
      async () => (await anchor(ledgerId, 2))?.status === 'ok' && anchor(ledgerId, 2),
    );
    expect(done.tst_gen_time).toBeInstanceOf(Date);
    expect(done.tst_gen_time!.getTime()).toBeGreaterThanOrEqual(
      new Date(head.created_at).getTime() - 1000,
    );
    expect(done.tsa_url).toBe(tsa.url);
    expect(done.anchor_digest).toBe(head.entry_hash); // SPEC §5.1: the imprint is the head hash itself
    expect(done.tst_token!.length).toBeGreaterThan(300);
    // One TSA request per queued ledger (other tests' ledgers may be in this batch too).
    for (const job of queued)
      await waitFor(async () => (await anchor(job.ledger_id, job.head_seq))?.status === 'ok');
    expect(tsa.requests - before).toBe(queued.length);
    const settled = tsa.requests;

    // Unchanged ledger: not queued again, no TSA traffic.
    const again = await worker.tickAnchors();
    expect(again.map((j) => j.ledger_id)).not.toContain(ledgerId);
    await new Promise((r) => setTimeout(r, 300));
    expect(tsa.requests).toBe(settled);

    // New entry → new head → anchored as well; the old anchor is untouched.
    const next = await append(ledgerId);
    expect((await worker.tickAnchors()).map((j) => j.head_seq)).toContain(next.seq);
    await waitFor(async () => (await anchor(ledgerId, 3))?.status === 'ok');
    expect((await anchor(ledgerId, 2))!.tst_token!.equals(done.tst_token!)).toBe(true);
  });

  it('is idempotent: the same job delivered several times yields one anchor and a stable token', async () => {
    const ledgerId = await newLedger(1);
    const head = chains.get(ledgerId)![0]!;
    const job = { ledger_id: ledgerId, head_seq: 0, head_hash: head.entry_hash };
    const id = `anchor:${ledgerId}:0`;
    await Promise.all(
      [1, 2, 3].map(() =>
        publishJson(worker.channel, worker.topology.exchange, worker.topology.anchor, job, id),
      ),
    );
    await waitFor(async () => outcomes(id).length === 3);

    const rows = await admin.query('SELECT status, tst_token FROM anchors WHERE ledger_id = $1', [
      ledgerId,
    ]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].status).toBe('ok');
    expect(outcomes(id).filter((o) => o === 'anchored')).toHaveLength(1);

    const requests = tsa.requests;
    await publishJson(worker.channel, worker.topology.exchange, worker.topology.anchor, job, id);
    await waitFor(async () => outcomes(id).length === 4);
    expect(outcomes(id)[3]).toBe('already-anchored');
    expect(tsa.requests).toBe(requests); // short-circuits before calling the TSA
    expect((await anchor(ledgerId, 0))!.tst_token!.equals(rows.rows[0].tst_token)).toBe(true);
  });

  it('retries with backoff, dead-letters after the last attempt, marks the anchor failed, and recovers later', async () => {
    const ledgerId = await newLedger(2);
    const dlqBefore = await dlqDepth(worker.topology.anchor);
    const requestsBefore = tsa.requests;
    tsa.setMode('http-500');
    try {
      await worker.tickAnchors();
      const failed = await waitFor(
        async () => (await anchor(ledgerId, 1))?.status === 'failed' && anchor(ledgerId, 1),
      );
      expect(failed.attempts).toBe(DELAYS.length + 1);
      expect(failed.last_error).toMatch(/HTTP 500/);
      expect(failed.tst_token).toBeNull();
      expect(tsa.requests - requestsBefore).toBe(DELAYS.length + 1);
      expect(await dlqDepth(worker.topology.anchor)).toBe(dlqBefore + 1);
      const id = `anchor:${ledgerId}:1`;
      expect(
        logs.filter((l) => l['message_id'] === id && l['msg'] === 'job retry scheduled'),
      ).toHaveLength(DELAYS.length);
      expect(
        logs.find((l) => l['message_id'] === id && l['msg'] === 'job dead-lettered'),
      ).toMatchObject({ level: 'error', attempts: 3 });
    } finally {
      tsa.setMode('ok');
    }

    // The next scheduler run picks the failed head up again.
    expect((await worker.tickAnchors()).map((j) => j.ledger_id)).toContain(ledgerId);
    await waitFor(async () => (await anchor(ledgerId, 1))?.status === 'ok');
  });

  it('sends an invalid TSA answer (wrong nonce) straight to the DLQ without storing a token', async () => {
    const ledgerId = await newLedger(1);
    const dlqBefore = await dlqDepth(worker.topology.anchor);
    tsa.setMode('wrong-nonce');
    try {
      const head = chains.get(ledgerId)![0]!;
      await publishJson(
        worker.channel,
        worker.topology.exchange,
        worker.topology.anchor,
        { ledger_id: ledgerId, head_seq: 0, head_hash: head.entry_hash },
        `anchor:${ledgerId}:0`,
      );
      const failed = await waitFor(
        async () => (await anchor(ledgerId, 0))?.status === 'failed' && anchor(ledgerId, 0),
      );
      expect(failed.attempts).toBe(1); // permanent: no retries
      expect(failed.last_error).toMatch(/nonce/);
      expect(failed.tst_token).toBeNull();
      expect(await dlqDepth(worker.topology.anchor)).toBe(dlqBefore + 1);
    } finally {
      tsa.setMode('ok');
    }
  });

  it('dead-letters malformed messages and jobs for entries that do not exist', async () => {
    const before = await dlqDepth(worker.topology.anchor);
    await publishJson(
      worker.channel,
      worker.topology.exchange,
      worker.topology.anchor,
      { hello: 'world' },
      'junk-1',
    );
    await publishJson(
      worker.channel,
      worker.topology.exchange,
      worker.topology.anchor,
      { ledger_id: randomUUID(), head_seq: 0, head_hash: 'e'.repeat(64) },
      'junk-2',
    );
    await waitFor(async () => (await dlqDepth(worker.topology.anchor)) === before + 2);
  });
});

describe('reminders', () => {
  it('sends a due reminder once, schedules the next one, and ignores duplicates', async () => {
    const user = await newUser();
    const ledgerId = await newLedger(0);
    const { id } = (
      await admin.query<{ id: string }>(
        `INSERT INTO reminder_schedules (id, user_id, ledger_id, days_of_week, time_of_day, timezone, next_run_at)
       VALUES (gen_random_uuid(), $1, $2, '{1,2,3,4,5,6,7}', '17:00', 'Asia/Jakarta', now() - interval '1 minute') RETURNING id`,
        [user.id, ledgerId],
      )
    ).rows[0]!;
    const fresh = (
      await admin.query<{ id: string }>(
        `INSERT INTO reminder_schedules (id, user_id, days_of_week, time_of_day, timezone)
       VALUES (gen_random_uuid(), $1, '{1}', '08:00', 'Asia/Makassar') RETURNING id`,
        [user.id],
      )
    ).rows[0]!;

    const jobs = await worker.tickReminders();
    expect(jobs.map((j) => j.schedule_id)).toContain(id);
    await waitFor(async () => sent.some((n) => n.to === user.email));
    const mails = () => sent.filter((n) => n.to === user.email);
    expect(mails()).toHaveLength(1);
    expect(mails()[0]!.text).toContain('Uji worker');

    const rows = (
      await admin.query<{ id: string; next_run_at: Date | null }>(
        'SELECT id, next_run_at FROM reminder_schedules WHERE user_id = $1',
        [user.id],
      )
    ).rows;
    for (const r of rows) expect(r.next_run_at!.getTime()).toBeGreaterThan(Date.now()); // both scheduled in the future
    expect(rows.map((r) => r.id).sort()).toEqual([id, fresh.id].sort());

    // Nothing due now; and a redelivered job is a no-op.
    expect((await worker.tickReminders()).map((j) => j.schedule_id)).not.toContain(id);
    const job = jobs.find((j) => j.schedule_id === id)!;
    const messageId = `reminder:${job.schedule_id}:${job.scheduled_for}`;
    await publishJson(
      worker.channel,
      worker.topology.exchange,
      worker.topology.reminders,
      job,
      messageId,
    );
    await waitFor(async () => outcomes(messageId).includes('duplicate'));
    expect(mails()).toHaveLength(1);
    expect(
      (await admin.query('SELECT 1 FROM reminder_deliveries WHERE schedule_id = $1', [id]))
        .rowCount,
    ).toBe(1);
  });
});
