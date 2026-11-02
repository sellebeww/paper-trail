// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildEntry, computeEntryHash, computePayloadHash } from './entry.js';
import { canonicalize } from './jcs.js';
import type { Entry, PayloadObject, WitnessAlg, WitnessCosignPayload } from './types.js';
import { verifyChain } from './verify.js';
import { buildWitnessMessage } from './witness-message.js';
import { isValidWitnessName, verifyWitnessSignature, witnessAuthorRef } from './witness.js';

const LEDGER = '6f1c0a52-3d1e-4b0a-9f55-0c7d6a2e8b11';
const INVITE = '1d6e3c9a-8b2f-4c71-9a0e-5f4d3c2b1a09';

/** Signs like the witness browser does: fresh key pair, raw public key, 64-byte signature. */
const signedPayload = (
  alg: WitnessAlg,
  target: { seq: number; entry_hash: string },
  overrides: Partial<WitnessCosignPayload> = {},
): WitnessCosignPayload => {
  const { publicKey, privateKey } =
    alg === 'Ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const pub =
    alg === 'Ed25519'
      ? jwk.x!
      : Buffer.concat([
          Buffer.from([4]),
          Buffer.from(jwk.x!, 'base64url'),
          Buffer.from(jwk.y!, 'base64url'),
        ]).toString('base64url');
  const unsigned = {
    invite_id: INVITE,
    target_seq: target.seq,
    target_entry_hash: target.entry_hash,
    statement: 'confirm' as const,
    witness_name: 'Siti Rahayu',
    witness_pub: pub,
    alg,
    signed_client_time: '2026-11-03T08:00:00.000Z',
    ...overrides,
  };
  const message = Buffer.from(canonicalize(buildWitnessMessage(LEDGER, unsigned)), 'utf8');
  const signature =
    alg === 'Ed25519'
      ? sign(null, message, privateKey)
      : sign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return { ...unsigned, signature: signature.toString('base64url') };
};

const note = (n: number) => ({
  ledger_id: LEDGER,
  type: 'note' as const,
  created_at: new Date(Date.UTC(2026, 10, 3, 8, 0, n)).toISOString(),
  author_ref: 'owner:9d2f4c1a',
  payload: { text: `catatan ${n}` },
});

const chainWithCosign = (alg: WitnessAlg, overrides: Partial<WitnessCosignPayload> = {}) => {
  const a = buildEntry(note(0), null);
  const b = buildEntry(note(1), a);
  const payload = signedPayload(alg, { seq: 1, entry_hash: b.entry_hash }, overrides);
  const cosign = buildEntry(
    {
      ledger_id: LEDGER,
      type: 'witness_cosign',
      created_at: '2026-11-03T08:01:00.000Z',
      author_ref: witnessAuthorRef(payload.witness_pub),
      payload: payload as unknown as PayloadObject,
    },
    b,
  );
  return [a, b, cosign];
};

/** Replaces the cosign payload and reseals the entry, as a forger would. */
const forge = (chain: Entry[], payload: Record<string, unknown>, authorRef?: string): Entry[] => {
  const old = chain[2]!;
  const env = {
    ...old,
    payload: payload as PayloadObject,
    payload_hash: computePayloadHash(payload as PayloadObject),
    author_ref: authorRef ?? old.author_ref,
  };
  return [chain[0]!, chain[1]!, { ...env, entry_hash: computeEntryHash(env) }];
};

