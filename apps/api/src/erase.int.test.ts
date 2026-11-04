// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Owner-requested erasure (D11): content goes, the chain and everything that proves it stay verifiable, and the
// database still refuses every other change to an entry.
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { buildWitnessMessage, canonicalize, verifyChain, type Entry } from '@paper-trail/chain';
import { verifyEvidencePack } from '@paper-trail/verifier';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, startTestApp, uploadForm, type TestClient } from '../test/client.js';
import type { MemoryStore } from './storage.js';

type App = Awaited<ReturnType<typeof startTestApp<MemoryStore>>>;
let app: App;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

const TITLE = 'Sengketa lembur PT Contoh';
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(2000)]);

/** An owner with a ledger of: a note (witnessed), a file, another note, and one still-open witness invite. */
const populated = async () => {
  const c = app.client();
  const email = `${randomUUID()}@example.test`;
  await c.register(email);
  const ledger = (await c.json('POST', '/ledgers', { json: { title: TITLE, category: 'kerja' } }))
    .body.ledger;
  const note = (
    await c.json('POST', `/ledgers/${ledger.id}/entries`, {
      json: { type: 'note', text: 'Lembur 4 jam, tidak dibayar.' },
    })
  ).body.entry;
  const file = (
    await c.json('POST', `/ledgers/${ledger.id}/entries/upload`, {
      form: uploadForm('file', pdf(), 'slip.pdf', 'application/pdf'),
    })
  ).body.entry;
  await c.json('POST', `/ledgers/${ledger.id}/entries`, {
    json: { type: 'note', text: 'Catatan akhir.' },
  });

  // A witness signs the first note (what the witness page does in the browser).
  const invite = (await c.json('POST', `/entries/${note.id}/witness-invites`, { json: {} })).body;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x!;
  const signedAt = new Date().toISOString();
  const message = buildWitnessMessage(ledger.id, {
    invite_id: invite.invite.id,
    target_seq: note.seq,
    target_entry_hash: note.entry_hash,
    statement: 'confirm',
    witness_name: 'Siti Rahayu',
    witness_pub: pub,
    alg: 'Ed25519',
    signed_client_time: signedAt,
  });
  const signed = await app.client().json('POST', `/witness/${invite.token}/sign`, {
    json: {
      alg: 'Ed25519',
      witness_pub: pub,
      signature: sign(null, Buffer.from(canonicalize(message)), privateKey).toString('base64url'),
      witness_name: 'Siti Rahayu',
      signed_client_time: signedAt,
    },
  });
  expect(signed.status).toBe(201);
  // A second link nobody has used yet.
  const open = (await c.json('POST', `/entries/${file.id}/witness-invites`, { json: {} })).body;
  return { c, email, ledger, file, openToken: open.token as string };
};

type Listed = Entry & { id: string; erased_at: string | null };
const entriesOf = async (c: TestClient, ledgerId: string) =>
  (await c.json('GET', `/ledgers/${ledgerId}/entries?limit=100`)).body.entries as Listed[];

const erase = (c: TestClient, ledgerId: string, over: Record<string, unknown> = {}) =>
  c.json('POST', `/ledgers/${ledgerId}/erase`, {
    json: { confirm_title: TITLE, password: PASSWORD, ...over },
  });

