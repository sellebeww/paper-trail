// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { sha256Hex } from './hash.js';
import { canonicalize } from './jcs.js';
import {
  ENTRY_TYPES,
  type Entry,
  type EntryEnvelope,
  type EntryType,
  type PayloadObject,
} from './types.js';

export const ENTRY_VERSION = 1;
export const GENESIS_PREV_HASH = '0'.repeat(64);

export const HEX64 = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const AUTHOR_REF = /^(owner|witness):[0-9a-f-]{1,128}$/;

export class ChainError extends Error {
  override name = 'ChainError';
}

export const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  TIMESTAMP.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export const isEntryType = (value: unknown): value is EntryType =>
  (ENTRY_TYPES as readonly unknown[]).includes(value);

const assertPayloadValue = (value: unknown, path: string): void => {
  if (typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new ChainError(`${path}: only safe integers are allowed`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertPayloadValue(item, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertPayloadValue(item, `${path}.${key}`);
    return;
  }
  throw new ChainError(`${path}: ${value === null ? 'null' : typeof value} is not allowed`);
};

/** SHA-256 of the JCS form of a payload. Rejects null and non-integer numbers (SPEC §1, §3). */
export const computePayloadHash = (payload: PayloadObject): string => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ChainError('payload must be an object');
  }
  assertPayloadValue(payload, 'payload');
  return sha256Hex(canonicalize(payload));
};

/** SHA-256 of the JCS form of exactly the envelope fields (SPEC §2.2); extra fields are ignored. */
/** JCS of exactly the envelope fields (SPEC §2.2). Its SHA-256 is entry_hash; it is also what an anchor timestamps (SPEC §5.1). */
export const canonicalEnvelope = (e: EntryEnvelope): string =>
  canonicalize({
    v: e.v,
    ledger_id: e.ledger_id,
    seq: e.seq,
    type: e.type,
    created_at: e.created_at,
    author_ref: e.author_ref,
    payload_hash: e.payload_hash,
    prev_hash: e.prev_hash,
  });

export const computeEntryHash = (e: EntryEnvelope): string => sha256Hex(canonicalEnvelope(e));

export interface EntryInput {
  ledger_id: string;
  type: EntryType;
  created_at: string;
  author_ref: string;
  payload: PayloadObject;
}

/** Builds the next entry after `prev` (or the genesis entry when `prev` is null). */
export const buildEntry = (input: EntryInput, prev: Entry | null): Entry => {
  if (!UUID.test(input.ledger_id)) throw new ChainError('ledger_id must be a lowercase UUID');
  if (!isEntryType(input.type)) throw new ChainError(`unknown entry type: ${String(input.type)}`);
  if (!isTimestamp(input.created_at))
    throw new ChainError('created_at must be YYYY-MM-DDTHH:mm:ss.sssZ');
  if (!AUTHOR_REF.test(input.author_ref)) throw new ChainError('author_ref is malformed');
  if (prev) {
    if (prev.ledger_id !== input.ledger_id)
      throw new ChainError('prev entry belongs to another ledger');
    if (input.created_at < prev.created_at)
      throw new ChainError('created_at is earlier than prev entry');
  } else if (input.type === 'witness_cosign') {
    throw new ChainError('the genesis entry cannot be a witness_cosign');
  }

  const envelope: EntryEnvelope = {
    v: ENTRY_VERSION,
    ledger_id: input.ledger_id,
    seq: prev ? prev.seq + 1 : 0,
    type: input.type,
    created_at: input.created_at,
    author_ref: input.author_ref,
    payload_hash: computePayloadHash(input.payload),
    prev_hash: prev ? prev.entry_hash : GENESIS_PREV_HASH,
  };
  return { ...envelope, entry_hash: computeEntryHash(envelope), payload: input.payload };
};
