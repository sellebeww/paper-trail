// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { computePayloadHash, verifyChain, type Entry } from '@paper-trail/chain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ORIGIN,
  PASSWORD,
  png,
  startTestApp,
  uploadForm,
  type TestClient,
} from '../test/client.js';

type App = Awaited<ReturnType<typeof startTestApp>>;
let app: App;
let small: App; // UPLOAD_MAX_BYTES = 20000
let limited: App; // AUTH_RATE_LIMIT = 3

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const pdf = (size: number) => Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(size)]);
const jpeg = (size: number) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]),
    Buffer.alloc(size),
  ]);

const newLedger = async (c: TestClient, title = 'Sengketa lembur') => {
  const res = await c.json('POST', '/ledgers', { json: { title, category: 'kerja' } });
  expect(res.status).toBe(201);
  return res.body.ledger.id as string;
};
const addNote = (c: TestClient, ledgerId: string, text: string) =>
  c.json('POST', `/ledgers/${ledgerId}/entries`, { json: { type: 'note', text } });

beforeAll(async () => {
  [app, small, limited] = await Promise.all([
    startTestApp(),
    startTestApp({ UPLOAD_MAX_BYTES: '20000' }),
    startTestApp({ AUTH_RATE_LIMIT: '3' }),
  ]);
});
afterAll(async () => {
  await Promise.all([app.close(), small.close(), limited.close()]);
});