describe.each(['Ed25519', 'ES256'] as const)('verifyWitnessSignature (%s)', (alg) => {
  const target = { seq: 1, entry_hash: 'a'.repeat(64) };

  it('accepts a correctly signed payload', () => {
    expect(verifyWitnessSignature(LEDGER, signedPayload(alg, target))).toEqual({ ok: true });
  });

  it.each([
    ['witness_name', 'Orang Lain'],
    ['target_entry_hash', 'b'.repeat(64)],
    ['target_seq', 2],
    ['invite_id', '00000000-0000-4000-8000-000000000000'],
    ['signed_client_time', '2026-11-03T09:00:00.000Z'],
  ] as const)('rejects the signature when %s is modified after signing', (field, value) => {
    const p = { ...signedPayload(alg, target), [field]: value };
    expect(verifyWitnessSignature(LEDGER, p)).toMatchObject({
      ok: false,
      reason: 'signature does not verify',
    });
  });

  it('rejects the signature for another ledger', () => {
    expect(
      verifyWitnessSignature('0b5e9a7c-1111-4222-8333-944455556666', signedPayload(alg, target)).ok,
    ).toBe(false);
  });

  it("rejects someone else's public key and a corrupted signature", () => {
    const p = signedPayload(alg, target);
    const other = signedPayload(alg, target);
    expect(verifyWitnessSignature(LEDGER, { ...p, witness_pub: other.witness_pub }).ok).toBe(false);
    const sig = Buffer.from(p.signature, 'base64url');
    sig[10]! ^= 0xff;
    expect(verifyWitnessSignature(LEDGER, { ...p, signature: sig.toString('base64url') }).ok).toBe(
      false,
    );
  });

  it('rejects malformed encodings, wrong key sizes and extra fields', () => {
    const p = signedPayload(alg, target);
    expect(verifyWitnessSignature(LEDGER, { ...p, signature: `${p.signature}=` }).ok).toBe(false);
    expect(verifyWitnessSignature(LEDGER, { ...p, signature: p.signature.slice(4) }).ok).toBe(
      false,
    );
    expect(verifyWitnessSignature(LEDGER, { ...p, witness_pub: p.witness_pub.slice(4) }).ok).toBe(
      false,
    );
    expect(verifyWitnessSignature(LEDGER, { ...p, extra: 'tidak ditandatangani' })).toMatchObject({
      ok: false,
    });
    expect(
      verifyWitnessSignature(LEDGER, { ...p, alg: alg === 'Ed25519' ? 'ES256' : 'Ed25519' }).ok,
    ).toBe(false);
    expect(verifyWitnessSignature(LEDGER, null).ok).toBe(false);
  });
});

describe('witness name rules', () => {
  it.each([
    ['Siti', true],
    ['Bapak Andi 😀', true],
    ['', false],
    [' Siti', false],
    ['a'.repeat(81), false],
    ['Café', false], // NFD: the browser must normalize to NFC before signing
    ['a\u0007b', false],
    ['\ud800', false],
  ])('%j → %s', (name, valid) => {
    expect(isValidWitnessName(name)).toBe(valid);
  });
});

describe.each(['Ed25519', 'ES256'] as const)('verifyChain with a %s cosign', (alg) => {
  it('stays valid after a co-sign', () => {
    expect(verifyChain(chainWithCosign(alg))).toMatchObject({ ok: true, length: 3 });
  });

  it('accepts an undisclosed cosign payload (not checkable, chain intact)', () => {
    const chain = chainWithCosign(alg);
    const envelope: Entry = { ...chain[2]! };
    delete envelope.payload;
    expect(verifyChain([chain[0]!, chain[1]!, envelope]).ok).toBe(true);
  });

  it('rejects a cosign whose signature was made over a different name (resealed by a forger)', () => {
    const chain = chainWithCosign(alg);
    const tampered = forge(chain, { ...chain[2]!.payload!, witness_name: 'Saksi Palsu' });
    expect(verifyChain(tampered)).toMatchObject({
      ok: false,
      code: 'WITNESS_SIG_INVALID',
      brokenAtSeq: 2,
    });
  });

  it('rejects a cosign whose author_ref is not the witness key', () => {
    const chain = chainWithCosign(alg);
    expect(verifyChain(forge(chain, chain[2]!.payload!, 'witness:abcdef'))).toMatchObject({
      code: 'WITNESS_SIG_INVALID',
    });
  });

  it('rejects a cosign pointing at the wrong entry', () => {
    const [a, b] = chainWithCosign(alg);
    const payload = signedPayload(alg, { seq: 1, entry_hash: a!.entry_hash });
    const cosign = buildEntry(
      {
        ledger_id: LEDGER,
        type: 'witness_cosign',
        created_at: '2026-11-03T08:01:00.000Z',
        author_ref: witnessAuthorRef(payload.witness_pub),
        payload: payload as unknown as PayloadObject,
      },
      b!,
    );
    expect(verifyChain([a!, b!, cosign])).toMatchObject({
      ok: false,
      code: 'WITNESS_TARGET_MISMATCH',
      brokenAtSeq: 2,
    });
  });

  it('rejects a cosign that targets itself or a later entry', () => {
    const [a, b] = chainWithCosign(alg);
    const payload = signedPayload(alg, { seq: 2, entry_hash: 'c'.repeat(64) });
    const cosign = buildEntry(
      {
        ledger_id: LEDGER,
        type: 'witness_cosign',
        created_at: '2026-11-03T08:01:00.000Z',
        author_ref: witnessAuthorRef(payload.witness_pub),
        payload: payload as unknown as PayloadObject,
      },
      b!,
    );
    expect(verifyChain([a!, b!, cosign])).toMatchObject({ code: 'WITNESS_TARGET_MISMATCH' });
  });
});
