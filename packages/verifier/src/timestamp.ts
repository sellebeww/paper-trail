// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// Offline verification of an RFC 3161 TimeStampToken. Shared by the worker (when it receives a token) and
// by the pack verifier (when someone checks an exported anchor). pkijs/asn1js are pure JS: no shelling out
// to `openssl ts`, so there is no argument-injection or temp-file surface and no dependency on the host's OpenSSL.
import { createHash, webcrypto } from 'node:crypto';
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

/** Which check failed, so callers can map it to a result code (SPEC §7). */
export type TokenFailure =
  'TOKEN_MALFORMED' | 'IMPRINT_MISMATCH' | 'SIGNATURE_INVALID' | 'CERT_UNTRUSTED';

export class TokenError extends Error {
  override name = 'TokenError';
  constructor(
    message: string,
    readonly failure: TokenFailure,
  ) {
    super(message);
  }
}

export interface TokenResult {
  genTime: Date;
  /** TSTInfo accuracy in milliseconds (0 when the TSA does not state it). */
  accuracyMs: number;
  serialNumber: string;
  /** Raw nonce from TSTInfo, if present (the requester compares it with the one it sent). */
  nonce?: Uint8Array;
  /** True when the TSA certificate chained to one of the given trust anchors. */
  chainVerified: boolean;
  /** Certificates embedded in the token, DER. */
  certificates: Uint8Array[];
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

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
    throw new TokenError(
      'token lacks the ESS signing-certificate attribute (RFC 3161 §2.4.2)',
      'SIGNATURE_INVALID',
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
    throw new TokenError(
      `ESS signing-certificate does not identify the TSA certificate (${(err as Error).message})`,
      'SIGNATURE_INVALID',
    );
  }
};

const accuracyMs = (a?: pkijs.Accuracy) =>
  a ? (a.seconds ?? 0) * 1000 + (a.millis ?? 0) + Math.ceil((a.micros ?? 0) / 1000) : 0;

/**
 * Verifies a TimeStampToken (DER CMS ContentInfo) over `data`: SignedData over a TSTInfo; SHA-256
 * messageImprint equal to SHA-256(data); CMS signature with the embedded TSA certificate; ESS signing
 * certificate; certificate valid at genTime with a critical id-kp-timeStamping key usage; and, when
 * `trustedCerts` is not empty, a certificate path to one of them. Throws TokenError otherwise.
 * Time is taken from the token (`genTime`), never from the local clock.
 */
export const verifyTimestampToken = async (
  der: Uint8Array,
  data: Uint8Array,
  trustedCerts: pkijs.Certificate[] = [],
): Promise<TokenResult> => {
  let content: pkijs.ContentInfo;
  try {
    content = pkijs.ContentInfo.fromBER(der);
  } catch {
    throw new TokenError('token is not a DER CMS ContentInfo', 'TOKEN_MALFORMED');
  }
  if (content.contentType !== OID.signedData)
    throw new TokenError('token is not CMS SignedData', 'TOKEN_MALFORMED');

  let signed: pkijs.SignedData;
  let tst: pkijs.TSTInfo;
  try {
    signed = new pkijs.SignedData({ schema: content.content });
    const eContent = signed.encapContentInfo.eContent;
    if (signed.encapContentInfo.eContentType !== OID.tstInfo || !eContent)
      throw new Error('no TSTInfo');
    tst = pkijs.TSTInfo.fromBER(eContent.getValue());
  } catch {
    throw new TokenError('token does not carry a parsable TSTInfo', 'TOKEN_MALFORMED');
  }

  const digest = createHash('sha256').update(data).digest();
  if (tst.messageImprint.hashAlgorithm.algorithmId !== OID.sha256)
    throw new TokenError('messageImprint is not SHA-256', 'IMPRINT_MISMATCH');
  if (!bytesEqual(tst.messageImprint.hashedMessage.valueBlock.valueHexView, digest)) {
    throw new TokenError('messageImprint does not match the requested digest', 'IMPRINT_MISMATCH');
  }
  const genTime = tst.genTime;
  if (!(genTime instanceof Date) || Number.isNaN(genTime.getTime()))
    throw new TokenError('genTime is invalid', 'TOKEN_MALFORMED');

  let signerCert: pkijs.Certificate | undefined;
  try {
    const result = await signed.verify({
      signer: 0,
      checkChain: trustedCerts.length > 0,
      trustedCerts,
      checkDate: genTime,
      // pkijs re-hashes the timestamped data and compares it with messageImprint: a second, independent check.
      data: Uint8Array.from(data).buffer,
      extendedMode: true,
    });
    if (!result.signatureVerified) throw new Error('signature does not verify');
    signerCert = result.signerCertificate ?? undefined;
  } catch (err) {
    const detail = (err as { message?: string }).message ?? String(err);
    throw new TokenError(
      `CMS signature or certificate check failed: ${detail}`,
      trustedCerts.length > 0 && /certificate|path|chain/i.test(detail)
        ? 'CERT_UNTRUSTED'
        : 'SIGNATURE_INVALID',
    );
  }
  if (!signerCert)
    throw new TokenError(
      'TSA certificate is missing from the token (certReq was set)',
      'SIGNATURE_INVALID',
    );

  checkEssSigningCertificate(signed.signerInfos[0]!, signerCert);
  if (genTime < signerCert.notBefore.value || genTime > signerCert.notAfter.value) {
    throw new TokenError('TSA certificate was not valid at genTime', 'CERT_UNTRUSTED');
  }
  const eku = signerCert.extensions?.find((e) => e.extnID === OID.extKeyUsage);
  const purposes = (eku?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? [];
  if (!eku?.critical || !purposes.includes(OID.timeStamping)) {
    throw new TokenError(
      'TSA certificate lacks a critical id-kp-timeStamping extended key usage',
      'CERT_UNTRUSTED',
    );
  }

  return {
    genTime,
    accuracyMs: accuracyMs(tst.accuracy),
    serialNumber: Buffer.from(tst.serialNumber.valueBlock.valueHexView).toString('hex'),
    ...(tst.nonce ? { nonce: new Uint8Array(tst.nonce.valueBlock.valueHexView) } : {}),
    chainVerified: trustedCerts.length > 0,
    certificates: certificatesOf(signed),
  };
};

const certificatesOf = (signed: pkijs.SignedData): Uint8Array[] =>
  (signed.certificates ?? [])
    .filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate)
    .map((c) => new Uint8Array(c.toSchema().toBER(false)));

/** The certificates embedded in a token (DER each). Returns [] for anything that is not a token. */
export const extractTokenCertificates = (der: Uint8Array): Uint8Array[] => {
  try {
    const content = pkijs.ContentInfo.fromBER(der);
    return certificatesOf(new pkijs.SignedData({ schema: content.content }));
  } catch {
    return [];
  }
};

/** Parses every certificate in a PEM bundle. Throws when there is none. */
export const parsePemCertificates = (pem: string): pkijs.Certificate[] => {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) throw new Error('no certificates found in the PEM data');
  return blocks.map((b) =>
    pkijs.Certificate.fromBER(Buffer.from(b.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64')),
  );
};

export const toPem = (cert: pkijs.Certificate) =>
  `-----BEGIN CERTIFICATE-----\n${Buffer.from(cert.toSchema().toBER(false))
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim()}\n-----END CERTIFICATE-----\n`;
