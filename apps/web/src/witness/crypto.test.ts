// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { verifyWitnessSignature } from '@paper-trail/chain';
import { describe, expect, it } from 'vitest';
import { createWitnessKey, signInvite, type InviteInfo } from './crypto';

const info: InviteInfo = {
  invite: {
    id: '1d6e3c9a-8b2f-4c71-9a0e-5f4d3c2b1a09',
    expires_at: '2026-11-06T08:00:00.000Z',
    owner_display_name: 'Budi',
  },
  entry: {
    ledger_id: '6f1c0a52-3d1e-4b0a-9f55-0c7d6a2e8b11',
    seq: 3,
    type: 'note',
    created_at: '2026-11-03T08:00:00.000Z',
    entry_hash: 'a'.repeat(64),
    payload: { text: 'Pemilik kos menahan deposit.' },
    has_attachment: false,
  },
};

/** What the server will rebuild and verify from the request body plus the invite. */
const asPayload = (body: Awaited<ReturnType<typeof signInvite>>) => ({
  ...body,
  invite_id: info.invite.id,
  target_seq: info.entry.seq,
  target_entry_hash: info.entry.entry_hash,
  statement: 'confirm',
});

describe('witness signing in the browser', () => {
  it('signs with Ed25519 when available, and the server-side verifier accepts it', async () => {
    const key = await createWitnessKey();
    expect(key.alg).toBe('Ed25519');
    const body = await signInvite(info, '  Siti 😀 ', key);
    expect(body.witness_name).toBe('Siti 😀');
    expect(await verifyWitnessSignature(info.entry.ledger_id, asPayload(body))).toEqual({
      ok: true,
    });
  });

  it('falls back to ECDSA P-256 when the browser has no Ed25519', async () => {
    const real = crypto.subtle;
    const oldBrowser = new Proxy(real, {
      get(target, prop) {
        if (prop === 'generateKey') {
          return (alg: AlgorithmIdentifier, ...rest: unknown[]) => {
            if ((alg as { name?: string }).name === 'Ed25519')
              return Promise.reject(new DOMException('NotSupportedError'));
            return (target.generateKey as (...a: unknown[]) => unknown).call(target, alg, ...rest);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const key = await createWitnessKey(oldBrowser);
    expect(key.alg).toBe('ES256');
    const body = await signInvite(info, 'Siti', key, new Date(), oldBrowser);
    expect(await verifyWitnessSignature(info.entry.ledger_id, asPayload(body))).toEqual({
      ok: true,
    });
  });

  it('normalizes the name to NFC before signing (the server rejects anything else)', async () => {
    const body = await signInvite(info, 'Café', await createWitnessKey());
    expect(body.witness_name).toBe('Café');
    expect((await verifyWitnessSignature(info.entry.ledger_id, asPayload(body))).ok).toBe(true);
  });

  it('keeps the private key non-extractable', async () => {
    const key = await createWitnessKey();
    expect(key.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', key.privateKey)).rejects.toThrow();
  });
});
