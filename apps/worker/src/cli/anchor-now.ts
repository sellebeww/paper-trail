// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Queue anchor jobs now instead of waiting for the next interval (demos, incident recovery).
//   pnpm --filter @paper-trail/worker anchor:now               every ledger whose head changed
//   pnpm --filter @paper-trail/worker anchor:now <ledger-id>   that ledger's current head
// A running worker processes the jobs; this command only queues them.
import amqp from 'amqplib';
import { z } from 'zod';
import { scheduleAnchors, type AnchorJob } from '../anchor.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { assertTopology, publishJson, topology } from '../messaging.js';

const config = loadConfig();
const ledgerId = process.argv[2] ? z.uuid().parse(process.argv[2]) : undefined;
const pool = createPool(config.WORKER_DATABASE_URL);
const connection = await amqp.connect(config.AMQP_URL);
const ch = await connection.createConfirmChannel();
const t = topology(config.QUEUE_PREFIX);
await assertTopology(ch, t, config.RETRY_DELAYS_MS);
const publish = (job: AnchorJob) =>
  publishJson(ch, t.exchange, t.anchor, job, `anchor:${job.ledger_id}:${job.head_seq}`);

try {
  let jobs: AnchorJob[];
  if (ledgerId) {
    const { rows } = await pool.query<AnchorJob>(
      'SELECT id AS ledger_id, head_seq, head_hash FROM ledgers WHERE id = $1 AND head_seq IS NOT NULL',
      [ledgerId],
    );
    jobs = rows;
    for (const job of jobs) await publish(job);
  } else {
    jobs = await scheduleAnchors(pool, publish);
  }
  console.log(JSON.stringify({ msg: 'anchor jobs queued', count: jobs.length, jobs }));
  if (ledgerId && jobs.length === 0)
    console.log('That ledger does not exist or has no entries yet.');
} finally {
  await ch.close();
  await connection.close();
  await pool.end();
}
