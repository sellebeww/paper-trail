// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Uploads through the real API with the filesystem store (the default for local runs and the Docker image).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FsStore } from './storage.js';
import { startTestApp, uploadForm } from '../test/client.js';

const dir = mkdtempSync(join(tmpdir(), 'pt-fs-int-'));
let app: Awaited<ReturnType<typeof startTestApp<FsStore>>>;
beforeAll(async () => {
  app = await startTestApp({}, () => new FsStore(dir));
});
afterAll(() => app.close());

describe('filesystem object store', () => {
  it('keeps the uploaded bytes on disk under a random key and serves them back', async () => {
    const c = app.client();
    await c.register();
    const { body } = await c.json('POST', '/ledgers', {
      json: { title: 'Uji disk', category: 'kerja' },
    });
    const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(50_000)]);
    const res = await c.json('POST', `/ledgers/${body.ledger.id}/entries/upload`, {
      form: uploadForm('file', bytes, 'slip.pdf', 'application/pdf'),
    });
    expect(res.status).toBe(201);

    const attachment = await app.db.attachment.findFirstOrThrow({
      where: { entryId: res.body.entry.id },
    });
    const onDisk = join(dir, attachment.storageKey);
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk).equals(bytes)).toBe(true);
    expect(readdirSync(join(dir, 'u')).filter((f) => f.endsWith('.part'))).toEqual([]);

    const download = await c.raw('GET', `/entries/${res.body.entry.id}/attachment`);
    expect(download.status).toBe(200);
    const got = new Uint8Array(await download.arrayBuffer());
    expect(createHash('sha256').update(got).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
  });

  it('leaves no file behind when the upload is rejected', async () => {
    const c = app.client();
    await c.register();
    const { body } = await c.json('POST', '/ledgers', {
      json: { title: 'Uji tolak', category: 'kerja' },
    });
    const before = readdirSync(join(dir, 'u')).length;
    const res = await c.json('POST', `/ledgers/${body.ledger.id}/entries/upload`, {
      form: uploadForm('file', Buffer.from('#!/bin/sh\necho hi\n'), 'x.sh', 'application/pdf'),
    });
    expect(res.status).toBe(415);
    expect(readdirSync(join(dir, 'u')).length).toBe(before);
  });
});
