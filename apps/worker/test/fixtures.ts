// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Shared integration-test fixtures: ledgers with valid chains written as the owner role, a throwaway
// least-privilege worker role, and a polling helper.
import { randomBytes, randomUUID } from 'node:crypto';
import { buildEntry, type Entry } from '@paper-trail/chain';
import pg from 'pg';

export const waitFor = async <T>(
  probe: () => Promise<T | undefined | false>,
  ms = 10_000,
): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** A fresh login role in pt_worker and a pool that connects as it. `drop()` ends the pool and the role. */
export const workerRole = async (admin: pg.Pool, testUrl: string) => {
  const role = `pt_worker_it_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(16).toString('hex');
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' IN ROLE pt_worker`); // hex only: safe to inline
  const url = new URL(testUrl);
  url.username = role;
  url.password = password;
  const pool = new pg.Pool({ connectionString: url.toString() });
  return {
    url: url.toString(),
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP ROLE ${role}`);
    },
  };
};

export const ledgerFixtures = (admin: pg.Pool) => {
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

  return { chains, append, newUser, newLedger, anchor };
};
