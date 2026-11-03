// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import * as pkijs from 'pkijs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockTsa, type MockTsa, type MockTsaMode } from '@paper-trail/verifier/testing';
import { OID } from '@paper-trail/verifier';
import { redactUrl, requestTimestamp, TsaError, type TsaConfig } from './tsa.js';

let tsa: MockTsa;
let otherTsa: MockTsa; // a different, unrelated CA
const data = Buffer.from('{"author_ref":"owner:1","seq":0}', 'utf8'); // stands in for a head envelope
const digest = createHash('sha256').update(data).digest();

beforeAll(async () => {
  [tsa, otherTsa] = await Promise.all([createMockTsa(), createMockTsa()]);
});
afterAll(async () => {
  await Promise.all([tsa.close(), otherTsa.close()]);
});
beforeEach(() => tsa.setMode('ok'));

const cfg = (over: Partial<TsaConfig> = {}): TsaConfig => ({
  urls: [tsa.url],
  timeoutMs: 2_000,
  trustedCerts: [tsa.caCert],
  ...over,
});

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TsaError);
    return err as TsaError;
  }
  throw new Error('expected a TsaError');
};

describe('requestTimestamp + validateTimeStampResponse', () => {
  it('returns a validated token whose TSTInfo carries our digest, with genTime and chain verification', async () => {
    const before = Date.now();
    const r = await requestTimestamp(cfg(), data);
    expect(r.chainVerified).toBe(true);
    expect(r.tsaUrl).toBe(tsa.url);
    expect(r.genTime.getTime()).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(r.genTime.getTime()).toBeLessThanOrEqual(Date.now());
    expect(r.accuracyMs).toBe(1000);

    // The stored token is a self-contained CMS SignedData over a TSTInfo with our digest.
    const ci = pkijs.ContentInfo.fromBER(r.token);
    expect(ci.contentType).toBe(OID.signedData);
    const sd = new pkijs.SignedData({ schema: ci.content });
    const tst = pkijs.TSTInfo.fromBER(sd.encapContentInfo.eContent!.getValue());
    expect(
      Buffer.from(tst.messageImprint.hashedMessage.valueBlock.valueHexView).equals(digest),
    ).toBe(true);
  });

  it('still validates the signature without trust anchors, but reports the chain as unverified', async () => {
    const r = await requestTimestamp(cfg({ trustedCerts: [] }), data);
    expect(r.chainVerified).toBe(false);
  });

  it.each<[MockTsaMode, RegExp]>([
    ['wrong-nonce', /nonce does not match/],
    ['no-nonce', /nonce does not match/],
    ['wrong-imprint', /messageImprint does not match/],
    ['bad-signature', /signature or certificate check failed/],
    ['no-eku', /timeStamping/],
    ['no-ess', /ESS signing-certificate attribute/],
    ['reject', /PKIStatus 2/],
    ['garbage', /not a DER TimeStampResp/],
  ])('rejects a %s response as a non-retryable error', async (mode, message) => {
    tsa.setMode(mode);
    const err = await failure(requestTimestamp(cfg(), data));
    expect(err.message).toMatch(message);
    expect(err.retryable).toBe(false);
  });

  it('rejects a token from a TSA whose CA is not trusted', async () => {
    const err = await failure(requestTimestamp(cfg({ trustedCerts: [otherTsa.caCert] }), data));
    expect(err.message).toMatch(/signature or certificate check failed/);
  });

  it.each<[MockTsaMode, RegExp]>([
    ['http-500', /HTTP 500/],
    ['slow', /timeout/],
  ])('treats %s as retryable', async (mode, message) => {
    tsa.setMode(mode);
    const err = await failure(requestTimestamp(cfg({ timeoutMs: 500 }), data));
    expect(err.message).toMatch(message);
    expect(err.retryable).toBe(true);
  });

  it('falls back to the next TSA when the first is down', async () => {
    const r = await requestTimestamp(cfg({ urls: ['http://127.0.0.1:9/tsr', tsa.url] }), digest);
    expect(r.tsaUrl).toBe(tsa.url);
  });

  it('never puts TSA credentials into errors or results', async () => {
    const secretUrl = 'http://user:s3cret@127.0.0.1:9/tsr?key=abc';
    const err = await failure(requestTimestamp(cfg({ urls: [secretUrl] }), data));
    expect(err.message).not.toMatch(/s3cret|key=abc/);
    expect(redactUrl(secretUrl)).toBe('http://127.0.0.1:9/tsr');
  });

  it('refuses to run without a configured TSA', async () => {
    const err = await failure(requestTimestamp(cfg({ urls: [] }), data));
    expect(err.retryable).toBe(false);
  });
});
