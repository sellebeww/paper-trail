// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ALLOWED_TYPES, sanitizeFilename } from './uploads.js';

describe('sanitizeFilename', () => {
  it.each([
    ['slip gaji.pdf', 'slip gaji.pdf'],
    ['../../etc/passwd', 'etc passwd'],
    ['C:\\Users\\budi\\kontrak.docx', 'C Users budi kontrak.docx'],
    ['  .hidden  ', 'hidden'],
    ['a\u0000b\u001fc.txt', 'a b c.txt'],
    ['foto\u202Egpj.exe', 'foto gpj.exe'],
    ['zero\u200Bwidth.pdf', 'zero width.pdf'],
    ['"quoted"<tag>|pipe?.pdf', 'quoted tag pipe .pdf'],
    ['', 'berkas'],
    [undefined, 'berkas'],
    ['..', 'berkas'],
    ['...', 'berkas'],
  ])('sanitizes %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('keeps Unicode names and normalizes to NFC', () => {
    expect(sanitizeFilename('Kuitansi Café 😀.pdf'.normalize('NFD'))).toBe('Kuitansi Café 😀.pdf');
  });

  it('truncates long names to 120 code points and keeps the extension', () => {
    const name = sanitizeFilename(`${'a'.repeat(300)}.pdf`);
    expect(Array.from(name)).toHaveLength(120);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('never returns a name containing path separators or control characters', () => {
    for (const raw of ['a/b', 'a\\b', 'a\nb', '\u0007bell', 'x\u2066y\u2069']) {
      expect(sanitizeFilename(raw)).not.toMatch(/[/\\\p{Cc}\p{Cf}]/u);
    }
  });
});

describe('ALLOWED_TYPES', () => {
  it('does not allow active or ambiguous content', () => {
    for (const mime of [
      'text/html',
      'image/svg+xml',
      'application/x-msdownload',
      'application/zip',
      'image/gif',
    ]) {
      expect(ALLOWED_TYPES[mime]).toBeUndefined();
    }
  });
});
