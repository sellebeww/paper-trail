// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Small browser entry for the witness page (signing only). The main entry is browser-safe too and is what /verify uses.
export { canonicalize, CanonicalizationError } from './jcs.js';
export type { WitnessAlg, WitnessCosignPayload, WitnessMessage } from './types.js';
export {
  buildWitnessMessage,
  WITNESS_ALGS,
  WITNESS_KEY_BYTES,
  WITNESS_PURPOSE,
  WITNESS_SIGNATURE_BYTES,
} from './witness-message.js';