describe('authentication', () => {
  it('registers with argon2id, sets hardened cookies, and stores only a hash of the session token', async () => {
    const c = app.client();
    const email = `Budi.${randomUUID()}@Example.Test`;
    const res = await c.json('POST', '/auth/register', { json: { email, password: PASSWORD } });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email.toLowerCase());
    expect(JSON.stringify(res.body)).not.toContain('password');

    const cookies = (await c.raw('GET', '/auth/csrf')).headers.getSetCookie().join('\n') || '';
    const user = await app.db.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);

    const session = await app.db.session.findFirstOrThrow({ where: { userId: user.id } });
    const token = c.jar.get('pt_session')!;
    expect(session.tokenHash).toBe(sha256(Buffer.from(token)));
    expect(session.tokenHash).not.toContain(token);
    void cookies;
  });

  it('marks the session cookie httpOnly + SameSite=Lax and the CSRF cookie readable', async () => {
    const c = app.client();
    const res = await c.raw('POST', '/auth/register', {
      json: { email: `${randomUUID()}@example.test`, password: PASSWORD },
      headers: {},
    });
    const set = res.headers.getSetCookie();
    const session = set.find((s) => s.startsWith('pt_session='))!;
    const csrf = set.find((s) => s.startsWith('pt_csrf='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(csrf).toMatch(/SameSite=Lax/i);
  });

  it('logs in, serves /auth/me, and logs out (the session stops working server-side)', async () => {
    const reg = app.client();
    const { email } = await reg.register();
    const c = app.client();
    const login = await c.json('POST', '/auth/login', {
      json: { email: email.toUpperCase(), password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect((await c.json('GET', '/auth/me')).body.user.email).toBe(email);

    const stolen = c.jar.get('pt_session')!;
    expect((await c.json('POST', '/auth/logout')).status).toBe(204);
    expect((await c.json('GET', '/auth/me')).status).toBe(401);

    // Replaying the old cookie must fail: logout deleted the session row.
    const replay = app.client();
    replay.jar.set('pt_session', stolen);
    expect((await replay.json('GET', '/auth/me')).status).toBe(401);
  });

  it('gives the same generic error for a wrong password and an unknown email', async () => {
    const c = app.client();
    const { email } = await c.register();
    const wrong = await app
      .client()
      .json('POST', '/auth/login', { json: { email, password: 'salah-salah-1' } });
    const unknown = await app.client().json('POST', '/auth/login', {
      json: { email: `${randomUUID()}@example.test`, password: 'salah-salah-1' },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe(unknown.body.error.code);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('rejects duplicate emails, short passwords and unknown fields', async () => {
    const c = app.client();
    const { email } = await c.register();
    expect(
      (await app.client().json('POST', '/auth/register', { json: { email, password: PASSWORD } }))
        .status,
    ).toBe(409);
    expect(
      (
        await app
          .client()
          .json('POST', '/auth/register', { json: { email: 'x@example.test', password: 'pendek' } })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.client().json('POST', '/auth/register', {
          json: { email: 'y@example.test', password: PASSWORD, admin: true },
        })
      ).status,
    ).toBe(400);
  });

  it('expires sessions server-side', async () => {
    const c = app.client();
    const { user } = await c.register();
    expect((await c.json('GET', '/auth/me')).status).toBe(200);
    const now = Date.now();
    await app.db.session.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(now - 7_200_000), expiresAt: new Date(now - 3_600_000) },
    });
    expect((await c.json('GET', '/auth/me')).status).toBe(401);
  });

  it('requires login for every ledger endpoint', async () => {
    const c = app.client();
    await c.raw('GET', '/auth/csrf');
    const id = randomUUID();
    for (const [method, path] of [
      ['GET', '/ledgers'],
      ['POST', '/ledgers'],
      ['GET', `/ledgers/${id}`],
      ['GET', `/ledgers/${id}/head`],
      ['GET', `/ledgers/${id}/entries`],
      ['POST', `/ledgers/${id}/entries`],
      ['POST', `/ledgers/${id}/entries/upload`],
      ['GET', `/entries/${id}/attachment`],
    ] as const) {
      const res = await c.json(method, path, { json: method === 'POST' ? {} : undefined });
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
  });
});

describe('CSRF', () => {
  it('rejects state-changing requests without a matching token, even when logged in', async () => {
    const c = app.client();
    await c.register();
    const body = { json: { title: 'x', category: 'kerja' } };
    expect((await c.json('POST', '/ledgers', { ...body, csrf: false })).status).toBe(403);
    expect(
      (
        await c.json('POST', '/ledgers', {
          ...body,
          csrf: false,
          headers: { 'x-csrf-token': 'tebakan' },
        })
      ).status,
    ).toBe(403);
    expect((await c.json('POST', '/ledgers', body)).status).toBe(201);
  });

  it('rejects a foreign Origin even with a valid token, and protects login too', async () => {
    const c = app.client();
    await c.register();
    const res = await c.json('POST', '/ledgers', {
      json: { title: 'x', category: 'kerja' },
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    const ok = await c.json('POST', '/ledgers', {
      json: { title: 'x', category: 'kerja' },
      headers: { origin: ORIGIN },
    });
    expect(ok.status).toBe(201);
    expect(
      (
        await app.client().json('POST', '/auth/login', {
          json: { email: 'a@example.test', password: PASSWORD },
          csrf: false,
        })
      ).status,
    ).toBe(403);
  });
});

describe('ledgers and note entries', () => {
  it('creates a ledger, appends notes, and returns the full entry plus the new head', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);

    const empty = await c.json('GET', `/ledgers/${id}/head`);
    expect(empty.body).toMatchObject({ ledger_id: id, head_seq: null, head_hash: null });

    const first = await addNote(c, id, 'Atasan menolak membayar lembur.');
    expect(first.status).toBe(201);
    expect(first.body.entry).toMatchObject({
      seq: 0,
      type: 'note',
      payload: { text: 'Atasan menolak membayar lembur.' },
    });
    expect(first.body.head).toMatchObject({ head_seq: 0, head_hash: first.body.entry.entry_hash });
    expect(first.headers.get('x-ledger-head-seq')).toBe('0');
    expect(first.headers.get('x-ledger-head-hash')).toBe(first.body.entry.entry_hash);

    const second = await addNote(c, id, 'Saksi: Budi.');
    expect(second.body.entry.prev_hash).toBe(first.body.entry.entry_hash);

    const head = await c.json('GET', `/ledgers/${id}/head`);
    expect(head.body).toMatchObject({ head_seq: 1, head_hash: second.body.entry.entry_hash });
    expect(head.body.head_created_at).toBe(second.body.entry.created_at);
    expect(Date.parse(head.body.server_time)).toBeGreaterThanOrEqual(
      Date.parse(second.body.entry.created_at),
    );

    const detail = await c.json('GET', `/ledgers/${id}`);
    expect(detail.body.ledger).toMatchObject({
      head_seq: 1,
      head_hash: second.body.entry.entry_hash,
      category: 'kerja',
    });
    expect(detail.body.last_anchor).toBeNull();
    expect(
      (await c.json('GET', '/ledgers')).body.ledgers.map((l: { id: string }) => l.id),
    ).toContain(id);
  });

  it('exposes the latest anchor status on the ledger', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);
    const entry = (await addNote(c, id, 'a')).body.entry;
    await app.db.anchor.create({
      data: {
        ledgerId: id,
        anchoredHeadSeq: 0,
        anchoredHeadHash: entry.entry_hash,
        anchorDigest: 'd'.repeat(64),
        tsaUrl: 'https://tsa.invalid/',
        attempts: 2,
      },
    });
    const detail = (await c.json('GET', `/ledgers/${id}`)).body;
    expect(detail.last_anchor).toMatchObject({
      status: 'pending',
      anchored_head_seq: 0,
      attempts: 2,
      gen_time: null,
    });
    expect(detail.last_confirmed_anchor).toBeNull();
  });

  it('normalizes text to NFC before hashing and keeps the chain verifiable', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);
    const res = await addNote(c, id, 'Café 😀');
    expect(res.body.entry.payload.text).toBe('Café 😀');
    const list = await c.json('GET', `/ledgers/${id}/entries`);
    expect((await verifyChain(list.body.entries as Entry[])).ok).toBe(true);
  });

  it('validates input and never leaks internals', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);
    for (const body of [
      { type: 'note', text: '' },
      { type: 'note', text: '   ' },
      { type: 'note', text: 'a\u0000b' },
      { type: 'note', text: 'x', extra: 1 },
      { type: 'photo', text: 'x' },
      { type: 'note' },
    ]) {
      const res = await c.json('POST', `/ledgers/${id}/entries`, { json: body });
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    // Raw bodies: a lone surrogate escape and broken JSON.
    const rawPost = async (body: string) => {
      return fetch(`${app.base}/ledgers/${id}/entries`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; '),
          'x-csrf-token': c.jar.get('pt_csrf')!,
        },
        body,
      });
    };
    expect((await rawPost('{"type":"note","text":"\\ud800"}')).status).toBe(400);
    const broken = await rawPost('{not json');
    const brokenBody = await broken.text();
    expect(broken.status).toBe(400);
    expect(brokenBody).toContain('INVALID_JSON');
    expect(brokenBody).not.toMatch(/stack|node_modules|SyntaxError/);

    expect((await c.json('GET', '/ledgers/not-a-uuid')).status).toBe(400);
    expect(
      (await c.json('POST', '/ledgers', { json: { title: 'x', category: 'bukan-kategori' } }))
        .status,
    ).toBe(400);
    expect((await c.json('GET', '/tidak-ada')).body.error.code).toBe('NOT_FOUND');
  });

  it('has no way to edit or delete an entry or a ledger (by design)', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);
    const entry = (await addNote(c, id, 'asli')).body.entry;
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      for (const path of [
        `/ledgers/${id}`,
        `/ledgers/${id}/entries`,
        `/ledgers/${id}/entries/0`,
        `/ledgers/${id}/entries/${entry.id}`,
        `/entries/${entry.id}`,
        `/entries/${entry.id}/attachment`,
      ]) {
        const res = await c.json(method, path, { json: { text: 'diubah' } });
        expect([method, path, res.status]).toEqual([method, path, 404]);
      }
    }
    expect((await c.json('GET', `/ledgers/${id}/entries`)).body.entries[0].payload.text).toBe(
      'asli',
    );
  });
});

