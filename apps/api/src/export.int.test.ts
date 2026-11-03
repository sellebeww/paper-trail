// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  anchorData,
  buildWitnessMessage,
  canonicalize,
  type Entry,
  type EvidencePack,
} from '@paper-trail/chain';
import { headline, loadPack, verifyEvidencePack } from '@paper-trail/verifier';
import { createMockTsa, fetchMockToken, type MockTsa } from '@paper-trail/verifier/testing';
import { extractText } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, uploadForm, type TestClient } from '../test/client.js';

type App = Awaited<ReturnType<typeof startTestApp>>;
let app: App;
let limited: App;
let tsa: MockTsa;

const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('slip gaji '.repeat(200))]);
const sha256 = (d: Uint8Array) => createHash('sha256').update(d).digest('hex');
const squash = (s: string) => s.replace(/\s+/g, ' ');

interface Fixture {
  owner: TestClient;
  ledgerId: string;
  entries: (Entry & { id: string })[];
}

/** 0 note · 1 note · 2 file · 3 witness cosign of 1 · 4 note · 5 note. Anchors at head 3 and head 5. */
const fixture = async (): Promise<Fixture> => {
  const owner = app.client();
  await owner.register();
  const ledgerId = (
    await owner.json('POST', '/ledgers', {
      json: { title: 'Sengketa lembur Oktober', category: 'kerja' },
    })
  ).body.ledger.id as string;
  const note = (text: string) =>
    owner.json('POST', `/ledgers/${ledgerId}/entries`, { json: { type: 'note', text } });
  await note('Atasan menolak membayar lembur 😡');
  const second = (await note('Budi hadir sebagai saksi.')).body.entry;
  expect(
    (
      await owner.json('POST', `/ledgers/${ledgerId}/entries/upload`, {
        form: uploadForm('file', PDF_BYTES, 'slip gaji.pdf'),
      })
    ).status,
  ).toBe(201);

  // A real witness co-sign through the public flow.
  const invite = (
    await owner.json('POST', `/entries/${second.id}/witness-invites`, {
      json: { owner_display_name: 'Pemilik' },
    })
  ).body;
  const w = app.client();
  const info = (await w.json('GET', `/witness/${invite.token}`)).body;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x!;
  const signed_client_time = new Date().toISOString();
  const message = buildWitnessMessage(info.entry.ledger_id, {
    invite_id: info.invite.id,
    target_seq: info.entry.seq,
    target_entry_hash: info.entry.entry_hash,
    statement: 'confirm',
    witness_name: 'Budi Santoso',
    witness_pub: pub,
    alg: 'Ed25519',
    signed_client_time,
  });
  const signature = sign(null, Buffer.from(canonicalize(message)), privateKey).toString(
    'base64url',
  );
  expect(
    (
      await w.json('POST', `/witness/${invite.token}/sign`, {
        json: {
          alg: 'Ed25519',
          witness_pub: pub,
          signature,
          witness_name: 'Budi Santoso',
          signed_client_time,
        },
      })
    ).status,
  ).toBe(201);
  await note('Catatan keempat.');
  await note('Catatan kelima.');

  const entries = (await owner.json('GET', `/ledgers/${ledgerId}/entries`)).body
    .entries as (Entry & { id: string })[];
  expect(entries.map((e) => e.type)).toEqual([
    'note',
    'note',
    'file',
    'witness_cosign',
    'note',
    'note',
  ]);
  for (const head of [entries[3]!, entries[5]!]) {
    const token = await fetchMockToken(tsa.url, anchorData(head));
    await app.db.anchor.create({
      data: {
        ledgerId,
        anchoredHeadSeq: head.seq,
        anchoredHeadHash: head.entry_hash,
        anchorDigest: head.entry_hash,
        tsaUrl: tsa.url,
        tstToken: new Uint8Array(token),
        tstGenTime: new Date(),
        status: 'ok',
        attempts: 1,
      },
    });
  }
  return { owner, ledgerId, entries };
};

