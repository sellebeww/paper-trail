// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { canonicalEnvelope, HEX64, type EntryType } from '@paper-trail/chain';
import { z } from 'zod';
import type { Pool, Queryable } from './db.js';
import { PermanentError } from './messaging.js';
import { TsaError, type TimestampResult } from './tsa.js';

export const anchorJobSchema = z
  .object({
    ledger_id: z.uuid(),
    head_seq: z.number().int().min(0),
    head_hash: z.string().regex(HEX64),
  })
  .strict();
export type AnchorJob = z.infer<typeof anchorJobSchema>;

export type Timestamper = (data: Uint8Array) => Promise<TimestampResult & { tsaUrl: string }>;

// Any constant works; it only has to be the same in every worker process.
const SCHEDULER_LOCK = 724_331_001;
/** A pending anchor untouched for this long is treated as stuck and queued again. */
const STALE_PENDING = '1 hour';

/**
 * Ledgers whose current head has no successful anchor and is not already being anchored.
 * A ledger whose head is anchored (status ok) is never queued again until it gets a new entry.
 */
export const findLedgersToAnchor = async (db: Queryable, limit = 1000): Promise<AnchorJob[]> =>
  (
    await db.query<AnchorJob>(
      `SELECT l.id AS ledger_id, l.head_seq, l.head_hash
         FROM ledgers l
        WHERE l.head_seq IS NOT NULL
          AND NOT EXISTS (
                SELECT 1 FROM anchors a
                 WHERE a.ledger_id = l.id AND a.anchored_head_seq = l.head_seq
                   AND (a.status = 'ok' OR (a.status = 'pending' AND a.updated_at > now() - $2::interval)))
        ORDER BY l.id
        LIMIT $1`,
      [limit, STALE_PENDING],
    )
  ).rows;

/** Queues anchor jobs. A session advisory lock keeps two workers from scanning at the same time. */
export const scheduleAnchors = async (db: Pool, publish: (job: AnchorJob) => Promise<void>) => {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [SCHEDULER_LOCK],
    );
    if (!rows[0]?.locked) return [];
    try {
      const jobs = await findLedgersToAnchor(client);
      for (const job of jobs) await publish(job);
      return jobs;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK]);
    }
  } finally {
    client.release();
  }
};

interface HeadRow {
  id: string;
  status: 'pending' | 'ok' | 'failed';
  anchored_head_hash: string;
  ledger_id: string;
  seq: number;
  type: EntryType;
  created_at: Date;
  author_ref: string;
  payload_hash: string;
  prev_hash: string;
  entry_hash: string;
}

/**
 * Anchors one ledger head (SPEC §5). Idempotent: the anchor row is unique per (ledger, head_seq), an
 * `ok` row short-circuits before any TSA call, and the final write only succeeds while the row is not
 * yet `ok`, so a duplicate delivery can never replace or contradict a stored token.
 */
export const processAnchor = async (db: Pool, timestamp: Timestamper, job: AnchorJob) => {
  try {
    await db.query(
      `INSERT INTO anchors (id, ledger_id, anchored_head_seq, anchored_head_hash, anchor_digest, tsa_url, status, attempts, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $3, '', 'pending', 0, now())
       ON CONFLICT (ledger_id, anchored_head_seq) DO NOTHING`,
      [job.ledger_id, job.head_seq, job.head_hash],
    );
  } catch (err) {
    // 23503: the (ledger, seq, hash) does not exist as an entry. Retrying cannot fix that.
    if ((err as { code?: string }).code === '23503')
      throw new PermanentError('job points at an entry that does not exist');
    throw err;
  }

  const { rows } = await db.query<HeadRow>(
    `SELECT a.id, a.status, a.anchored_head_hash,
            e.ledger_id, e.seq, e.type, e.created_at, e.author_ref, e.payload_hash, e.prev_hash, e.entry_hash
       FROM anchors a
       JOIN entries e ON e.ledger_id = a.ledger_id AND e.seq = a.anchored_head_seq
      WHERE a.ledger_id = $1 AND a.anchored_head_seq = $2`,
    [job.ledger_id, job.head_seq],
  );
  const row = rows[0];
  if (!row) throw new Error('anchor row vanished');
  if (row.anchored_head_hash !== job.head_hash)
    throw new PermanentError('job head_hash differs from the stored head');
  if (row.status === 'ok') return 'already-anchored';

  await db.query(
    `UPDATE anchors SET attempts = attempts + 1, status = 'pending', updated_at = now() WHERE id = $1 AND status <> 'ok'`,
    [row.id],
  );

  // What is timestamped is the head entry's canonical envelope; its SHA-256 is head_hash (SPEC §5.1).
  const envelope = Buffer.from(
    canonicalEnvelope({
      v: 1,
      ledger_id: row.ledger_id,
      seq: row.seq,
      type: row.type,
      created_at: row.created_at.toISOString(),
      author_ref: row.author_ref,
      payload_hash: row.payload_hash,
      prev_hash: row.prev_hash,
    }),
    'utf8',
  );

  let result: Awaited<ReturnType<Timestamper>>;
  try {
    result = await timestamp(envelope);
    // genTime is often whole seconds; created_at must not be later than genTime + precision + accuracy.
    if (row.created_at.getTime() > result.genTime.getTime() + 1000 + result.accuracyMs) {
      throw new TsaError(
        `TSA genTime ${result.genTime.toISOString()} is earlier than the entry's created_at ${row.created_at.toISOString()}: server clock ahead of the TSA`,
        true,
      );
    }
  } catch (err) {
    const message = (err as Error).message;
    await db.query(
      `UPDATE anchors SET last_error = $2, updated_at = now() WHERE id = $1 AND status <> 'ok'`,
      [row.id, message.slice(0, 1000)],
    );
    if (err instanceof TsaError && !err.retryable) throw new PermanentError(message);
    throw err;
  }

  const done = await db.query(
    `UPDATE anchors SET status = 'ok', tst_token = $2, tst_gen_time = $3, tsa_url = $4, last_error = NULL, updated_at = now()
      WHERE id = $1 AND status <> 'ok'`,
    [row.id, result.token, result.genTime, result.tsaUrl],
  );
  return done.rowCount === 1 ? 'anchored' : 'already-anchored';
};

/** After the job is dead-lettered: make the failure visible on the ledger. */
export const markAnchorFailed = async (db: Pool, job: AnchorJob, err: Error) => {
  await db.query(
    `UPDATE anchors SET status = 'failed', last_error = $3, updated_at = now()
      WHERE ledger_id = $1 AND anchored_head_seq = $2 AND status <> 'ok'`,
    [job.ledger_id, job.head_seq, err.message.slice(0, 1000)],
  );
};
