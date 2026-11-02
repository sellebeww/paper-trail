// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { createHash } from 'node:crypto';

/** SHA-256 as lowercase hex. Strings are hashed as UTF-8. */
export const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
