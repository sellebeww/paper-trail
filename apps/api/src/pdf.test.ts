// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  buildEntry,
  buildEvidencePack,
  buildWitnessMessage,
  canonicalize,
  witnessAuthorRef,
  type Entry,
  type EvidencePack,
  type PayloadObject,
} from '@paper-trail/chain';
import { extractText } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { latin1, LEGAL_DISCLAIMER, renderPackPdf, summarize, verifyUrl } from './pdf.js';

const LEDGER = '6f1c0a52-3d1e-4b0a-9f55-0c7d6a2e8b11';
const t = (n: number) => new Date(Date.UTC(2026, 10, 3, 8, 0, n)).toISOString();

const BASE: Entry[] = (() => {
  const out: Entry[] = [];
  const push = (type: Entry['type'], payload: PayloadObject, author = 'owner:9d2f4c1a') =>
    out.push(
      buildEntry(
        { ledger_id: LEDGER, type, created_at: t(out.length), author_ref: author, payload },
        out.at(-1) ?? null,
      ),
    );
  push('note', { text: 'Atasan menolak membayar lembur 😡 Rp1.500.000' });
  push('file', {
    content_sha256: 'ab'.repeat(32),
    size: 20480,
    media_type: 'application/pdf',
    name: 'slip gaji Oktober.pdf',
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x!;
  const unsigned = {
    invite_id: '1d6e3c9a-8b2f-4c71-9a0e-5f4d3c2b1a09',
    target_seq: 0,
    target_entry_hash: out[0]!.entry_hash,
    statement: 'confirm' as const,
    witness_name: 'Siti Rahayu',
    witness_pub: pub,
    alg: 'Ed25519' as const,
    signed_client_time: t(2),
  };
  const signature = sign(
    null,
    Buffer.from(canonicalize(buildWitnessMessage(LEDGER, unsigned))),
    privateKey,
  ).toString('base64url');
  push(
    'witness_cosign',
    { ...unsigned, signature } as unknown as PayloadObject,
    witnessAuthorRef(pub),
  );
  for (let i = 3; i < 150; i++) push('note', { text: `catatan harian nomor ${i}` });
  return out;
})();

const pack = (
  count = 6,
  over: Partial<Parameters<typeof buildEvidencePack>[0]> = {},
): EvidencePack => {
  const entries = structuredClone(BASE).slice(0, count);
  const head = entries.at(-1)!;
  return buildEvidencePack({
    generatedAt: t(600),
    generator: { name: 'paper-trail', version: '0.0.0' },
    ledger: { id: LEDGER, title: 'Sengketa lembur Oktober', category: 'kerja' },
    entries,
    requestedToSeq: head.seq,
    ledgerHeadSeq: head.seq,
    payloads: 'all',
    anchors: [
      {
        v: 1,
        ledger_id: LEDGER,
        head_seq: head.seq,
        head_hash: head.entry_hash,
        anchor_digest: head.entry_hash,
        tsa_label: 'http://tsa.example.test/tsr',
        tst: 'dG9rZW4',
        certs: ['QQ'],
        gen_time: t(300),
      },
    ],
    ...over,
  });
};

const squash = (s: string) => s.replace(/\s+/g, ' ');
const textOf = async (buf: Buffer) =>
  squash((await extractText(new Uint8Array(buf), { mergePages: true })).text);

describe('renderPackPdf', () => {
  it('contains the cover facts, the full hashes, the table, witnesses, anchors and the exact disclaimer', async () => {
    const p = pack();
    const buf = await renderPackPdf(p, 'https://app.example.test/');
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = await textOf(buf);

    expect(text).toContain('Ringkasan Paket Bukti');
    expect(text).toContain('Sengketa lembur Oktober');
    expect(text).toContain(p.pack_hash);
    expect(text).toContain(p.head.hash);
    for (const e of p.entries) expect(text).toContain(e.entry_hash.slice(0, 8));
    expect(text).toContain('2026-11-03 08:00:00 UTC');
    expect(text).toContain('2026-11-03 08:05:00 UTC'); // last anchor time (gen_time)
    expect(text).toContain('Siti Rahayu menyaksikan catatan nomor 0');
    expect(text).toContain('tsa.example.test');
    expect(text).toContain(squash(LEGAL_DISCLAIMER));
    // The URL may wrap across lines, so compare without any whitespace.
    expect(text.replace(/\s/g, '')).toContain(verifyUrl('https://app.example.test/', p.pack_hash));
  });

  it('never claims legal validity', async () => {
    const text = await textOf(await renderPackPdf(pack(), 'https://app.example.test'));
    expect(text).not.toMatch(/pasti sah|dijamin (sah|diterima)/i);
    expect(text).toContain('tidak menjamin penerimaan sebagai alat bukti');
    expect(text).toContain('TIDAK dibuktikan: bahwa isi catatan itu benar');
  });

  it('embeds a QR code image', async () => {
    const buf = await renderPackPdf(pack(), 'https://app.example.test');
    expect(buf.includes('/Subtype /Image')).toBe(true);
  });

  it('puts the pack hash on every page and paginates long ledgers without losing rows', async () => {
    const p = pack(150);
    const buf = await renderPackPdf(p, 'https://app.example.test');
    const { text: pages, totalPages } = await extractText(new Uint8Array(buf));
    expect(totalPages).toBeGreaterThan(3);
    expect(totalPages).toBeLessThan(8); // no stray pages from footers
    for (const [i, page] of pages.entries()) {
      expect(squash(page)).toContain(p.pack_hash);
      expect(squash(page)).toContain(`halaman ${i + 1} dari ${totalPages}`);
    }
    const all = squash(pages.join(' '));
    for (const e of [p.entries[0]!, p.entries[75]!, p.entries[149]!])
      expect(all).toContain(e.entry_hash.slice(0, 8));
  });

  it('describes undisclosed entries honestly and marks partial packs', async () => {
    const text = await textOf(
      await renderPackPdf(pack(6, { payloads: 'none' }), 'https://app.example.test'),
    );
    expect(text).toContain('(isi tidak disertakan)');
    expect(text).not.toContain('Atasan menolak');
    expect(text).toContain('Tidak ada tanda tangan saksi yang diungkapkan');

    const part = pack(6, {
      entries: structuredClone(BASE).slice(2, 5),
      requestedToSeq: 3,
      ledgerHeadSeq: 5,
      anchors: [],
    });
    const partText = await textOf(await renderPackPdf(part, 'https://app.example.test'));
    expect(partText).toContain('Ekspor sebagian');
    expect(partText).toContain('(entri penghubung ke jangkar waktu; isi tidak disertakan)');
    expect(partText).toContain('Tidak ada jangkar waktu di paket ini');
  });
});

describe('text helpers', () => {
  it('replaces characters the PDF fonts cannot draw, per code point', () => {
    expect(latin1('Café 😡 中文 ok')).toBe('Café ? ?? ok');
    expect(latin1('a\nb\tc')).toBe('a b c');
  });

  it('summarizes each entry type without inventing content', () => {
    const [note, file] = BASE;
    expect(summarize(note!, 9)).toBe('Atasan menolak membayar lembur ? Rp1.500.000');
    expect(summarize(file!, 9)).toBe('Berkas: slip gaji Oktober.pdf (20 KB, sha abababab)');
    expect(summarize({ ...note!, payload: undefined }, 9)).toBe('(isi tidak disertakan)');
    expect(summarize(note!, 0 - 1)).toBe(
      '(entri penghubung ke jangkar waktu; isi tidak disertakan)',
    );
  });
});
