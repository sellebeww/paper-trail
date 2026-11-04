// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { verifyChain } from '@paper-trail/chain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrls } from '../../test/global-setup.js';
import { createDb, type Db } from '../db.js';
import { appendEntry, getChain, LedgerNotFoundError } from './ledger.js';

let db: Db;
let ownerId: string;

const note = (text: string) => ({
  type: 'note' as const,
  authorRef: `owner:${ownerId}`,
  payload: { text },
});

const createLedger = async () =>
  (await db.ledger.create({ data: { ownerId, title: 'Sengketa lembur', category: 'kerja' } })).id;

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms),
    ),
  ]);

beforeAll(async () => {
  db = createDb(testDatabaseUrls().test);
  ownerId = (
    await db.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'x' } })
  ).id;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('appendEntry', () => {
  it('builds a valid chain from sequential appends and moves the ledger head', async () => {
    const ledgerId = await createLedger();
    for (let i = 0; i < 5; i++) await appendEntry(db, ledgerId, note(`catatan ${i} 😡 ñ`));

    const chain = await getChain(db, ledgerId);
    expect(chain.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    // Read back from Postgres (jsonb, timestamptz) and verified with the same rules as an export.
    expect(await verifyChain(chain)).toMatchObject({ ok: true, code: 'CHAIN_OK', length: 5 });

    const ledger = await db.ledger.findUniqueOrThrow({ where: { id: ledgerId } });
    expect(ledger.headSeq).toBe(4);
    expect(ledger.headHash).toBe(chain[4]!.entry_hash);
  });

  it('keeps the chain gap-free and fork-free under 50 parallel appends to one ledger', async () => {
    const ledgerId = await createLedger();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => appendEntry(db, ledgerId, note(`paralel ${i}`))),
    );

    const seqs = results.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i));

    const chain = await getChain(db, ledgerId);
    expect(chain).toHaveLength(50);
    expect(new Set(chain.map((e) => e.prev_hash)).size).toBe(50);
    expect(await verifyChain(chain)).toMatchObject({ ok: true, length: 50 });
  });

  it('never uses a client timestamp and clamps a backwards server clock to the head time', async () => {
    const ledgerId = await createLedger();
    const first = await appendEntry(
      db,
      ledgerId,
      note('a'),
      () => new Date('2026-11-03T10:00:00.000Z'),
    );
    const second = await appendEntry(
      db,
      ledgerId,
      note('b'),
      () => new Date('2026-11-03T09:59:59.000Z'),
    );
    expect(second.created_at).toBe(first.created_at);
    expect((await verifyChain(await getChain(db, ledgerId))).ok).toBe(true);
  });

  it('rejects an unknown ledger', async () => {
    await expect(appendEntry(db, randomUUID(), note('x'))).rejects.toBeInstanceOf(
      LedgerNotFoundError,
    );
  });

  it('does not block appends to a different ledger while one ledger is locked', async () => {
    const ledgerA = await createLedger();
    const ledgerB = await createLedger();

    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let markLocked!: () => void;
    const locked = new Promise<void>((r) => (markLocked = r));

    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM ledgers WHERE id = ${ledgerA}::uuid FOR UPDATE`;
        markLocked();
        await released;
      },
      { timeout: 20_000 },
    );
    await locked;

    let aDone = false;
    const appendA = appendEntry(db, ledgerA, note('menunggu')).then((e) => {
      aDone = true;
      return e;
    });

    const b = await withTimeout(
      appendEntry(db, ledgerB, note('jalan terus')),
      3_000,
      'append to ledger B',
    );
    expect(b.seq).toBe(0);
    expect(aDone).toBe(false);

    release();
    await holder;
    expect((await appendA).seq).toBe(0);
  });
});

describe('database guards (direct SQL, bypassing the application)', () => {
  let ledgerId: string;

  beforeAll(async () => {
    ledgerId = await createLedger();
    for (let i = 0; i < 3; i++) await appendEntry(db, ledgerId, note(`asli ${i}`));
  });

  it('rejects UPDATE on entries', async () => {
    await expect(
      db.$executeRaw`UPDATE entries SET payload = '{"text":"diubah"}'::jsonb WHERE ledger_id = ${ledgerId}::uuid AND seq = 1`,
    ).rejects.toThrow(
      /UPDATE on "entries" is not allowed: only erasing the payload of an entry is/,
    );
  });

  it('rejects DELETE on entries', async () => {
    await expect(
      db.$executeRaw`DELETE FROM entries WHERE ledger_id = ${ledgerId}::uuid AND seq = 2`,
    ).rejects.toThrow(/DELETE on "entries" is not allowed/);
  });

  it('rejects TRUNCATE on entries', async () => {
    await expect(db.$executeRawUnsafe('TRUNCATE entries CASCADE')).rejects.toThrow(
      /TRUNCATE on "entries" is not allowed/,
    );
  });

  const rawInsert = (seq: number, prevHash: string, entryHash = 'b'.repeat(64)) => db.$executeRaw`
    INSERT INTO entries (id, ledger_id, seq, type, created_at, author_ref, payload_hash, payload, prev_hash, entry_hash)
    VALUES (${randomUUID()}::uuid, ${ledgerId}::uuid, ${seq}, 'note', now(), ${`owner:${ownerId}`},
            ${'a'.repeat(64)}, '{"text":"palsu"}'::jsonb, ${prevHash}, ${entryHash})`;
  const hashAt = async (seq: number) => (await getChain(db, ledgerId))[seq]!.entry_hash;

  it('rejects an insert that does not extend the chain', async () => {
    await expect(rawInsert(3, 'c'.repeat(64))).rejects.toThrow(/prev_hash of seq 3 does not match/);
    await expect(rawInsert(5, 'c'.repeat(64))).rejects.toThrow(/has no predecessor/);
  });

  it('rejects a second entry at an existing seq (fork) via UNIQUE(ledger_id, seq)', async () => {
    // Correct predecessor, so the link trigger passes and the unique index is what stops the fork.
    await expect(rawInsert(1, await hashAt(0))).rejects.toThrow(
      /ledger_id.*seq|Unique constraint/i,
    );
  });

  it('rejects malformed hashes via CHECK constraints', async () => {
    await expect(rawInsert(3, await hashAt(2), 'G'.repeat(64))).rejects.toThrow(
      /entries_entry_hash_hex/,
    );
  });

  it('rejects moving the ledger head backwards', async () => {
    await expect(
      db.$executeRaw`UPDATE ledgers SET head_seq = 0, head_hash = (SELECT entry_hash FROM entries WHERE ledger_id = ${ledgerId}::uuid AND seq = 0) WHERE id = ${ledgerId}::uuid`,
    ).rejects.toThrow(/head can only advance by one/);
  });

  it('keeps an anchored head immutable', async () => {
    const head = (await getChain(db, ledgerId))[2]!;
    const anchor = await db.anchor.create({
      data: {
        ledgerId,
        anchoredHeadSeq: head.seq,
        anchoredHeadHash: head.entry_hash,
        anchorDigest: 'd'.repeat(64),
        tsaUrl: 'https://tsa.invalid/',
      },
    });
    await expect(
      db.$executeRaw`UPDATE anchors SET anchored_head_hash = ${'e'.repeat(64)} WHERE id = ${anchor.id}::uuid`,
    ).rejects.toThrow(/anchored head of anchor .* cannot change/);
    await expect(db.$executeRaw`DELETE FROM anchors WHERE id = ${anchor.id}::uuid`).rejects.toThrow(
      /DELETE on "anchors" is not allowed/,
    );
  });

  it('chain still verifies after all rejected tampering', async () => {
    expect(await verifyChain(await getChain(db, ledgerId))).toMatchObject({ ok: true, length: 3 });
  });
});
