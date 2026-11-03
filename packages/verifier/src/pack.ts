// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import {
  anchorData,
  b64urlToBytes,
  sha256Hex,
  verifyAttachments,
  verifyPack,
  type EvidencePack,
  type PackVerification,
} from '@paper-trail/chain';
import { unzipSync } from 'fflate';
import type * as pkijs from 'pkijs';
import { TokenError, verifyTimestampToken } from './timestamp.js';

export interface VerifyEvidenceOptions {
  /** TSA root/intermediate certificates to build a path to. Without them the TSA chain is not checked. */
  trustedCerts?: pkijs.Certificate[];
  /** Files that travelled with the pack (zip), by sha256. */
  files?: ReadonlyMap<string, Uint8Array>;
}

/**
 * Verifies an evidence pack completely and offline (SPEC §8): the chain, witness signatures, the pack
 * checksum, and every anchor's RFC 3161 token against the head entry it covers.
 */
export const verifyEvidencePack = async (
  input: unknown,
  opts: VerifyEvidenceOptions = {},
): Promise<PackVerification> => {
  const result = await verifyPack(input, {
    checkAnchorToken: async (anchor, headEntry) => {
      const der = b64urlToBytes(anchor.tst);
      if (!der)
        return { ok: false, reason: 'TOKEN_MALFORMED', detail: 'token is not canonical base64url' };
      try {
        const t = await verifyTimestampToken(der, anchorData(headEntry), opts.trustedCerts ?? []);
        return {
          ok: true,
          genTime: t.genTime,
          accuracyMs: t.accuracyMs,
          chainVerified: t.chainVerified,
        };
      } catch (err) {
        if (err instanceof TokenError)
          return { ok: false, reason: err.failure, detail: err.message };
        throw err;
      }
    },
  });
  if (opts.files && result.summary.chain_intact) {
    const extra = verifyAttachments(input as EvidencePack, opts.files);
    result.findings.push(...extra);
    if (extra.some((f) => f.severity === 'error')) result.verdict = 'FAILED';
  }
  return result;
};

const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_ZIP_FILES = 2_000;

export interface LoadedPack {
  pack: unknown;
  files: Map<string, Uint8Array>;
}

/** Reads a `.json` pack or a `.zip` (pack.json + files/). Throws a readable Error on bad input. */
export const loadPack = (bytes: Uint8Array): LoadedPack => {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    try {
      return { pack: JSON.parse(new TextDecoder().decode(bytes)), files: new Map() };
    } catch {
      throw new Error('file is not valid JSON');
    }
  }
  let total = 0;
  let count = 0;
  const entries = unzipSync(bytes, {
    filter: (f) => {
      total += f.originalSize;
      if (++count > MAX_ZIP_FILES || total > MAX_ZIP_BYTES)
        throw new Error('zip is too large to verify safely');
      return true;
    },
  });
  const packBytes = entries['pack.json'];
  if (!packBytes) throw new Error('zip has no pack.json');
  const files = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(entries)) {
    if (name.startsWith('files/') && !name.endsWith('/')) files.set(sha256Hex(data), data);
  }
  try {
    return { pack: JSON.parse(new TextDecoder().decode(packBytes)), files };
  } catch {
    throw new Error('pack.json is not valid JSON');
  }
};
