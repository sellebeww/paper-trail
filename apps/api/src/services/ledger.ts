// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// The only code path that writes entries. ESLint forbids Prisma entry writes anywhere else, and the
// database rejects any insert that does not extend the chain (see migrations/*_append_only_guards).
import {
  buildEntry,
  type Entry as ChainEntry,
  type EntryType,
  type PayloadObject,
} from '@paper-trail/chain';
import type { Db } from '../db.js';
import type { Entry as EntryRow, Prisma } from '../generated/prisma/client.js';

export class LedgerNotFoundError extends Error {
  override name = 'LedgerNotFoundError';
}

export interface AttachmentInput {
  storageKey: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}

export interface AppendInput {
  type: EntryType;
  authorRef: string;
  payload: PayloadObject;
  /** Stored in the same transaction as the entry; its sha256 must equal payload.content_sha256. */
  attachment?: AttachmentInput;
}

export type StoredEntry = ChainEntry & { id: string };

export type Tx = Prisma.TransactionClient;

/**
 * Extra work inside the append transaction (for example consuming a witness invite). Throwing from
 * a hook rolls back everything, including the entry. beforeInsert runs after the ledger lock is held.
 */
export interface AppendHooks {
  beforeInsert?: (tx: Tx) => Promise<void>;
  afterInsert?: (tx: Tx, entry: StoredEntry) => Promise<void>;
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
  // An erased entry has no payload (undisclosed, SPEC §6): its hashes still verify, a stored {} would not.
  ...(row.erasedAt ? {} : { payload: row.payload as PayloadObject }),
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
  hooks: AppendHooks = {},
): Promise<StoredEntry> =>
  db.$transaction(
    async (tx) => {
      if (input.attachment && input.attachment.sha256 !== input.payload['content_sha256']) {
        throw new Error('attachment sha256 does not match payload.content_sha256');
      }
      const locked = await tx.$queryRaw<{ head_seq: number | null }[]>`
        SELECT head_seq FROM ledgers WHERE id = ${ledgerId}::uuid FOR UPDATE`;
      const ledger = locked[0];
      if (!ledger) throw new LedgerNotFoundError(`Ledger ${ledgerId} not found`);
      await hooks.beforeInsert?.(tx);

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

      const row = await tx.entry.create({
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
      if (input.attachment) {
        await tx.attachment.create({ data: { entryId: row.id, ...input.attachment } });
      }
      await tx.ledger.update({
        where: { id: ledgerId },
        data: { headSeq: entry.seq, headHash: entry.entry_hash },
      });
      const stored = { ...entry, id: row.id };
      await hooks.afterInsert?.(tx, stored);
      return stored;
    },
    // Appends to a busy ledger queue on the row lock; allow time for that instead of failing fast.
    { maxWait: 10_000, timeout: 10_000 },
  );

/** Full chain of a ledger in seq order, payloads included. */
export const getChain = async (db: Db, ledgerId: string): Promise<ChainEntry[]> =>
  (await db.entry.findMany({ where: { ledgerId }, orderBy: { seq: 'asc' } })).map(toChainEntry);