describe('authorization', () => {
  it("never lets user B see or touch user A's ledger", async () => {
    const a = app.client();
    const b = app.client();
    await a.register();
    await b.register();
    const id = await newLedger(a, 'Rahasia A');
    const note = (await addNote(a, id, 'catatan rahasia')).body.entry;
    const file = pdf(500);
    const up = await a.json('POST', `/ledgers/${id}/entries/upload`, {
      form: uploadForm('file', file, 'rahasia.pdf'),
    });
    expect(up.status).toBe(201);
    const objectsBefore = app.store.objects.size;

    const attempts: [string, string, Record<string, unknown>?][] = [
      ['GET', `/ledgers/${id}`],
      ['GET', `/ledgers/${id}/head`],
      ['GET', `/ledgers/${id}/entries`],
      ['POST', `/ledgers/${id}/entries`, { json: { type: 'note', text: 'sisipan B' } }],
      ['GET', `/entries/${up.body.entry.id}/attachment`],
    ];
    for (const [method, path, opts] of attempts) {
      const res = await b.json(method, path, opts);
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(JSON.stringify(res.body)).not.toMatch(/Rahasia A|catatan rahasia|rahasia\.pdf/);
    }
    const upload = await b.json('POST', `/ledgers/${id}/entries/upload`, {
      form: uploadForm('file', pdf(500), 'b.pdf'),
    });
    expect(upload.status).toBe(404);
    expect(app.store.objects.size).toBe(objectsBefore); // B's bytes were never stored

    expect((await b.json('GET', '/ledgers')).body.ledgers).toEqual([]);
    expect((await a.json('GET', `/ledgers/${id}/entries`)).body.entries).toHaveLength(2);
    expect(note.seq).toBe(0);
  });
});