describe('erasing a ledger', () => {
  it('needs the right password and the typed title, and only the owner can do it', async () => {
    const { c, ledger } = await populated();
    const bad = await erase(c, ledger.id, { password: 'bukan-sandi-saya' });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('PASSWORD_INVALID');
    const wrong = await erase(c, ledger.id, { confirm_title: 'judul lain' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('CONFIRMATION_MISMATCH');
    const stranger = app.client();
    await stranger.register();
    expect((await erase(stranger, ledger.id)).status).toBe(404);
    expect((await erase(app.client(), ledger.id)).status).toBe(401);

    const still = await entriesOf(c, ledger.id);
    expect(still.every((e) => e.erased_at === null && e.payload !== undefined)).toBe(true);
  });

  it('removes content, files, witness identity and open links; keeps every hash and the chain', async () => {
    const { c, ledger, file, openToken } = await populated();
    const before = await entriesOf(c, ledger.id);
    expect(before).toHaveLength(4); // note, file, note, witness co-sign

    const res = await erase(c, ledger.id);
    expect(res.status).toBe(200);
    expect(res.body.erased_entries).toBe(4);

    const after = await entriesOf(c, ledger.id);
    for (const [i, e] of after.entries()) {
      expect(e.erased_at).not.toBeNull();
      expect(e.payload).toBeUndefined();
      expect(e.entry_hash).toBe(before[i]!.entry_hash); // the skeleton is untouched
      expect(e.payload_hash).toBe(before[i]!.payload_hash);
      expect(e.created_at).toBe(before[i]!.created_at);
    }
    expect((await verifyChain(after)).ok).toBe(true);

    expect((await c.json('GET', `/ledgers/${ledger.id}`)).body.ledger.title).toBe('(dihapus)');
    expect((await c.raw('GET', `/entries/${file.id}/attachment`)).status).toBe(404);
    expect(await app.db.attachment.count({ where: { entry: { ledgerId: ledger.id } } })).toBe(0);
    expect(await app.db.witness.count({ where: { ledgerId: ledger.id } })).toBe(0);
    expect((await app.client().json('GET', `/witness/${openToken}`)).status).toBe(404); // link was revoked
    const invites = await app.db.witnessInvite.findMany({ where: { ledgerId: ledger.id } });
    expect(invites.every((i) => i.ownerDisplayName === null)).toBe(true);
  });

  it('exports a pack that still verifies, with the erased content undisclosed', async () => {
    const { c, ledger } = await populated();
    await erase(c, ledger.id);
    const res = await c.json('POST', `/ledgers/${ledger.id}/export`, {
      json: { include_files: false },
    });
    expect(res.status).toBe(200);
    expect(res.body.disclosure.payloads_included).toEqual([]);
    const verdict = await verifyEvidencePack(res.body);
    expect(verdict.verdict).toBe('OK');
    expect(verdict.summary.chain_intact).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('Lembur 4 jam');
    expect(JSON.stringify(res.body)).not.toContain('Siti Rahayu');
  });

  it('can be repeated safely, and the ledger can keep growing afterwards', async () => {
    const { c, ledger } = await populated();
    await erase(c, ledger.id);
    const again = await erase(c, ledger.id, { confirm_title: '(dihapus)' });
    expect(again.status).toBe(200);
    expect(again.body.erased_entries).toBe(0);
    const added = await c.json('POST', `/ledgers/${ledger.id}/entries`, {
      json: { type: 'note', text: 'Catatan baru setelah penghapusan.' },
    });
    expect(added.status).toBe(201);
    const all = await entriesOf(c, ledger.id);
    expect(all.at(-1)!.erased_at).toBeNull();
    expect((await verifyChain(all)).ok).toBe(true);
  });
});

describe('the database still protects everything else', () => {
  const rejected = (sql: Promise<unknown>) => expect(sql).rejects.toThrow(/paper_trail/);

  it('refuses to rewrite, move or delete an entry, before and after erasure', async () => {
    const { c, ledger } = await populated();
    const [first] = await entriesOf(c, ledger.id);
    const id = first!.id;
    const lid = ledger.id as string;
    await rejected(
      app.db
        .$executeRaw`UPDATE entries SET payload = '{"text":"diubah"}'::jsonb WHERE id = ${id}::uuid`,
    );
    await rejected(
      app.db
        .$executeRaw`UPDATE entries SET created_at = created_at + interval '1 day' WHERE id = ${id}::uuid`,
    );
    await rejected(app.db.$executeRaw`UPDATE entries SET erased_at = now() WHERE id = ${id}::uuid`); // payload not emptied
    await rejected(
      app.db
        .$executeRaw`UPDATE entries SET payload = '{}'::jsonb, erased_at = now(), author_ref = 'owner:abc' WHERE id = ${id}::uuid`,
    );
    await rejected(app.db.$executeRaw`DELETE FROM entries WHERE id = ${id}::uuid`);
    await rejected(
      app.db
        .$executeRaw`DELETE FROM attachments WHERE entry_id IN (SELECT id FROM entries WHERE ledger_id = ${lid}::uuid)`,
    );
    await rejected(app.db.$executeRaw`DELETE FROM witnesses WHERE ledger_id = ${lid}::uuid`);

    await erase(c, ledger.id);
    await rejected(
      app.db
        .$executeRaw`UPDATE entries SET payload = '{"text":"balik"}'::jsonb WHERE id = ${id}::uuid`,
    );
    await rejected(app.db.$executeRaw`UPDATE entries SET erased_at = NULL WHERE id = ${id}::uuid`);
    await rejected(app.db.$executeRaw`UPDATE entries SET erased_at = now() WHERE id = ${id}::uuid`); // only once
    await rejected(app.db.$executeRaw`DELETE FROM entries WHERE id = ${id}::uuid`);
  });
});

describe('erasing an account', () => {
  const eraseAccount = (c: TestClient, email: string, over: Record<string, unknown> = {}) =>
    c.json('POST', '/account/erase', {
      json: { confirm_email: email, password: PASSWORD, ...over },
    });

  it('needs the password and the typed email', async () => {
    const { c, email } = await populated();
    expect((await eraseAccount(c, email, { password: 'salah-sekali-kata-sandi' })).status).toBe(
      403,
    );
    const wrong = await eraseAccount(c, 'orang-lain@example.test');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('CONFIRMATION_MISMATCH');
    expect((await c.json('GET', '/auth/me')).status).toBe(200);
  });

  it('erases every ledger, signs everyone out, and leaves no email or usable password behind', async () => {
    const { c, email, ledger } = await populated();
    const second = (
      await c.json('POST', '/ledgers', { json: { title: 'Ledger kedua', category: 'sewa' } })
    ).body.ledger;
    await c.json('POST', `/ledgers/${second.id}/entries`, {
      json: { type: 'note', text: 'Rahasia kedua.' },
    });
    const other = app.client();
    await other.json('POST', '/auth/login', { json: { email, password: PASSWORD } });
    const owner = await app.db.user.findUniqueOrThrow({ where: { email } });

    const res = await eraseAccount(c, email.toUpperCase()); // typing the email in other case is fine
    expect(res.status).toBe(200);
    expect(res.body.erased_ledgers).toBe(2);
    expect((await c.json('GET', '/auth/me')).status).toBe(401);
    expect((await other.json('GET', '/auth/me')).status).toBe(401);
    expect(
      (await app.client().json('POST', '/auth/login', { json: { email, password: PASSWORD } }))
        .status,
    ).toBe(401);

    const gone = await app.db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(gone.email).toBe(`deleted-${owner.id}@erased.invalid`);
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.emailVerifiedAt).toBeNull();
    expect(await app.db.session.count({ where: { userId: owner.id } })).toBe(0);
    const ids = [ledger.id, second.id] as string[];
    expect(await app.db.entry.count({ where: { ledgerId: { in: ids }, erasedAt: null } })).toBe(0);

    // The address is free again.
    expect(
      (await app.client().json('POST', '/auth/register', { json: { email, password: PASSWORD } }))
        .status,
    ).toBe(201);
  });
});
