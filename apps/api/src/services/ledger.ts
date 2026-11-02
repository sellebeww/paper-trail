// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// The only code path that writes entries. ESLint forbids Prisma entry writes anywhere else, and the
// database rejects any insert that does not extend the chain (see migrations/*_append_only_guards).
import {
  buildEntry,
  type Entry as ChainEntry,
  type EntryType,
  type PayloadObject,
} from '@paper-trail/chain';
import type { Db } from '../db.js';
import type { Entry as EntryRow } from '../generated/prisma/client.js';

export class LedgerNotFoundError extends Error {
  override name = 'LedgerNotFoundError';
}

export interface AppendInput {
  type: EntryType;
  authorRef: string;
  payload: PayloadObject;
}

export const toChainEntry = (row: EntryRow): ChainEntry => ({
  v: 1,
  ledger_id: row.ledgerId,
  seq: row.seq,
  type: row.type,
  created_at: row.createdAt.toISOString(),
  author_ref: row.authorRef,
  payload_hash: row.payloadHash,
  prev_hash: row.prevHash,
  entry_hash: row.entryHash,
  payload: row.payload as PayloadObject,
});

/**
 * Appends one entry in a single transaction:
 * lock the ledger row → read the head → build the entry with packages/chain → insert → move the head.
 * The row lock serializes appends to the same ledger only; other ledgers proceed in parallel.
 */
export const appendEntry = (
  db: Db,
  ledgerId: string,
  input: AppendInput,
  now: () => Date = () => new Date(),
): Promise<ChainEntry> =>
  db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ head_seq: number | null }[]>`
        SELECT head_seq FROM ledgers WHERE id = ${ledgerId}::uuid FOR UPDATE`;
      const ledger = locked[0];
      if (!ledger) throw new LedgerNotFoundError(`Ledger ${ledgerId} not found`);

      const head =
        ledger.head_seq === null
          ? null
          : await tx.entry.findUniqueOrThrow({
              where: { ledgerId_seq: { ledgerId, seq: ledger.head_seq } },
            });

      // Server clock only. Clamped to the head's time so a small clock step back cannot break ordering.
      const createdAt = new Date(Math.max(now().getTime(), head?.createdAt.getTime() ?? 0));
      const entry = buildEntry(
        {
          ledger_id: ledgerId,
          type: input.type,
          created_at: createdAt.toISOString(),
          author_ref: input.authorRef,
          payload: input.payload,
        },
        head && toChainEntry(head),
      );

      await tx.entry.create({
        data: {
          ledgerId,
          seq: entry.seq,
          type: entry.type,
          createdAt,
          authorRef: entry.author_ref,
          payloadHash: entry.payload_hash,
          payload: input.payload,
          prevHash: entry.prev_hash,
          entryHash: entry.entry_hash,
        },
      });
      await tx.ledger.update({
        where: { id: ledgerId },
        data: { headSeq: entry.seq, headHash: entry.entry_hash },
      });
      return entry;
    },
    // Appends to a busy ledger queue on the row lock; allow time for that instead of failing fast.
    { maxWait: 10_000, timeout: 10_000 },
  );

/** Full chain of a ledger in seq order, payloads included. */
export const getChain = async (db: Db, ledgerId: string): Promise<ChainEntry[]> =>
  (await db.entry.findMany({ where: { ledgerId }, orderBy: { seq: 'asc' } })).map(toChainEntry);