describe('uploads', () => {
  it('stores the file under a random key and the entry hashes the file content and metadata', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);
    const bytes = pdf(200_000);
    const res = await c.json('POST', `/ledgers/${id}/entries/upload`, {
      form: uploadForm('file', bytes, 'Slip gaji Oktober.pdf', 'application/pdf'),
    });
    expect(res.status).toBe(201);

    const { entry } = res.body;
    expect(entry.type).toBe('file');
    expect(entry.payload).toEqual({
      content_sha256: sha256(bytes),
      size: bytes.length,
      media_type: 'application/pdf',
      name: 'Slip gaji Oktober.pdf',
    });
    expect(entry.payload_hash).toBe(computePayloadHash(entry.payload));

    const attachment = await app.db.attachment.findFirstOrThrow({ where: { entryId: entry.id } });
    expect(attachment.storageKey).toMatch(/^u\/[0-9a-f-]{36}$/);
    expect(attachment.storageKey).not.toContain(entry.payload.content_sha256);
    expect(attachment.sha256).toBe(sha256(bytes));
    expect(sha256(app.store.objects.get(attachment.storageKey)!.data)).toBe(sha256(bytes)); // bytes at rest match

    const download = await c.raw('GET', `/entries/${entry.id}/attachment`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('content-disposition')).toMatch(
      /^attachment; filename="Slip gaji Oktober.pdf"/,
    );
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(sha256(new Uint8Array(await download.arrayBuffer()))).toBe(sha256(bytes));

    const list = await c.json('GET', `/ledgers/${id}/entries`);
    expect((await verifyChain(list.body.entries as Entry[])).ok).toBe(true);
  });

  it('accepts a photo, ignores the claimed MIME type, and keeps an optional caption', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);
    const res = await c.json('POST', `/ledgers/${id}/entries/upload`, {
      form: uploadForm('photo', png, 'foto.txt', 'text/plain', 'Jam kerja di papan'),
    });
    expect(res.status).toBe(201);
    expect(res.body.entry.type).toBe('photo');
    expect(res.body.entry.payload).toEqual({
      content_sha256: sha256(png),
      size: png.length,
      media_type: 'image/png',
      caption: 'Jam kerja di papan',
    });
  });

  it('sanitizes file names', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);
    const res = await c.json('POST', `/ledgers/${id}/entries/upload`, {
      form: uploadForm('file', pdf(100), '../../etc/pass‮wd.pdf'),
    });
    // busboy already drops the directory part ("../../etc/"); we then strip the bidi override.
    expect(res.body.entry.payload.name).toBe('pass wd.pdf');
  });

  it('rejects disallowed content by magic bytes, whatever the name or claimed type says', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 0x90)]);
    const objectsBefore = app.store.objects.size;
    const cases: [string, FormData][] = [
      ['exe renamed .jpg claiming image/jpeg', uploadForm('photo', exe, 'foto.jpg', 'image/jpeg')],
      ['exe as file', uploadForm('file', exe, 'kontrak.pdf', 'application/pdf')],
      [
        'html named .pdf',
        uploadForm(
          'file',
          Buffer.from('<html><script>alert(1)</script></html>'),
          'a.pdf',
          'application/pdf',
        ),
      ],
      [
        'svg',
        uploadForm(
          'file',
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          'a.svg',
          'image/svg+xml',
        ),
      ],
      ['plain text', uploadForm('file', Buffer.from('halo'), 'a.pdf', 'application/pdf')],
      [
        'gif (not on the allow-list)',
        uploadForm(
          'photo',
          Buffer.from('GIF89a\u0001\u0000\u0001\u0000', 'latin1'),
          'a.gif',
          'image/gif',
        ),
      ],
      ['pdf declared as photo', uploadForm('photo', pdf(100), 'a.jpg', 'image/jpeg')],
    ];
    for (const [label, form] of cases) {
      const res = await c.json('POST', `/ledgers/${id}/entries/upload`, { form });
      expect([label, res.status, res.body.error?.code]).toEqual([
        label,
        415,
        'UNSUPPORTED_FILE_TYPE',
      ]);
    }
    expect(app.store.objects.size).toBe(objectsBefore); // rejected before any byte was stored
    expect((await c.json('GET', `/ledgers/${id}`)).body.ledger.head_seq).toBeNull();
  });

  it('rejects malformed uploads', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);
    const post = (form: FormData) => c.json('POST', `/ledgers/${id}/entries/upload`, { form });

    const objectsBefore = app.store.objects.size;
    const noType = new FormData();
    noType.set('file', new Blob([png]), 'a.png');
    expect((await post(noType)).status).toBe(400);

    const badType = uploadForm('note', png, 'a.png');
    expect((await post(badType)).status).toBe(400);

    const noFile = new FormData();
    noFile.set('type', 'file');
    expect((await post(noFile)).status).toBe(400);

    const empty = uploadForm('file', new Uint8Array(0), 'a.pdf');
    expect((await post(empty)).status).toBe(400);

    expect((await c.json('POST', `/ledgers/${id}/entries/upload`, { json: { a: 1 } })).status).toBe(
      415,
    );
    expect(app.store.objects.size).toBe(objectsBefore);
  });

  it('rejects files over the size limit and leaves nothing behind', async () => {
    const c = small.client();
    await c.register();
    const id = await newLedger(c);
    const tooBig = await c.json('POST', `/ledgers/${id}/entries/upload`, {
      form: uploadForm('photo', jpeg(30_000), 'besar.jpg'),
    });
    expect([tooBig.status, tooBig.body.error.code]).toEqual([413, 'FILE_TOO_LARGE']);
    expect(small.store.objects.size).toBe(0);

    const ok = await c.json('POST', `/ledgers/${id}/entries/upload`, {
      form: uploadForm('photo', jpeg(10_000), 'kecil.jpg'),
    });
    expect(ok.status).toBe(201);
    expect(small.store.objects.size).toBe(1);
    expect((await c.json('GET', `/ledgers/${id}`)).body.ledger.head_seq).toBe(0);
  });
});

