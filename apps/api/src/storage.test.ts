// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FsStore } from './storage.js';

const root = mkdtempSync(join(tmpdir(), 'pt-fs-'));
const store = new FsStore(root);
const read = async (key: string) => {
  const chunks: Buffer[] = [];
  for await (const c of await store.get(key)) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
};

describe('FsStore', () => {
  it('stores, reads back and deletes a file', async () => {
    await store.put('u/a', Readable.from([Buffer.from('halo '), Buffer.from('dunia')]));
    expect((await read('u/a')).toString()).toBe('halo dunia');
    await store.delete('u/a');
    await expect(store.get('u/a')).rejects.toThrow();
    await store.delete('u/a'); // deleting twice is fine
  });

  it('refuses keys that leave the storage directory', async () => {
    for (const key of ['../escape', 'u/../../escape', '/etc/passwd', 'u/..']) {
      await expect(store.put(key, Readable.from(['x']))).rejects.toThrow('invalid key');
      await expect(store.get(key)).rejects.toThrow('invalid key');
    }
  });

  it('leaves nothing behind when the upload stream fails half way', async () => {
    const broken = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('connection lost');
      })(),
    );
    await expect(store.put('u/b', broken)).rejects.toThrow('connection lost');
    await expect(store.get('u/b')).rejects.toThrow();
    expect(readdirSync(join(root, 'u'))).toEqual([]);
  });
});
