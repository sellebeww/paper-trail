// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Tokens issued by real time-stamping authorities, kept as fixtures so that encodings our mock TSA never produces
// cannot break verification unnoticed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePemCertificates, TokenError, verifyTimestampToken } from './timestamp.js';

const load = (name: string) => {
  const f = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures', name), 'utf8')) as {
    data_b64: string;
    token_b64: string;
    root_pem: string;
  };
  return {
    data: Buffer.from(f.data_b64, 'base64'),
    token: Buffer.from(f.token_b64, 'base64'),
    roots: parsePemCertificates(f.root_pem),
  };
};

describe('real TSA tokens', () => {
  it('DigiCert: the token embeds a cross-signed copy of the root; the trusted self-signed root must still win', async () => {
    const { data, token, roots } = load('digicert-token.json');
    const r = await verifyTimestampToken(token, data, roots);
    expect(r.chainVerified).toBe(true);
    expect(r.genTime.toISOString()).toBe('2026-11-04T05:06:00.000Z');
    expect(r.certificates.length).toBeGreaterThanOrEqual(3); // leaf, intermediate, cross-signed root: all still reported
  });

  it('DigiCert: still refuses the token for other data and for an unrelated root', async () => {
    const { data, token, roots } = load('digicert-token.json');
    await expect(
      verifyTimestampToken(token, Buffer.concat([data, Buffer.from('x')]), roots),
    ).rejects.toMatchObject({
      failure: 'IMPRINT_MISMATCH',
    });
    const wrongRoot = parsePemCertificates(
      readFileSync(resolve(import.meta.dirname, '../../../docs/examples/freetsa-root.pem'), 'utf8'),
    );
    expect(roots).toHaveLength(1);
    const err = await verifyTimestampToken(token, data, wrongRoot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenError);
    expect((err as TokenError).failure).toBe('CERT_UNTRUSTED');
  });
});
