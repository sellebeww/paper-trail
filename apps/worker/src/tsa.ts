// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// RFC 3161 client: builds TimeStampReq, sends it to the configured TSAs in order, and validates the
// TimeStampResp before anything is stored. pkijs/asn1js (pure JS) instead of shelling out to `openssl ts`:
// no argument-injection or temp-file surface, no dependency on the host's OpenSSL/LibreSSL build.
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OID, parsePemCertificates, TokenError, verifyTimestampToken } from '@paper-trail/verifier';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

const MAX_RESPONSE_BYTES = 256 * 1024;
/** Allowed distance between the TSA's genTime and our clock when the reply arrives. */
const MAX_CLOCK_SKEW_MS = 10 * 60_000;

export class TsaError extends Error {
  override name = 'TsaError';
  /** retryable: worth trying again later (network, HTTP 5xx, TSA busy). Not: the TSA answered wrongly. */
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface TimestampResult {
  /** DER of the TimeStampToken (CMS ContentInfo), as stored and exported. */
  token: Buffer;
  genTime: Date;
  /** TSTInfo accuracy in milliseconds (0 when the TSA does not state it). */
  accuracyMs: number;
  serialNumber: string;
  /** True when the TSA certificate chained to a configured trust anchor. */
  chainVerified: boolean;
}

/** A random positive 64-bit nonce, minimally DER-encodable (first byte 0x01–0x7f). */
export const newNonce = (): Buffer => {
  const nonce = randomBytes(8);
  nonce[0] = (nonce[0]! % 0x7f) + 1;
  return nonce;
};

export const buildTimeStampRequest = (digest: Uint8Array, nonce: Uint8Array): ArrayBuffer =>
  new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: OID.sha256,
        algorithmParams: new asn1js.Null(),
      }),
      hashedMessage: new asn1js.OctetString({ valueHex: digest }),
    }),
    nonce: new asn1js.Integer({ valueHex: nonce }),
    certReq: true,
  })
    .toSchema()
    .toBER(false);

const bytesEqual = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const stripZeros = (b: Uint8Array) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
};

/**
 * Validates a TimeStampResp for our request: PKIStatus, then the token itself (shared verifier: imprint,
 * CMS signature, ESS certificate, key usage, chain), then what only the requester can check: the nonce
 * and that genTime is close to our clock.
 */
export const validateTimeStampResponse = async (
  der: Uint8Array,
  expected: { data: Uint8Array; nonce: Uint8Array },
  opts: { trustedCerts?: pkijs.Certificate[]; now?: Date } = {},
): Promise<TimestampResult> => {
  const bad = (message: string) => new TsaError(message, false);
  let resp: pkijs.TimeStampResp;
  try {
    resp = pkijs.TimeStampResp.fromBER(der);
  } catch {
    throw bad('response is not a DER TimeStampResp');
  }

  const status = resp.status.status;
  if (status !== 0 && status !== 1) {
    // 3 = waiting: the TSA is busy, try later. Everything else is a refusal.
    throw new TsaError(`TSA refused the request (PKIStatus ${status})`, status === 3);
  }
  const token = resp.timeStampToken;
  if (!token || token.contentType !== OID.signedData)
    throw bad('timeStampToken is missing or not SignedData');
  const tokenDer = Buffer.from(token.toSchema().toBER(false));

  let result;
  try {
    result = await verifyTimestampToken(tokenDer, expected.data, opts.trustedCerts ?? []);
  } catch (err) {
    if (err instanceof TokenError) throw bad(err.message);
    throw err;
  }
  if (!result.nonce || !bytesEqual(stripZeros(result.nonce), stripZeros(expected.nonce))) {
    throw bad('nonce does not match the request (possible replay)');
  }
  const now = opts.now ?? new Date();
  if (Math.abs(result.genTime.getTime() - now.getTime()) > MAX_CLOCK_SKEW_MS) {
    throw bad(
      `genTime ${result.genTime.toISOString()} is more than 10 minutes from the local clock`,
    );
  }
  return {
    token: tokenDer,
    genTime: result.genTime,
    accuracyMs: result.accuracyMs,
    serialNumber: result.serialNumber,
    chainVerified: result.chainVerified,
  };
};

export interface TsaConfig {
  urls: string[];
  timeoutMs: number;
  trustedCerts: pkijs.Certificate[];
}

/** Origin + path only: TSA URLs may carry credentials, which must never reach logs or the database. */
export const redactUrl = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
};

/**
 * Timestamps `data` (the bytes whose SHA-256 goes into messageImprint). Asks each configured TSA in turn;
 * the first valid token wins.
 */
export const requestTimestamp = async (
  cfg: TsaConfig,
  data: Uint8Array,
): Promise<TimestampResult & { tsaUrl: string }> => {
  const digest = createHash('sha256').update(data).digest();
  if (cfg.urls.length === 0) throw new TsaError('no TSA configured (TSA_URLS is empty)', false);
  const failures: string[] = [];
  let retryable = false;
  for (const url of cfg.urls) {
    const nonce = newNonce();
    try {
      // Credentials in the URL (user:pass@) become HTTP Basic auth; fetch would refuse them, and echo them in its error.
      const target = new URL(url);
      const auth = target.username
        ? `Basic ${Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString('base64')}`
        : undefined;
      target.username = '';
      target.password = '';
      const res = await fetch(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/timestamp-query',
          accept: 'application/timestamp-reply',
          ...(auth ? { authorization: auth } : {}),
        },
        body: Buffer.from(buildTimeStampRequest(digest, nonce)),
        signal: AbortSignal.timeout(cfg.timeoutMs),
        redirect: 'error',
      });
      if (!res.ok)
        throw new TsaError(`HTTP ${res.status}`, res.status >= 500 || res.status === 429);
      if (Number(res.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES)
        throw new TsaError('response too large', false);
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.length > MAX_RESPONSE_BYTES) throw new TsaError('response too large', false);
      const result = await validateTimeStampResponse(
        body,
        { data, nonce },
        { trustedCerts: cfg.trustedCerts },
      );
      return { ...result, tsaUrl: redactUrl(url) };
    } catch (err) {
      const e =
        err instanceof TsaError
          ? err
          : new TsaError(
              (err as Error).name === 'TimeoutError'
                ? `timeout after ${cfg.timeoutMs} ms`
                : // Only the error code: raw messages can repeat the URL.
                  `network error (${(err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name})`,
              true,
            );
      retryable ||= e.retryable;
      failures.push(`${redactUrl(url)}: ${e.message}`);
    }
  }
  throw new TsaError(`all TSAs failed: ${failures.join('; ')}`, retryable);
};

/** Parses every certificate in a PEM bundle (TSA_CA_CERTS). */
export const loadTrustedCerts = async (path: string | undefined): Promise<pkijs.Certificate[]> => {
  if (!path) return [];
  try {
    return parsePemCertificates(await readFile(path, 'utf8'));
  } catch (err) {
    throw new Error(`TSA_CA_CERTS (${path}): ${(err as Error).message}`);
  }
};
