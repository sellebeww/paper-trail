// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { HEX64, isTimestamp } from './entry.js';
import { sha256Hex } from './hash.js';
import { canonicalize } from './jcs.js';
import type { WitnessAlg, WitnessCosignPayload } from './types.js';
import {
  buildWitnessMessage,
  WITNESS_ALGS,
  WITNESS_KEY_BYTES,
  WITNESS_SIGNATURE_BYTES,
} from './witness-message.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
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
const decodeB64url = (value: unknown, length: number): Buffer | null => {
  if (typeof value !== 'string' || !B64URL.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === length && bytes.toString('base64url') === value ? bytes : null;
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

const importKey = (alg: WitnessAlg, raw: Buffer): KeyObject =>
  alg === 'Ed25519'
    ? createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
        format: 'jwk',
      })
    : createPublicKey({
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: raw.subarray(1, 33).toString('base64url'),
          y: raw.subarray(33, 65).toString('base64url'),
        },
        format: 'jwk',
      });

export type WitnessCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verifies a witness_cosign payload's signature over JCS(buildWitnessMessage(...)) (SPEC §4).
 * Input is untrusted: shape, encodings and key validity are checked before any crypto.
 */
export const verifyWitnessSignature = (ledgerId: string, payload: unknown): WitnessCheck => {
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

  const message = Buffer.from(
    canonicalize(buildWitnessMessage(ledgerId, p as unknown as WitnessCosignPayload)),
    'utf8',
  );
  try {
    const key = importKey(alg, pub);
    const valid =
      alg === 'Ed25519'
        ? verify(null, message, key, signature)
        : verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, signature);
    return valid ? { ok: true } : { ok: false, reason: 'signature does not verify' };
  } catch {
    return { ok: false, reason: 'witness_pub is not a valid public key' };
  }
};

/** `witness:` + SHA-256 of the raw public key bytes (SPEC §4.2). */
export const witnessAuthorRef = (witnessPub: string): string =>
  `witness:${sha256Hex(Buffer.from(witnessPub, 'base64url'))}`;