const exportPack = async (f: Fixture, body: Record<string, unknown> = {}) => {
  const res = await f.owner.raw('POST', `/ledgers/${f.ledgerId}/export`, { json: body });
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
};
const verify = (pack: unknown, files?: Map<string, Uint8Array>) =>
  verifyEvidencePack(pack, { trustedCerts: [tsa.caCert], ...(files ? { files } : {}) });
const codes = (r: Awaited<ReturnType<typeof verify>>) => r.findings.map((f) => f.code);

beforeAll(async () => {
  tsa = await createMockTsa();
  [app, limited] = await Promise.all([startTestApp(), startTestApp({ EXPORT_RATE_LIMIT: '2' })]);
});
afterAll(async () => {
  await Promise.all([app.close(), limited.close(), tsa.close()]);
});

describe('POST /ledgers/:id/export (JSON)', () => {
  it('exports a pack that verifies completely: chain, witness signature, pack hash and both anchors', async () => {
    const f = await fixture();
    const { res, bytes } = await exportPack(f);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="paper-trail-[0-9a-f]{8}-0-5\.json"$/,
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    const pack = JSON.parse(bytes.toString('utf8')) as EvidencePack;
    expect(res.headers.get('x-pack-hash')).toBe(pack.pack_hash);
    expect(pack).toMatchObject({
      format_version: '1.0',
      ledger: { id: f.ledgerId, title: 'Sengketa lembur Oktober', category: 'kerja' },
      scope: { from_seq: 0, to_seq: 5, requested_to_seq: 5, ledger_head_seq: 5 },
      head: { seq: 5, hash: f.entries[5]!.entry_hash },
    });
    expect(pack.entries).toHaveLength(6);
    expect(pack.entries[0]!.payload).toEqual({ text: 'Atasan menolak membayar lembur 😡' });
    expect(pack.entries.every((e) => !('id' in e))).toBe(true); // no internal ids leak into the format
    expect(pack.witnesses).toMatchObject([
      { entry_seq: 3, target_seq: 1, witness_name: 'Budi Santoso', alg: 'Ed25519' },
    ]);
    expect(pack.anchors.map((a) => a.head_seq)).toEqual([3, 5]);
    expect(pack.anchors[0]!.certs.length).toBeGreaterThan(0);

    const r = await verify(pack);
    expect(r.verdict).toBe('OK');
    expect(r.summary).toMatchObject({
      entries: 6,
      from_genesis: true,
      witnesses_verified: 1,
      anchors_verified: 2,
      anchored_through_seq: 5,
    });
    expect(codes(r)).not.toContain('PARTIAL_PACK');
    expect(codes(r)).not.toContain('UNANCHORED_TAIL');
    expect(headline(r)).toBe('Rantai utuh');
  });

  it('detects a one-byte change anywhere in the downloaded file', async () => {
    const f = await fixture();
    const { bytes } = await exportPack(f);
    const text = bytes.toString('utf8');
    const stride = Math.max(1, Math.floor(text.length / 250));
    let checked = 0;
    for (let i = 0; i < text.length; i += stride) {
      const mutated =
        text.slice(0, i) + String.fromCharCode(text.charCodeAt(i) ^ 1) + text.slice(i + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(mutated);
      } catch {
        checked++;
        continue;
      }
      // Whitespace between tokens is formatting only; every other byte is covered by pack_hash or the chain.
      if (/^\s$/.test(text[i]!) && JSON.stringify(parsed) === JSON.stringify(JSON.parse(text)))
        continue;
      expect([i, (await verify(parsed)).verdict]).toEqual([i, 'FAILED']);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('is deterministic for a fixed ledger: same selection and generated_at give the same pack_hash', async () => {
    const f = await fixture();
    const a = JSON.parse((await exportPack(f)).bytes.toString('utf8')) as EvidencePack;
    const b = JSON.parse((await exportPack(f)).bytes.toString('utf8')) as EvidencePack;
    expect(a.pack_hash === b.pack_hash).toBe(a.generated_at === b.generated_at);
    expect({ ...a, generated_at: '', pack_hash: '' }).toEqual({
      ...b,
      generated_at: '',
      pack_hash: '',
    });
  });
});

describe('selection and disclosure', () => {
  it('exports a partial range, bridges it to the next anchor with envelope-only entries, and says so', async () => {
    const f = await fixture();
    const { res, bytes } = await exportPack(f, { from_seq: 1, to_seq: 2 });
    expect(res.headers.get('content-disposition')).toMatch(/-1-3\.json"$/);
    const pack = JSON.parse(bytes.toString('utf8')) as EvidencePack;
    expect(pack.scope).toEqual({
      from_seq: 1,
      to_seq: 3,
      first_prev_hash: f.entries[0]!.entry_hash,
      requested_to_seq: 2,
      ledger_head_seq: 5,
    });
    expect(pack.disclosure.payloads_included).toEqual([1, 2]);
    expect(pack.entries[2]!.payload).toBeUndefined(); // seq 3 is a bridge entry: no payload, so no witness details either
    expect(pack.witnesses).toEqual([]);
    expect(pack.anchors.map((a) => a.head_seq)).toEqual([3]);

    const r = await verify(pack);
    expect(r.verdict).toBe('OK');
    expect(r.summary).toMatchObject({
      from_seq: 1,
      to_seq: 3,
      from_genesis: false,
      anchored_through_seq: 3,
    });
    expect(codes(r)).toContain('PARTIAL_PACK');
    expect(headline(r)).toBe('Rantai utuh pada rentang yang diekspor');

    const noBridge = JSON.parse(
      (await exportPack(f, { from_seq: 1, to_seq: 2, anchor_bridge: false })).bytes.toString(
        'utf8',
      ),
    ) as EvidencePack;
    expect(noBridge.scope).toMatchObject({ from_seq: 1, to_seq: 2, requested_to_seq: 2 });
    expect(noBridge.anchors).toEqual([]);
    const rn = await verify(noBridge);
    expect(rn.verdict).toBe('OK');
    expect(codes(rn)).toEqual(expect.arrayContaining(['PARTIAL_PACK', 'NO_ANCHOR']));
  });

  it('a tampered partial pack is still caught', async () => {
    const f = await fixture();
    const pack = JSON.parse(
      (await exportPack(f, { from_seq: 1, to_seq: 2 })).bytes.toString('utf8'),
    ) as EvidencePack;
    pack.entries[1]!.payload = { text: 'diubah' };
    expect((await verify(pack)).verdict).toBe('FAILED');
  });

  it('selects a range by date', async () => {
    const f = await fixture();
    const pack = JSON.parse(
      (
        await exportPack(f, {
          from_date: f.entries[2]!.created_at,
          to_date: f.entries[4]!.created_at,
          anchor_bridge: false,
        })
      ).bytes.toString('utf8'),
    ) as EvidencePack;
    expect(pack.scope).toMatchObject({ from_seq: 2, to_seq: 4 });
    expect((await verify(pack)).verdict).toBe('OK');
  });

  it('withholds payloads and the title on request while the chain still verifies', async () => {
    const f = await fixture();
    const none = JSON.parse(
      (await exportPack(f, { payloads: 'none', include_title: false })).bytes.toString('utf8'),
    ) as EvidencePack;
    expect(none.ledger).toEqual({ id: f.ledgerId, category: 'kerja' });
    expect(none.disclosure.payloads_included).toEqual([]);
    expect(JSON.stringify(none)).not.toMatch(/lembur|Budi|slip gaji|Sengketa/);
    const r = await verify(none);
    expect(r.verdict).toBe('OK');
    expect(r.summary.anchors_verified).toBe(2);

    const some = JSON.parse(
      (await exportPack(f, { payloads: [0, 3] })).bytes.toString('utf8'),
    ) as EvidencePack;
    expect(some.disclosure.payloads_included).toEqual([0, 3]);
    expect(some.witnesses).toHaveLength(1);
    expect(JSON.stringify(some)).not.toContain('Budi hadir');
    expect((await verify(some)).verdict).toBe('OK');
  });

  it('rejects impossible requests', async () => {
    const f = await fixture();
    for (const [body, status, code] of [
      [{ from_seq: 4, to_seq: 2 }, 400, 'INVALID_RANGE'],
      [{ to_seq: 99 }, 400, 'INVALID_RANGE'],
      [{ from_date: '2999-01-01T00:00:00.000Z' }, 400, 'INVALID_RANGE'],
      [{ from_seq: 1, from_date: '2026-01-01T00:00:00.000Z' }, 400, 'VALIDATION_ERROR'],
      [{ format: 'json', include_files: true }, 400, 'VALIDATION_ERROR'],
      [{ payloads: [-1] }, 400, 'VALIDATION_ERROR'],
      [{ surprise: true }, 400, 'VALIDATION_ERROR'],
    ] as const) {
      const res = await f.owner.json('POST', `/ledgers/${f.ledgerId}/export`, { json: body });
      expect([JSON.stringify(body), res.status, res.body.error.code]).toEqual([
        JSON.stringify(body),
        status,
        code,
      ]);
    }
    const empty = (
      await f.owner.json('POST', '/ledgers', { json: { title: 'kosong', category: 'gig' } })
    ).body.ledger.id;
    expect(
      (await f.owner.json('POST', `/ledgers/${empty}/export`, { json: {} })).body.error.code,
    ).toBe('EMPTY_LEDGER');
  });
});

describe('zip with attachments', () => {
  it('bundles pack.json, a README and the files; everything verifies, including file hashes', async () => {
    const f = await fixture();
    const { res, bytes } = await exportPack(f, { include_files: true });
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/\.zip"$/);

    const loaded = loadPack(bytes);
    const pack = loaded.pack as EvidencePack;
    expect(pack.disclosure.files_included).toEqual([sha256(PDF_BYTES)]);
    expect(loaded.files.get(sha256(PDF_BYTES))).toEqual(new Uint8Array(PDF_BYTES));
    const r = await verify(pack, loaded.files);
    expect(r.verdict).toBe('OK');
    expect(codes(r)).not.toContain('FILE_MISSING');
    expect(Buffer.from(bytes).includes(Buffer.from('README.txt'))).toBe(true);
  });

  it('does not ship a file whose entry is not disclosed, and refuses oversized bundles', async () => {
    const f = await fixture();
    const noFile = loadPack((await exportPack(f, { include_files: true, payloads: [0, 1] })).bytes);
    expect(noFile.files.size).toBe(0);
    expect((noFile.pack as EvidencePack).disclosure.files_included).toEqual([]);

    const tiny = await startTestApp({ EXPORT_MAX_FILES_BYTES: '1024' });
    try {
      const o = tiny.client();
      await o.register();
      const id = (await o.json('POST', '/ledgers', { json: { title: 'x', category: 'kerja' } }))
        .body.ledger.id;
      await o.json('POST', `/ledgers/${id}/entries/upload`, {
        form: uploadForm('file', PDF_BYTES, 'besar.pdf'),
      });
      const res = await o.json('POST', `/ledgers/${id}/export`, { json: { include_files: true } });
      expect([res.status, res.body.error.code]).toEqual([413, 'EXPORT_TOO_LARGE']);
      expect((await o.json('POST', `/ledgers/${id}/export`, { json: {} })).status).toBe(200); // without files it is fine
    } finally {
      await tiny.close();
    }
  });
});

describe('GET /ledgers/:id/export.pdf', () => {
  it('is a PDF whose text carries the same pack hash as the JSON pack built with the same generated_at', async () => {
    const f = await fixture();
    const json = await exportPack(f, { from_seq: 0, to_seq: 5 });
    const pack = JSON.parse(json.bytes.toString('utf8')) as EvidencePack;

    const res = await f.owner.raw(
      'GET',
      `/ledgers/${f.ledgerId}/export.pdf?from_seq=0&to_seq=5&generated_at=${encodeURIComponent(pack.generated_at)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/\.pdf"$/);
    expect(res.headers.get('x-pack-hash')).toBe(pack.pack_hash);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');

    const text = squash((await extractText(new Uint8Array(buf), { mergePages: true })).text);
    expect(text).toContain(pack.pack_hash);
    expect(text).toContain(pack.head.hash);
    for (const e of pack.entries) expect(text).toContain(e.entry_hash.slice(0, 8));
    expect(text).toContain('Sengketa lembur Oktober');
    expect(text).toContain('Budi Santoso menyaksikan catatan nomor 1');
    expect(text).toContain(
      'Paper Trail membantu membuktikan bahwa catatan tidak diubah setelah dibuat dan kapan catatan itu ada. Ini bukan nasihat hukum dan tidak menjamin penerimaan sebagai alat bukti. Konsultasikan dengan pendamping hukum.',
    );
    expect(text).not.toMatch(/pasti sah|dijamin (sah|diterima)/i);
  });

  it('honours range, disclosure and title options and validates generated_at', async () => {
    const f = await fixture();
    const res = await f.owner.raw(
      'GET',
      `/ledgers/${f.ledgerId}/export.pdf?from_seq=1&to_seq=2&payloads=none&include_title=false`,
    );
    expect(res.status).toBe(200);
    const text = squash(
      (await extractText(new Uint8Array(await res.arrayBuffer()), { mergePages: true })).text,
    );
    expect(text).toContain('Ekspor sebagian');
    expect(text).toContain('(isi tidak disertakan)');
    expect(text).not.toMatch(/Sengketa lembur|Budi hadir/);

    const bad = async (q: string) =>
      (await f.owner.json('GET', `/ledgers/${f.ledgerId}/export.pdf?${q}`)).status;
    expect(
      await bad(
        `generated_at=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`,
      ),
    ).toBe(400);
    expect(
      await bad(
        `generated_at=${encodeURIComponent(new Date(Date.now() - 60 * 86_400_000).toISOString())}`,
      ),
    ).toBe(400);
    expect(await bad('payloads=abc')).toBe(400);
    expect(await bad('from_seq=3&to_seq=1')).toBe(400);
  });
});

describe('access control and limits', () => {
  it('requires login and ownership, and a CSRF token for the POST', async () => {
    const f = await fixture();
    const anon = app.client();
    await anon.raw('GET', '/auth/csrf');
    expect((await anon.json('POST', `/ledgers/${f.ledgerId}/export`, { json: {} })).status).toBe(
      401,
    );
    expect((await anon.json('GET', `/ledgers/${f.ledgerId}/export.pdf`)).status).toBe(401);

    const stranger = app.client();
    await stranger.register();
    expect(
      (await stranger.json('POST', `/ledgers/${f.ledgerId}/export`, { json: {} })).status,
    ).toBe(404);
    expect((await stranger.json('GET', `/ledgers/${f.ledgerId}/export.pdf`)).status).toBe(404);
    expect(
      (await f.owner.json('POST', `/ledgers/${f.ledgerId}/export`, { json: {}, csrf: false }))
        .status,
    ).toBe(403);
    expect(
      (await f.owner.json('POST', `/ledgers/${randomUUID()}/export`, { json: {} })).status,
    ).toBe(404);
  });

  it('rate limits exports', async () => {
    const o = limited.client();
    await o.register();
    const id = (await o.json('POST', '/ledgers', { json: { title: 'x', category: 'kerja' } })).body
      .ledger.id;
    await o.json('POST', `/ledgers/${id}/entries`, { json: { type: 'note', text: 'a' } });
    const statuses = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await o.json('POST', `/ledgers/${id}/export`, { json: {} })).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});
