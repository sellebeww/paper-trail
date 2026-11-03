// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// RFC 3161 client: builds TimeStampReq, sends it to the configured TSAs in order, and validates the
// TimeStampResp before anything is stored. pkijs/asn1js (pure JS) instead of shelling out to `openssl ts`:
// no argument-injection or temp-file surface, no dependency on the host's OpenSSL/LibreSSL build.
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

pkijs.setEngine(
  'node',
  new pkijs.CryptoEngine({
    name: 'node',
    crypto: webcrypto as unknown as Crypto,
  }) as unknown as pkijs.ICryptoEngine,
);

export const OID = {
  sha256: '2.16.840.1.101.3.4.2.1',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  extKeyUsage: '2.5.29.37',
  basicConstraints: '2.5.29.19',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
} as const;

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

const ESS_HASHES: Record<string, string> = {
  [OID.sha256]: 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

/**
 * RFC 3161 §2.4.2: the token MUST carry an ESS signing-certificate attribute (RFC 2634 v1 with SHA-1, or
 * RFC 5035 v2) naming the TSA certificate. Without this check a different certificate with the same key
 * could be substituted. The hash of the first ESSCertID must equal the hash of the signer certificate.
 */
const checkEssSigningCertificate = (
  signerInfo: pkijs.SignerInfo,
  signerCert: pkijs.Certificate,
) => {
  const attrs = signerInfo.signedAttrs?.attributes ?? [];
  const v2 = attrs.find((a) => a.type === OID.signingCertificateV2);
  const attr = v2 ?? attrs.find((a) => a.type === OID.signingCertificate);
  if (!attr)
    throw new TsaError(
      'token lacks the ESS signing-certificate attribute (RFC 3161 §2.4.2)',
      false,
    );
  try {
    const certs = (attr.values[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence;
    const first = (certs.valueBlock.value[0] as asn1js.Sequence).valueBlock.value;
    let algorithm = v2 ? 'sha256' : 'sha1'; // ESSCertIDv2 defaults to SHA-256; ESSCertID is always SHA-1
    let i = 0;
    if (v2 && first[0] instanceof asn1js.Sequence) {
      const oid = (first[0].valueBlock.value[0] as asn1js.ObjectIdentifier).valueBlock.toString();
      const named = ESS_HASHES[oid];
      if (!named) throw new Error(`unsupported hash ${oid}`);
      algorithm = named;
      i = 1;
    }
    const expected = Buffer.from((first[i] as asn1js.OctetString).valueBlock.valueHexView);
    const actual = createHash(algorithm)
      .update(Buffer.from(signerCert.toSchema().toBER(false)))
      .digest();
    if (!expected.equals(actual)) throw new Error('hash mismatch');
  } catch (err) {
    throw new TsaError(
      `ESS signing-certificate does not identify the TSA certificate (${(err as Error).message})`,
      false,
    );
  }
};

const accuracyMs = (a?: pkijs.Accuracy) =>
  a ? (a.seconds ?? 0) * 1000 + (a.millis ?? 0) + Math.ceil((a.micros ?? 0) / 1000) : 0;

/**
 * Validates a TimeStampResp for our request. Checks, in order: PKIStatus, token is CMS SignedData over a
 * TSTInfo, messageImprint (SHA-256 + our digest), nonce, genTime vs our clock, CMS signature with the
 * embedded TSA certificate, TSA certificate validity at genTime and its critical id-kp-timeStamping EKU
 * (RFC 3161 §2.3), and, when trust anchors are given, the certificate chain.
 */
export const validateTimeStampResponse = async (
  der: Uint8Array,
  expected: { data: Uint8Array; nonce: Uint8Array },
  opts: { trustedCerts?: pkijs.Certificate[]; now?: Date } = {},
): Promise<TimestampResult> => {
  const digest = createHash('sha256').update(expected.data).digest();
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

  const signed = new pkijs.SignedData({ schema: token.content });
  const eContent = signed.encapContentInfo.eContent;
  if (signed.encapContentInfo.eContentType !== OID.tstInfo || !eContent)
    throw bad('token does not carry a TSTInfo');
  let tst: pkijs.TSTInfo;
  try {
    tst = pkijs.TSTInfo.fromBER(eContent.getValue());
  } catch {
    throw bad('TSTInfo cannot be parsed');
  }

  if (tst.messageImprint.hashAlgorithm.algorithmId !== OID.sha256)
    throw bad('messageImprint is not SHA-256');
  if (!bytesEqual(tst.messageImprint.hashedMessage.valueBlock.valueHexView, digest)) {
    throw bad('messageImprint does not match the requested digest');
  }
  if (
    !tst.nonce ||
    !bytesEqual(stripZeros(tst.nonce.valueBlock.valueHexView), stripZeros(expected.nonce))
  ) {
    throw bad('nonce does not match the request (possible replay)');
  }
  const genTime = tst.genTime;
  const now = opts.now ?? new Date();
  if (!(genTime instanceof Date) || Number.isNaN(genTime.getTime()))
    throw bad('genTime is invalid');
  if (Math.abs(genTime.getTime() - now.getTime()) > MAX_CLOCK_SKEW_MS) {
    throw bad(`genTime ${genTime.toISOString()} is more than 10 minutes from the local clock`);
  }

  const trusted = opts.trustedCerts ?? [];
  let signerCert: pkijs.Certificate | undefined;
  try {
    const result = await signed.verify({
      signer: 0,
      checkChain: trusted.length > 0,
      trustedCerts: trusted,
      checkDate: genTime,
      // pkijs re-hashes the timestamped data and compares it with messageImprint: a second, independent check.
      data: Uint8Array.from(expected.data).buffer,
      extendedMode: true,
    });
    if (!result.signatureVerified) throw new Error('signature does not verify');
    signerCert = result.signerCertificate ?? undefined;
  } catch (err) {
    const detail = (err as { message?: string }).message ?? String(err);
    throw bad(`CMS signature or certificate check failed: ${detail}`);
  }
  if (!signerCert) throw bad('TSA certificate is missing from the token (certReq was set)');

  checkEssSigningCertificate(signed.signerInfos[0]!, signerCert);
  if (genTime < signerCert.notBefore.value || genTime > signerCert.notAfter.value) {
    throw bad('TSA certificate was not valid at genTime');
  }
  const eku = signerCert.extensions?.find((e) => e.extnID === OID.extKeyUsage);
  const purposes = (eku?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? [];
  if (!eku?.critical || !purposes.includes(OID.timeStamping)) {
    throw bad('TSA certificate lacks a critical id-kp-timeStamping extended key usage');
  }

  return {
    token: Buffer.from(token.toSchema().toBER(false)),
    genTime,
    accuracyMs: accuracyMs(tst.accuracy),
    serialNumber: Buffer.from(tst.serialNumber.valueBlock.valueHexView).toString('hex'),
    chainVerified: trusted.length > 0,
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
  const pem = await readFile(path, 'utf8');
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) throw new Error(`TSA_CA_CERTS: no certificates found in ${path}`);
  return blocks.map((b) =>
    pkijs.Certificate.fromBER(Buffer.from(b.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64')),
  );
};

export const toPem = (cert: pkijs.Certificate) =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(cert.toSchema().toBER(false))
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim()}\n-----END CERTIFICATE-----\n`;
