// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const examples = resolve(root, 'docs/examples');
const tsx = resolve(root, 'node_modules/.bin/tsx');
const cli = resolve(import.meta.dirname, 'cli.ts');
const roots = join(examples, 'example-tsa-root.pem');

const run = (...args: string[]) => {
  const r = spawnSync(tsx, ['--conditions=source', cli, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout + r.stderr };
};

describe('papertrail-verify on the committed examples', () => {
  it.each(['example-pack.json', 'example-pack.zip'])(
    '%s verifies against the example TSA root (exit 0)',
    (file) => {
      const r = run(join(examples, file), '--roots', roots);
      expect(r.code).toBe(0);
      expect(r.out).toContain('Rantai utuh');
      expect(r.out).toContain('jangkar terverifikasi: 2');
      expect(r.out).toContain('tidak menjamin penerimaan sebagai alat bukti');
    },
  );

  it('the partial example verifies and says it is partial', () => {
    const r = run(join(examples, 'example-pack-partial.json'), '--roots', roots);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Rantai utuh pada rentang yang diekspor');
    expect(r.out).toContain('PARTIAL_PACK');
  });

  it('without roots it still passes but warns that the TSA chain was not checked', () => {
    const r = run(join(examples, 'example-pack.json'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('ANCHOR_UNVERIFIED');
  });

  it('a pack with one changed character fails with exit code 1 and names the entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pt-'));
    const file = join(dir, 'tampered.json');
    writeFileSync(
      file,
      readFileSync(join(examples, 'example-pack.json'), 'utf8').replace(
        'sampai jam 21.00',
        'sampai jam 22.00',
      ),
    );
    const r = run(file, '--roots', roots);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Terputus di entri 0');
    expect(r.out).toContain('PACK_HASH_MISMATCH');
  });

  it('reports usage and input errors with exit code 2', () => {
    expect(run().code).toBe(2);
    expect(run('/nonexistent/pack.json').code).toBe(2);
  });

  it('the example PDF carries the pack hash of the example JSON', () => {
    const pack = JSON.parse(readFileSync(join(examples, 'example-pack.json'), 'utf8')) as {
      pack_hash: string;
    };
    expect(pack.pack_hash).toMatch(/^[0-9a-f]{64}$/);
    // The PDF's text is compressed, but its metadata (Subject) is not: it names the same hash.
    expect(
      readFileSync(join(examples, 'example-pack.pdf')).includes(
        Buffer.from(`pack_hash ${pack.pack_hash}`),
      ),
    ).toBe(true);
  });
});
