// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// No Node imports: shared by the server verifier and the witness's browser (via ./browser.ts).
import type { WitnessCosignPayload, WitnessMessage } from './types.js';

export const WITNESS_PURPOSE = 'papertrail.witness.cosign.v1';
export const WITNESS_ALGS = ['Ed25519', 'ES256'] as const;

/** Raw key and signature lengths in bytes (SPEC §4.1). */
export const WITNESS_KEY_BYTES = { Ed25519: 32, ES256: 65 } as const;
export const WITNESS_SIGNATURE_BYTES = 64;

/**
 * The object the witness signs (SPEC §4.1), rebuilt field by field from a cosign payload so
 * nothing outside the signed set can ride along. The signature covers JCS(message) as UTF-8.
 */
export const buildWitnessMessage = (
  ledgerId: string,
  p: Omit<WitnessCosignPayload, 'signature'>,
): WitnessMessage => ({
  v: 1,
  purpose: WITNESS_PURPOSE,
  ledger_id: ledgerId,
  invite_id: p.invite_id,
  target_seq: p.target_seq,
  target_entry_hash: p.target_entry_hash,
  statement: p.statement,
  witness_name: p.witness_name,
  witness_pub: p.witness_pub,
  alg: p.alg,
  signed_client_time: p.signed_client_time,
});
