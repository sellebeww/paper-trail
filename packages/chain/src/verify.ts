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
import { verifyWitnessSignature, witnessAuthorRef } from './witness.js';

export type ChainErrorCode =
  | 'PACK_MALFORMED'
  | 'GENESIS_INVALID'
  | 'SEQ_GAP'
  | 'LEDGER_MISMATCH'
  | 'BROKEN_AT_SEQ'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'TIME_REGRESSION'
  | 'WITNESS_SIG_INVALID'
  | 'WITNESS_TARGET_MISMATCH';

export type ChainVerification =
  | { ok: true; code: 'CHAIN_OK'; length: number; details: string; notes: string[] }
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

export interface ChainOptions {
  /**
   * Verify a contiguous segment instead of a whole ledger (SPEC §6.2). The first entry must have
   * `seq = fromSeq` and `prev_hash = firstPrevHash`. For `fromSeq = 0` the genesis rules apply and
   * `firstPrevHash` must be 64 zeros.
   */
  segment?: { fromSeq: number; firstPrevHash: string };
}

/**
 * Verifies a chain, or a segment of one (SPEC §8 steps 2–3). Stops at the first error because every
 * later hash depends on it. `brokenAtSeq` is the entry's seq where it failed.
 * Input is treated as untrusted: shape is checked before anything is hashed.
 */
export const verifyChain = (
  entries: readonly Entry[],
  options: ChainOptions = {},
): ChainVerification => {
  const fromSeq = options.segment?.fromSeq ?? 0;
  const firstPrevHash = options.segment?.firstPrevHash ?? GENESIS_PREV_HASH;
  if (entries.length === 0)
    return { ok: true, code: 'CHAIN_OK', length: 0, details: 'empty chain', notes: [] };

  const notes: string[] = [];
  let prev: Entry | null = null;
  for (const [i, entry] of entries.entries()) {
    const seq = fromSeq + i;
    if (entry === null || typeof entry !== 'object')
      return fail('PACK_MALFORMED', seq, 'entry is not an object');
    const problem = shapeProblem(entry as unknown as Record<string, unknown>);
    if (problem) return fail('PACK_MALFORMED', seq, problem);

    if (entry.seq !== seq) {
      return fail(
        i === 0 && fromSeq === 0 ? 'GENESIS_INVALID' : 'SEQ_GAP',
        seq,
        `expected seq ${seq}, found ${entry.seq}`,
      );
    }
    if (i === 0) {
      if (fromSeq === 0) {
        if (entry.prev_hash !== GENESIS_PREV_HASH)
          return fail('GENESIS_INVALID', 0, 'genesis prev_hash is not all zeros');
        if (entry.type === 'witness_cosign')
          return fail('GENESIS_INVALID', 0, 'genesis entry cannot be a witness_cosign');
      } else if (entry.prev_hash !== firstPrevHash) {
        return fail('BROKEN_AT_SEQ', seq, 'prev_hash does not match the segment’s first_prev_hash');
      }
    }

    if (prev && entry.ledger_id !== prev.ledger_id) {
      return fail('LEDGER_MISMATCH', seq, `entry belongs to ledger ${entry.ledger_id}`);
    }
    if (prev && entry.prev_hash !== prev.entry_hash) {
      return fail('BROKEN_AT_SEQ', seq, 'prev_hash does not match the previous entry_hash');
    }
    if (computeEntryHash(entry) !== entry.entry_hash) {
      return fail('BROKEN_AT_SEQ', seq, 'entry_hash does not match the recomputed hash');
    }
    if (entry.payload !== undefined) {
      let payloadHash: string;
      try {
        payloadHash = computePayloadHash(entry.payload);
      } catch (err) {
        return fail('PACK_MALFORMED', seq, `payload cannot be hashed: ${(err as Error).message}`);
      }
      if (payloadHash !== entry.payload_hash) {
        return fail('PAYLOAD_HASH_MISMATCH', seq, 'payload does not match payload_hash');
      }
    }
    if (prev && entry.created_at < prev.created_at) {
      return fail('TIME_REGRESSION', seq, 'created_at is earlier than the previous entry');
    }
    // SPEC §8 step 6. An undisclosed cosign payload cannot be checked; the chain still holds.
    if (entry.type === 'witness_cosign' && entry.payload !== undefined) {
      const p = entry.payload as Record<string, unknown>;
      const check = verifyWitnessSignature(entry.ledger_id, p);
      if (!check.ok) return fail('WITNESS_SIG_INVALID', seq, check.reason);
      if (entry.author_ref !== witnessAuthorRef(p['witness_pub'] as string)) {
        return fail('WITNESS_SIG_INVALID', seq, 'author_ref does not match the witness key');
      }
      const target = p['target_seq'] as number;
      if (target >= seq) {
        return fail(
          'WITNESS_TARGET_MISMATCH',
          seq,
          `cosign targets entry ${target}, not an earlier entry`,
        );
      }
      if (target < fromSeq) {
        // The signature is valid, but the entry it vouches for is outside this segment.
        notes.push(
          `cosign ${seq}: target entry ${target} is outside the exported range and was not checked`,
        );
      } else if (entries[target - fromSeq]?.entry_hash !== p['target_entry_hash']) {
        return fail('WITNESS_TARGET_MISMATCH', seq, `cosign does not match entry ${target}`);
      }
    }
    prev = entry;
  }
  return {
    ok: true,
    code: 'CHAIN_OK',
    length: entries.length,
    details: `${entries.length} entries intact`,
    notes,
  };
};
