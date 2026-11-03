// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { HEX64, isTimestamp } from './entry.js';
import { b64urlToBytes, sha256Hex } from './hash.js';
import { canonicalize } from './jcs.js';
import type { WitnessAlg, WitnessCosignPayload } from './types.js';
import {
  buildWitnessMessage,
  WITNESS_ALGS,
  WITNESS_KEY_BYTES,
  WITNESS_SIGNATURE_BYTES,
} from './witness-message.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAYLOAD_KEYS = [
  'alg',
  'invite_id',
  'signature',
  'signed_client_time',
  'statement',
  'target_entry_hash',
  'target_seq',
  'witness_name',
  'witness_pub',
].join(',');

/** Strict base64url without padding, of exactly `length` bytes. */
const decodeB64url = (value: unknown, length: number): Uint8Array<ArrayBuffer> | null => {
  const bytes = typeof value === 'string' ? b64urlToBytes(value) : null;
  return bytes?.length === length ? bytes : null;
};

const isWitnessAlg = (value: unknown): value is WitnessAlg =>
  (WITNESS_ALGS as readonly unknown[]).includes(value);

/** Well-formed, NFC, no control characters, 1–80 code points after trimming. */
export const isValidWitnessName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.isWellFormed() &&
  value === value.normalize('NFC') &&
  value === value.trim() &&
  !/\p{Cc}/u.test(value) &&
  Array.from(value).length >= 1 &&
  Array.from(value).length <= 80;

const shapeProblem = (p: Record<string, unknown>): string | null => {
  // Every payload field must be covered by the signature, so unknown fields are rejected.
  if (Object.keys(p).sort().join(',') !== PAYLOAD_KEYS)
    return 'payload fields do not match SPEC §4.2';
  if (typeof p['invite_id'] !== 'string' || !UUID.test(p['invite_id']))
    return 'invite_id must be a lowercase UUID';
  if (!Number.isSafeInteger(p['target_seq']) || (p['target_seq'] as number) < 0)
    return 'target_seq must be a non-negative integer';
  if (typeof p['target_entry_hash'] !== 'string' || !HEX64.test(p['target_entry_hash']))
    return 'target_entry_hash must be 64 lowercase hex';
  if (p['statement'] !== 'confirm') return 'statement must be "confirm"';
  if (!isValidWitnessName(p['witness_name']))
    return 'witness_name must be 1–80 characters, NFC, without control characters';
  if (!isWitnessAlg(p['alg'])) return 'alg must be Ed25519 or ES256';
  if (!isTimestamp(p['signed_client_time'])) return 'signed_client_time is not a valid timestamp';
  return null;
};

// WebCrypto, not node:crypto, so the browser verifier runs this exact code. Signatures are raw (IEEE P1363).
const IMPORT = {
  Ed25519: { name: 'Ed25519' },
  ES256: { name: 'ECDSA', namedCurve: 'P-256' },
} as const;
const VERIFY = { Ed25519: { name: 'Ed25519' }, ES256: { name: 'ECDSA', hash: 'SHA-256' } } as const;

export type WitnessCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verifies a witness_cosign payload's signature over JCS(buildWitnessMessage(...)) (SPEC §4).
 * Input is untrusted: shape, encodings and key validity are checked before any crypto.
 */
export const verifyWitnessSignature = async (
  ledgerId: string,
  payload: unknown,
): Promise<WitnessCheck> => {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload must be an object' };
  }
  const p = payload as Record<string, unknown>;
  const problem = shapeProblem(p);
  if (problem) return { ok: false, reason: problem };

  const alg = p['alg'] as WitnessAlg;
  const pub = decodeB64url(p['witness_pub'], WITNESS_KEY_BYTES[alg]);
  if (!pub || (alg === 'ES256' && pub[0] !== 0x04))
    return { ok: false, reason: 'witness_pub is not a raw public key for alg' };
  const signature = decodeB64url(p['signature'], WITNESS_SIGNATURE_BYTES);
  if (!signature) return { ok: false, reason: 'signature must be 64 bytes, base64url' };

  const message = new TextEncoder().encode(
    canonicalize(buildWitnessMessage(ledgerId, p as unknown as WitnessCosignPayload)),
  );
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', pub, IMPORT[alg], false, ['verify']);
  } catch {
    return { ok: false, reason: 'witness_pub is not a valid public key' };
  }
  const valid = await crypto.subtle.verify(VERIFY[alg], key, signature, message).catch(() => false);
  return valid ? { ok: true } : { ok: false, reason: 'signature does not verify' };
};

/** `witness:` + SHA-256 of the raw public key bytes (SPEC §4.2). */
export const witnessAuthorRef = (witnessPub: string): string => {
  const raw = b64urlToBytes(witnessPub);
  if (!raw) throw new Error('witness_pub is not base64url');
  return `witness:${sha256Hex(raw)}`;
};
