// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { MemoryStore } from './storage.js';
import {
  buildWitnessMessage,
  canonicalize,
  verifyChain,
  verifyWitnessSignature,
  type Entry,
  type WitnessAlg,
} from '@paper-trail/chain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { png, startTestApp, uploadForm, type TestClient, type TestJson } from '../test/client.js';

type App = Awaited<ReturnType<typeof startTestApp<MemoryStore>>>;
let app: App;
let tight: App; // WITNESS_RATE_LIMIT_IP = 5, WITNESS_RATE_LIMIT_TOKEN = 3

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** What the witness browser does: fresh key pair, sign JCS(message) built from the invite info. */
const witnessKey = (alg: WitnessAlg) => {
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
  return { alg, pub, privateKey };
};

const signBody = (
  info: TestJson,
  opts: {
    alg?: WitnessAlg;
    name?: string;
    key?: { alg: WitnessAlg; pub: string; privateKey: KeyObject };
    signedName?: string;
    signedTarget?: string;
  } = {},
) => {
  const key = opts.key ?? witnessKey(opts.alg ?? 'Ed25519');
  const name = opts.name ?? 'Siti Rahayu';
  const signed_client_time = new Date().toISOString();
  const message = buildWitnessMessage(info.entry.ledger_id, {
    invite_id: info.invite.id,
    target_seq: info.entry.seq,
    target_entry_hash: opts.signedTarget ?? info.entry.entry_hash,
    statement: 'confirm',
    witness_name: opts.signedName ?? name,
    witness_pub: key.pub,
    alg: key.alg,
    signed_client_time,
  });
  const bytes = Buffer.from(canonicalize(message), 'utf8');
  const signature =
    key.alg === 'Ed25519'
      ? sign(null, bytes, key.privateKey)
      : sign('sha256', bytes, { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return {
    alg: key.alg,
    witness_pub: key.pub,
    signature: signature.toString('base64url'),
    witness_name: name,
    signed_client_time,
  };
};

/** An owner with a ledger, one note, and an open invite for it. */
const setup = async (a: App = app, invite: Record<string, unknown> = {}) => {
  const owner = a.client();
  await owner.register();
  const ledger = (
    await owner.json('POST', '/ledgers', { json: { title: 'Sengketa sewa kos', category: 'sewa' } })
  ).body.ledger;
  const entry = (
    await owner.json('POST', `/ledgers/${ledger.id}/entries`, {
      json: { type: 'note', text: 'Pemilik kos menahan deposit.' },
    })
  ).body.entry;
  const created = await owner.json('POST', `/entries/${entry.id}/witness-invites`, {
    json: invite,
  });
  expect(created.status).toBe(201);
  return {
    owner,
    ledger,
    entry,
    token: created.body.token as string,
    invite: created.body.invite,
    url: created.body.url as string,
  };
};

const getInfo = async (c: TestClient, token: string) => c.json('GET', `/witness/${token}`);

beforeAll(async () => {
  [app, tight] = await Promise.all([
    startTestApp(),
    startTestApp({ WITNESS_RATE_LIMIT_IP: '5', WITNESS_RATE_LIMIT_TOKEN: '3' }),
  ]);
});
afterAll(async () => {
  await Promise.all([app.close(), tight.close()]);
});

describe('owner: witness invites', () => {
  it('creates a 256-bit token, stores only its hash, and puts it in the URL fragment', async () => {
    const { token, url, invite } = await setup(app, { owner_display_name: 'Budi' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(url).toBe(`http://localhost:5173/saksi#${token}`);
    expect(new URL(url).search).toBe('');

    const row = await app.db.witnessInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(row.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const hours = (row.expiresAt.getTime() - row.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(72, 1);
    expect(invite).toMatchObject({ status: 'open', owner_display_name: 'Budi', witness: null });
  });

  it('lists invites with their status and lets the owner revoke an unused one', async () => {
    const { owner, entry, invite, token } = await setup(app, { expires_in_hours: 1 });
    expect((await owner.json('DELETE', `/witness-invites/${invite.id}`)).status).toBe(204);
    expect((await owner.json('DELETE', `/witness-invites/${invite.id}`)).status).toBe(204); // idempotent
    const list = await owner.json('GET', `/entries/${entry.id}/witness-invites`);
    expect(list.body.invites).toEqual([
      expect.objectContaining({ id: invite.id, status: 'revoked' }),
    ]);
    expect((await getInfo(app.client(), token)).status).toBe(404);
  });

  it('refuses invites for other people’s entries and for cosign entries; cannot revoke a used invite', async () => {
    const { owner, entry, token, invite } = await setup();
    const stranger = app.client();
    await stranger.register();
    expect(
      (await stranger.json('POST', `/entries/${entry.id}/witness-invites`, { json: {} })).status,
    ).toBe(404);
    expect((await stranger.json('GET', `/entries/${entry.id}/witness-invites`)).status).toBe(404);
    expect((await stranger.json('DELETE', `/witness-invites/${invite.id}`)).status).toBe(404);

    const w = app.client();
    const signed = await w.json('POST', `/witness/${token}/sign`, {
      json: signBody((await getInfo(w, token)).body),
    });
    expect(signed.status).toBe(201);
    const cosign = (await owner.json('GET', `/ledgers/${entry.ledger_id}/entries`)).body.entries[1];
    expect(
      (await owner.json('POST', `/entries/${cosign.id}/witness-invites`, { json: {} })).status,
    ).toBe(400);
    expect((await owner.json('DELETE', `/witness-invites/${invite.id}`)).status).toBe(409);
  });

  it('validates invite options', async () => {
    const { owner, entry } = await setup();
    for (const body of [
      { expires_in_hours: 0 },
      { expires_in_hours: 721 },
      { owner_display_name: '' },
      { owner_display_name: 'x'.repeat(81) },
      { extra: 1 },
    ]) {
      expect([
        body,
        (await owner.json('POST', `/entries/${entry.id}/witness-invites`, { json: body })).status,
      ]).toEqual([body, 400]);
    }
  });
});

describe('witness: viewing and signing', () => {
  it('shows the entry and only the owner name the owner chose, without login', async () => {
    const { token, entry, ledger } = await setup(app, { owner_display_name: 'Budi' });
    const res = await getInfo(app.client(), token);
    expect(res.status).toBe(200);
    expect(res.body.entry).toEqual({
      ledger_id: ledger.id,
      seq: 0,
      type: 'note',
      created_at: entry.created_at,
      entry_hash: entry.entry_hash,
      payload: { text: 'Pemilik kos menahan deposit.' },
      has_attachment: false,
    });
    expect(res.body.invite.owner_display_name).toBe('Budi');
    expect(JSON.stringify(res.body)).not.toMatch(/Sengketa sewa kos|@example\.test/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it.each(['Ed25519', 'ES256'] as const)(
    'accepts a %s signature, appends a cosign entry and returns a receipt',
    async (alg) => {
      const { owner, token, entry, ledger, invite } = await setup();
      const w = app.client();
      const info = (await getInfo(w, token)).body;
      const res = await w.json('POST', `/witness/${token}/sign`, {
        json: signBody(info, { alg, name: 'Siti 😀' }),
      });
      expect(res.status).toBe(201);

      const { receipt } = res.body;
      expect(receipt.format).toBe('papertrail.witness-receipt/0.1');
      expect(receipt.target_entry).toEqual({ seq: 0, entry_hash: entry.entry_hash });
      expect(receipt.cosign_entry).toMatchObject({
        seq: 1,
        type: 'witness_cosign',
        prev_hash: entry.entry_hash,
      });
      // The receipt alone is enough to re-check the signature (it is the witness's independent copy).
      const signed = { ...receipt.signed_message };
      const ledger_id = signed.ledger_id;
      delete signed.v;
      delete signed.purpose;
      delete signed.ledger_id;
      expect(
        await verifyWitnessSignature(ledger_id, { ...signed, signature: receipt.signature }),
      ).toEqual({ ok: true });

      const chain = (await owner.json('GET', `/ledgers/${ledger.id}/entries`)).body
        .entries as (Entry & { id: string })[];
      expect(chain).toHaveLength(2);
      expect(chain[1]!.entry_hash).toBe(receipt.cosign_entry.entry_hash);
      expect(chain[1]!.payload).toMatchObject({
        witness_name: 'Siti 😀',
        alg,
        target_entry_hash: entry.entry_hash,
        invite_id: invite.id,
      });
      expect(await verifyChain(chain)).toMatchObject({ ok: true, length: 2 }); // chain stays valid, signature included

      const list = await owner.json('GET', `/entries/${entry.id}/witness-invites`);
      expect(list.body.invites[0]).toMatchObject({
        status: 'used',
        witness: { display_name: 'Siti 😀', alg, cosign_entry_id: chain[1]!.id },
      });
      expect((await getInfo(app.client(), token)).body.error.code).toBe('INVITE_UNAVAILABLE');
    },
  );

  it('lets exactly one of two parallel signatures with the same token succeed', async () => {
    const { owner, token, ledger } = await setup();
    const info = (await getInfo(app.client(), token)).body;
    const [a, b] = await Promise.all([
      app
        .client()
        .json('POST', `/witness/${token}/sign`, { json: signBody(info, { name: 'Saksi A' }) }),
      app
        .client()
        .json('POST', `/witness/${token}/sign`, { json: signBody(info, { name: 'Saksi B' }) }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 404]);
    expect([a, b].find((r) => r.status === 404)!.body.error.code).toBe('INVITE_UNAVAILABLE');

    const chain = (await owner.json('GET', `/ledgers/${ledger.id}/entries`)).body
      .entries as Entry[];
    expect(chain.filter((e) => e.type === 'witness_cosign')).toHaveLength(1);
    expect((await verifyChain(chain)).ok).toBe(true);
    expect(await app.db.witness.count({ where: { ledgerId: ledger.id } })).toBe(1);
  });

  it('still allows only one success with ten parallel attempts', async () => {
    const { owner, token, ledger } = await setup();
    const info = (await getInfo(app.client(), token)).body;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        app
          .client()
          .json('POST', `/witness/${token}/sign`, { json: signBody(info, { name: `Saksi ${i}` }) }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 404)).toHaveLength(9);
    const chain = (await owner.json('GET', `/ledgers/${ledger.id}/entries`)).body
      .entries as Entry[];
    expect(chain).toHaveLength(2);
    expect((await verifyChain(chain)).ok).toBe(true);
  });

  it('rejects a wrong signature and a signature over a modified message, without using up the token', async () => {
    const { owner, token, ledger } = await setup();
    const w = app.client();
    const info = (await getInfo(w, token)).body;

    const otherKey = witnessKey('Ed25519');
    const wrongKey = { ...signBody(info), witness_pub: otherKey.pub };
    const renamed = signBody(info, { name: 'Nama Dikirim', signedName: 'Nama Ditandatangani' });
    const retargeted = signBody(info, { signedTarget: 'f'.repeat(64) });
    const flipped = signBody(info);
    const sig = Buffer.from(flipped.signature, 'base64url');
    sig[0]! ^= 1;
    const garbage = { ...signBody(info), signature: randomBytes(64).toString('base64url') };

    for (const [label, body] of [
      ['wrong key', wrongKey],
      ['renamed', renamed],
      ['retargeted', retargeted],
      ['bit flip', { ...flipped, signature: sig.toString('base64url') }],
      ['garbage', garbage],
    ] as const) {
      const res = await w.json('POST', `/witness/${token}/sign`, { json: body });
      expect([label, res.status, res.body.error.code]).toEqual([label, 400, 'SIGNATURE_INVALID']);
    }
    expect(
      (await w.json('POST', `/witness/${token}/sign`, { json: signBody(info, { name: 'Café' }) }))
        .body.error.code,
    ).toBe('INVALID_NAME');
    expect(
      (await w.json('POST', `/witness/${token}/sign`, { json: { ...signBody(info), extra: 1 } }))
        .status,
    ).toBe(400);

    expect((await owner.json('GET', `/ledgers/${ledger.id}`)).body.ledger.head_seq).toBe(0); // nothing appended
    expect((await w.json('POST', `/witness/${token}/sign`, { json: signBody(info) })).status).toBe(
      201,
    ); // token still usable
  });

  it('gives the same answer for unknown, malformed, expired, revoked and used tokens', async () => {
    const { owner, entry, token: used } = await setup();
    const w = app.client();
    expect(
      (
        await w.json('POST', `/witness/${used}/sign`, {
          json: signBody((await getInfo(w, used)).body),
        })
      ).status,
    ).toBe(201);

    const expiredToken = randomBytes(32).toString('base64url');
    const now = Date.now();
    await app.db.witnessInvite.create({
      data: {
        ledgerId: entry.ledger_id,
        targetEntryId: entry.id,
        tokenHash: sha256(expiredToken),
        createdAt: new Date(now - 7_200_000),
        expiresAt: new Date(now - 3_600_000),
      },
    });
    const revoked = await owner.json('POST', `/entries/${entry.id}/witness-invites`, { json: {} });
    await owner.json('DELETE', `/witness-invites/${revoked.body.invite.id}`);

    const tokens = {
      unknown: randomBytes(32).toString('base64url'),
      malformed: 'bukan-token',
      expired: expiredToken,
      revoked: revoked.body.token as string,
      used,
    };
    const answers = new Set<string>();
    for (const [label, token] of Object.entries(tokens)) {
      for (const [method, path] of [
        ['GET', `/witness/${token}`],
        ['POST', `/witness/${token}/sign`],
        ['GET', `/witness/${token}/attachment`],
      ] as const) {
        const res = await app.client().json(method, path, {
          json:
            method === 'POST' ? signBody({ invite: { id: entry.ledger_id }, entry }) : undefined,
        });
        answers.add(JSON.stringify([res.status, res.body.error.code, res.body.error.message]));
        expect([label, method, res.status]).toEqual([label, method, 404]);
      }
    }
    expect(answers.size).toBe(1);
  });

  it('lets the witness view a photo inline', async () => {
    const owner = app.client();
    await owner.register();
    const ledger = (await owner.json('POST', '/ledgers', { json: { title: 'x', category: 'gig' } }))
      .body.ledger;
    const photo = (
      await owner.json('POST', `/ledgers/${ledger.id}/entries/upload`, {
        form: uploadForm('photo', png, 'bukti.png'),
      })
    ).body.entry;
    const { token } = (
      await owner.json('POST', `/entries/${photo.id}/witness-invites`, { json: {} })
    ).body;

    const info = await getInfo(app.client(), token);
    expect(info.body.entry).toMatchObject({
      type: 'photo',
      has_attachment: true,
      payload: { media_type: 'image/png' },
    });
    const img = await app.client().raw('GET', `/witness/${token}/attachment`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(img.headers.get('content-security-policy')).toContain('sandbox');
    expect(sha256(new Uint8Array(await img.arrayBuffer()))).toBe(sha256(png));
  });
});

describe('witness rate limits', () => {
  it('limits requests per token and per IP', async () => {
    const one = await setup(tight);
    const two = await setup(tight);
    const c = tight.client();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await getInfo(c, one.token)).status);
    expect(statuses).toEqual([200, 200, 200, 429]); // per-token budget of 3

    expect((await getInfo(c, two.token)).status).toBe(200); // another token still works…
    const blocked = await getInfo(c, two.token);
    expect([blocked.status, blocked.body.error.code]).toEqual([429, 'RATE_LIMITED']); // …until the IP budget (5) runs out
  });
});
