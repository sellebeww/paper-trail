// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import {
  computeEntryHash,
  computePayloadHash,
  GENESIS_PREV_HASH,
  HEX64,
  isEntryType,
  isTimestamp,
} from './entry.js';
import type { Entry } from './types.js';

export type ChainErrorCode =
  | 'PACK_MALFORMED'
  | 'GENESIS_INVALID'
  | 'SEQ_GAP'
  | 'LEDGER_MISMATCH'
  | 'BROKEN_AT_SEQ'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'TIME_REGRESSION';

export type ChainVerification =
  | { ok: true; code: 'CHAIN_OK'; length: number; details: string }
  | { ok: false; code: ChainErrorCode; brokenAtSeq: number; details: string };

const fail = (code: ChainErrorCode, brokenAtSeq: number, details: string): ChainVerification => ({
  ok: false,
  code,
  brokenAtSeq,
  details,
});

const shapeProblem = (e: Record<string, unknown>): string | null => {
  if (e['v'] !== 1) return 'v must be 1';
  if (!Number.isSafeInteger(e['seq']) || (e['seq'] as number) < 0)
    return 'seq must be a non-negative integer';
  if (typeof e['ledger_id'] !== 'string') return 'ledger_id must be a string';
  if (!isEntryType(e['type'])) return 'type is unknown';
  if (!isTimestamp(e['created_at'])) return 'created_at is not a valid timestamp';
  if (typeof e['author_ref'] !== 'string') return 'author_ref must be a string';
  for (const field of ['payload_hash', 'prev_hash', 'entry_hash']) {
    if (typeof e[field] !== 'string' || !HEX64.test(e[field] as string)) {
      return `${field} must be 64 lowercase hex characters`;
    }
  }
  const payload = e['payload'];
  if (
    payload !== undefined &&
    (payload === null || typeof payload !== 'object' || Array.isArray(payload))
  ) {
    return 'payload must be an object when present';
  }
  return null;
};

/**
 * Verifies a full chain from seq 0 (SPEC §8 steps 2–3). Stops at the first error because every
 * later hash depends on it. `brokenAtSeq` is the chain position (the expected seq) where it failed.
 * Input is treated as untrusted: shape is checked before anything is hashed.
 */
export const verifyChain = (entries: readonly Entry[]): ChainVerification => {
  if (entries.length === 0)
    return { ok: true, code: 'CHAIN_OK', length: 0, details: 'empty chain' };

  let prev: Entry | null = null;
  for (const [i, entry] of entries.entries()) {
    if (entry === null || typeof entry !== 'object')
      return fail('PACK_MALFORMED', i, 'entry is not an object');
    const problem = shapeProblem(entry as unknown as Record<string, unknown>);
    if (problem) return fail('PACK_MALFORMED', i, problem);

    if (i === 0) {
      if (entry.seq !== 0)
        return fail('GENESIS_INVALID', 0, `first entry has seq ${entry.seq}, expected 0`);
      if (entry.prev_hash !== GENESIS_PREV_HASH)
        return fail('GENESIS_INVALID', 0, 'genesis prev_hash is not all zeros');
      if (entry.type === 'witness_cosign')
        return fail('GENESIS_INVALID', 0, 'genesis entry cannot be a witness_cosign');
    } else if (entry.seq !== i) {
      return fail('SEQ_GAP', i, `expected seq ${i}, found ${entry.seq}`);
    }

    if (prev && entry.ledger_id !== prev.ledger_id) {
      return fail('LEDGER_MISMATCH', i, `entry belongs to ledger ${entry.ledger_id}`);
    }
    if (prev && entry.prev_hash !== prev.entry_hash) {
      return fail('BROKEN_AT_SEQ', i, 'prev_hash does not match the previous entry_hash');
    }
    if (computeEntryHash(entry) !== entry.entry_hash) {
      return fail('BROKEN_AT_SEQ', i, 'entry_hash does not match the recomputed hash');
    }
    if (entry.payload !== undefined) {
      let payloadHash: string;
      try {
        payloadHash = computePayloadHash(entry.payload);
      } catch (err) {
        return fail('PACK_MALFORMED', i, `payload cannot be hashed: ${(err as Error).message}`);
      }
      if (payloadHash !== entry.payload_hash) {
        return fail('PAYLOAD_HASH_MISMATCH', i, 'payload does not match payload_hash');
      }
    }
    if (prev && entry.created_at < prev.created_at) {
      return fail('TIME_REGRESSION', i, 'created_at is earlier than the previous entry');
    }
    prev = entry;
  }
  return {
    ok: true,
    code: 'CHAIN_OK',
    length: entries.length,
    details: `${entries.length} entries intact`,
  };
};
