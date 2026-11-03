// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// docs/VERIFY.md must stay true: its Python script and openssl commands, run without any Paper Trail code, accept the
// example pack and catch every tampered fixture.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const fixtures = resolve(import.meta.dirname, '../fixtures');
const tsaRoot = join(root, 'docs/examples/example-tsa-root.pem');
const available =
  spawnSync('python3', ['--version']).status === 0 &&
  spawnSync('openssl', ['version']).status === 0;

const dir = mkdtempSync(join(tmpdir(), 'pt-verify-doc-'));
const script = join(dir, 'verify_pack.py');
const doc = readFileSync(join(root, 'docs/VERIFY.md'), 'utf8');
writeFileSync(script, /```python\n([\s\S]+?)```/.exec(doc)![1]!);

const python = (pack: string) => {
  const out = mkdtempSync(join(dir, 'out-'));
  const r = spawnSync('python3', ['-I', script, pack, out], { encoding: 'utf8' });
  return { code: r.status, text: r.stdout + r.stderr, out };
};
const openssl = (cwd: string, ...args: string[]) =>
  spawnSync('openssl', args, { cwd, encoding: 'utf8' }).status === 0;
const anchorOk = (out: string, seq: number) =>
  openssl(
    out,
    'ts',
    '-verify',
    '-data',
    `entry-${seq}.envelope.json`,
    '-in',
    `anchor-${seq}.tst`,
    '-token_in',
    '-CAfile',
    tsaRoot,
  );
const witnessOk = (out: string, seq: number) =>
  openssl(
    out,
    'pkeyutl',
    '-verify',
    '-pubin',
    '-inkey',
    `witness-${seq}.pub.pem`,
    '-rawin',
    '-in',
    `witness-${seq}.msg`,
    '-sigfile',
    `witness-${seq}.sig`,
  );

describe.skipIf(!available)('docs/VERIFY.md (Python + OpenSSL, no Paper Trail code)', () => {
  it('accepts the valid pack: chain, both anchors, the witness', () => {
    const r = python(join(fixtures, 'valid.json'));
    expect(r.code).toBe(0);
    expect(r.text).toContain('OK: pack_hash and 6 entries match');
    expect(anchorOk(r.out, 3) && anchorOk(r.out, 5) && witnessOk(r.out, 3)).toBe(true);
  });

  it.each([
    ['entry-modified.json', 'entry 1: payload does not match payload_hash'],
    ['entry-deleted.json', 'entry 4: seq is 5'],
    ['wrong-pack-hash.json', 'pack_hash does not match'],
    ['unknown-version.json', "format_version '2.0' is not 1.0"],
  ])('the script rejects %s', (file, message) => {
    const r = python(join(fixtures, file));
    expect(r.code).toBe(1);
    expect(r.text).toContain(message);
  });

  it('openssl rejects the fake witness signature and the moved anchor token', () => {
    const witness = python(join(fixtures, 'fake-witness.json'));
    expect(witness.code).toBe(0);
    expect(witnessOk(witness.out, 3)).toBe(false);
    const anchor = python(join(fixtures, 'fake-anchor.json'));
    expect(anchor.code).toBe(0);
    expect(anchorOk(anchor.out, 3)).toBe(true);
    expect(anchorOk(anchor.out, 5)).toBe(false);
  });
});