describe('pagination', () => {
  it('is stable while entries are appended concurrently: no gaps, no repeats, chain verifies', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);
    for (let i = 0; i < 10; i++) expect((await addNote(c, id, `awal ${i}`)).status).toBe(201);

    const seen: Entry[] = [];
    let cursor: number | null = null;
    let pages = 0;
    do {
      const query: string = `limit=4${cursor === null ? '' : `&cursor=${cursor}`}`;
      // Fire appends at the same moment as each page request.
      const [page] = await Promise.all([
        c.json('GET', `/ledgers/${id}/entries?${query}`),
        pages < 3
          ? Promise.all([
              addNote(c, id, `paralel ${pages}-a`),
              addNote(c, id, `paralel ${pages}-b`),
            ])
          : undefined,
      ]);
      expect(page.status).toBe(200);
      seen.push(...(page.body.entries as Entry[]));
      cursor = page.body.next_cursor;
      pages++;
    } while (cursor !== null && pages < 50);

    expect(seen.map((e) => e.seq)).toEqual(Array.from({ length: seen.length }, (_, i) => i));
    expect(seen).toHaveLength(16);
    expect((await verifyChain(seen)).ok).toBe(true);
    expect((await c.json('GET', `/ledgers/${id}/head`)).body.head_seq).toBe(15);
  });

  it('validates the cursor and limit', async () => {
    const c = app.client();
    await c.register();
    const id = await newLedger(c);
    for (const q of ['limit=0', 'limit=101', 'cursor=-1', 'cursor=abc', 'limit=1.5']) {
      expect([q, (await c.json('GET', `/ledgers/${id}/entries?${q}`)).status]).toEqual([q, 400]);
    }
  });
});

describe('rate limiting', () => {
  it('blocks repeated login attempts with 429 and a Retry-After hint', async () => {
    const c = limited.client();
    const email = `${randomUUID()}@example.test`;
    const attempt = () =>
      c.json('POST', '/auth/login', { json: { email, password: 'salah-salah-1' } });
    expect([(await attempt()).status, (await attempt()).status, (await attempt()).status]).toEqual([
      401, 401, 401,
    ]);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    // register shares the strict budget
    expect(
      (await c.json('POST', '/auth/register', { json: { email, password: PASSWORD } })).status,
    ).toBe(429);
  });

  it('applies a general limit to the rest of the API', async () => {
    const tight = await startTestApp({ API_RATE_LIMIT: '5' });
    try {
      const c = tight.client();
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await c.json('GET', '/ledgers')).status);
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(statuses.slice(5)).toEqual([429, 429]);
      expect((await fetch(`${tight.base}/health`)).status).toBe(200); // health stays reachable for probes
    } finally {
      await tight.close();
    }
  });
});
