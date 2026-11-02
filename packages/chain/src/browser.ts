// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// Browser-safe entry point: no Node built-ins. Hashing and signature verification stay in the main entry.
export { canonicalize, CanonicalizationError } from './jcs.js';
export type { WitnessAlg, WitnessCosignPayload, WitnessMessage } from './types.js';
export {
  buildWitnessMessage,
  WITNESS_ALGS,
  WITNESS_KEY_BYTES,
  WITNESS_PURPOSE,
  WITNESS_SIGNATURE_BYTES,
} from './witness-message.js';
