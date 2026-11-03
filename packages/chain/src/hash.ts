// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// No Node built-ins: the same code verifies packs on the server, in the CLI and in the browser (/verify).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** SHA-256 as lowercase hex. Strings are hashed as UTF-8. */
export const sha256Hex = (data: string | Uint8Array): string =>
  bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));

export const bytesToB64url = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Strict base64url without padding (it must re-encode to the same string), or null. */
export const b64urlToBytes = (value: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
    c.charCodeAt(0),
  );
  return bytesToB64url(bytes) === value ? bytes : null;
};
