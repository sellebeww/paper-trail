// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import {
  anchorData,
  buildEntry,
  buildEvidencePack,
  computePackHash,
  sha256Hex,
  type AnchorRecord,
  type Entry,
  type EvidencePack,
} from '@paper-trail/chain';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPack, verifyEvidencePack } from './pack.js';
import { headline } from './report.js';
import { createMockTsa, fetchMockToken, type MockTsa } from './testing/mock-tsa.js';
import { extractTokenCertificates, parsePemCertificates } from './timestamp.js';

const LEDGER = '6f1c0a52-3d1e-4b0a-9f55-0c7d6a2e8b11';
const FILE = Buffer.from('%PDF-1.4 slip gaji');
let tsa: MockTsa;
let other: MockTsa;
beforeAll(async () => {
  [tsa, other] = await Promise.all([createMockTsa(), createMockTsa()]);
});
afterAll(async () => {
  await Promise.all([tsa.close(), other.close()]);
});

/** Entries created a minute ago, so a token issued now is later than all of them. */
const entries = (): Entry[] => {
  const chain: Entry[] = [];
  const base = Date.now() - 60_000;
  const push = (type: Entry['type'], payload: Record<string, string | number>) =>
    chain.push(
      buildEntry(
        {
          ledger_id: LEDGER,
          type,
          created_at: new Date(base + chain.length * 100).toISOString(),
          author_ref: 'owner:1',
          payload,
        },
        chain.at(-1) ?? null,
      ),
    );
  push('note', { text: 'satu' });
  push('file', {
    content_sha256: sha256Hex(FILE),
    size: FILE.length,
    media_type: 'application/pdf',
    name: 'slip.pdf',
  });
  push('note', { text: 'tiga' });
  return chain;
};

const anchored = async (
  chain: Entry[],
  at = chain.length - 1,
  server = tsa,
  over: Partial<AnchorRecord> = {},
): Promise<EvidencePack> => {
  const head = chain[at]!;
  const token = await fetchMockToken(server.url, anchorData(head));
  const anchor: AnchorRecord = {
    v: 1,
    ledger_id: LEDGER,
    head_seq: head.seq,
    head_hash: head.entry_hash,
    anchor_digest: head.entry_hash,
    tsa_label: server.url,
    tst: token.toString('base64url'),
    certs: extractTokenCertificates(token).map((c) => Buffer.from(c).toString('base64url')),
    gen_time: new Date().toISOString(),
    ...over,
  };
  return buildEvidencePack({
    generatedAt: new Date().toISOString(),
    generator: { name: 'paper-trail', version: '0.0.0' },
    ledger: { id: LEDGER, title: 'Uji' },
    entries: chain,
    requestedToSeq: chain.length - 1,
    ledgerHeadSeq: chain.length - 1,
    payloads: 'all',
    anchors: [anchor],
    filesIncluded: [sha256Hex(FILE)],
  });
};
const reseal = (p: EvidencePack): EvidencePack => ({ ...p, pack_hash: computePackHash(p) });
const codes = (r: Awaited<ReturnType<typeof verifyEvidencePack>>) => r.findings.map((f) => f.code);

describe('verifyEvidencePack with real RFC 3161 tokens', () => {
  it('verifies the chain and the anchor against a trusted root', async () => {
    const pack = await anchored(entries());
    const r = await verifyEvidencePack(pack, { trustedCerts: [tsa.caCert] });
    expect(r.verdict).toBe('OK');
    expect(r.summary).toMatchObject({ anchors_verified: 1, anchored_through_seq: 2 });
    expect(codes(r)).not.toContain('NO_ANCHOR');
    expect(codes(r)).not.toContain('ANCHOR_UNVERIFIED');
    expect(headline(r)).toBe('Rantai utuh');
    expect(pack.anchors[0]!.certs.length).toBeGreaterThan(0);
  });

  it('without trust anchors it checks the token signature but warns that the chain is unchecked', async () => {
    const r = await verifyEvidencePack(await anchored(entries()));
    expect(r.verdict).toBe('OK');
    expect(codes(r)).toContain('ANCHOR_UNVERIFIED');
  });

  it('rejects a token from a TSA that is not trusted', async () => {
    const r = await verifyEvidencePack(await anchored(entries()), { trustedCerts: [other.caCert] });
    expect(r.verdict).toBe('FAILED');
    expect(r.findings.find((f) => f.code === 'ANCHOR_INVALID')).toMatchObject({
      reason: 'CERT_UNTRUSTED',
    });
  });

  it('rejects a token that timestamps a different entry', async () => {
    const chain = entries();
    const pack = await anchored(chain, 1); // token over entry 1…
    const lie = {
      ...pack.anchors[0]!,
      head_seq: 2,
      head_hash: chain[2]!.entry_hash,
      anchor_digest: chain[2]!.entry_hash,
    }; // …claimed for entry 2
    const r = await verifyEvidencePack(reseal({ ...pack, anchors: [lie] }), {
      trustedCerts: [tsa.caCert],
    });
    expect(r.findings.find((f) => f.code === 'ANCHOR_INVALID')).toMatchObject({
      reason: 'IMPRINT_MISMATCH',
      seq: 2,
    });
  });

  it('rejects a corrupted token', async () => {
    const pack = await anchored(entries());
    const der = Buffer.from(pack.anchors[0]!.tst, 'base64url');
    der[Math.floor(der.length / 2)]! ^= 0xff;
    const bad = { ...pack.anchors[0]!, tst: der.toString('base64url') };
    const r = await verifyEvidencePack(reseal({ ...pack, anchors: [bad] }), {
      trustedCerts: [tsa.caCert],
    });
    expect(r.verdict).toBe('FAILED');
    expect(r.findings.find((f) => f.code === 'ANCHOR_INVALID')).toBeDefined();
    const nonCanonical = { ...pack.anchors[0]!, tst: `${pack.anchors[0]!.tst}=` };
    expect(
      (await verifyEvidencePack(reseal({ ...pack, anchors: [nonCanonical] }))).findings.find(
        (f) => f.code === 'ANCHOR_INVALID',
      ),
    ).toMatchObject({ reason: 'TOKEN_MALFORMED' });
  });

  it('flags entries that claim to be newer than the anchor that covers them', async () => {
    const future = Date.now() + 3_600_000;
    const chain: Entry[] = [];
    for (let i = 0; i < 3; i++)
      chain.push(
        buildEntry(
          {
            ledger_id: LEDGER,
            type: 'note',
            created_at: new Date(future + i).toISOString(),
            author_ref: 'owner:1',
            payload: { text: `x${i}` },
          },
          chain.at(-1) ?? null,
        ),
      );
    const r = await verifyEvidencePack(await anchored(chain), { trustedCerts: [tsa.caCert] });
    expect(r.verdict).toBe('FAILED');
    expect(codes(r)).toContain('ANCHOR_TIME_CONFLICT');
  });

  it('a partial pack bridged to an anchor verifies and states what it is', async () => {
    const chain = entries();
    const token = await fetchMockToken(tsa.url, anchorData(chain[2]!));
    const pack = buildEvidencePack({
      generatedAt: new Date().toISOString(),
      generator: { name: 'x', version: '0' },
      ledger: { id: LEDGER },
      entries: chain.slice(1),
      requestedToSeq: 1,
      ledgerHeadSeq: 2,
      payloads: 'all',
      anchors: [
        {
          v: 1,
          ledger_id: LEDGER,
          head_seq: 2,
          head_hash: chain[2]!.entry_hash,
          anchor_digest: chain[2]!.entry_hash,
          tsa_label: 'x',
          tst: token.toString('base64url'),
          certs: [],
          gen_time: new Date().toISOString(),
        },
      ],
    });
    const r = await verifyEvidencePack(pack, { trustedCerts: [tsa.caCert] });
    expect(r.verdict).toBe('OK');
    expect(r.summary).toMatchObject({
      from_seq: 1,
      to_seq: 2,
      from_genesis: false,
      anchored_through_seq: 2,
    });
    expect(codes(r)).toContain('PARTIAL_PACK');
    expect(headline(r)).toBe('Rantai utuh pada rentang yang diekspor');
  });
});

describe('headline', () => {
  it('names the entry where the chain broke, in simple Indonesian', async () => {
    const pack = await anchored(entries());
    pack.entries[1]!.payload = { text: 'diubah' };
    expect(headline(await verifyEvidencePack(reseal(pack)))).toBe('Terputus di entri 1');
    const edited = await anchored(entries());
    edited.generator.version = '9';
    expect(headline(await verifyEvidencePack(edited))).toMatch(/diubah/);
  });
});

describe('zip packs', () => {
  const zip = (pack: EvidencePack, fileBytes: Uint8Array = FILE) =>
    zipSync({
      'pack.json': Buffer.from(JSON.stringify(pack)),
      [`files/${sha256Hex(FILE)}.pdf`]: fileBytes,
    });

  it('loads pack.json and files, keyed by the sha256 of their content', async () => {
    const pack = await anchored(entries());
    const loaded = loadPack(zip(pack));
    expect([...loaded.files.keys()]).toEqual([sha256Hex(FILE)]);
    expect((loaded.pack as EvidencePack).pack_hash).toBe(pack.pack_hash);
    const r = await verifyEvidencePack(loaded.pack, {
      trustedCerts: [tsa.caCert],
      files: loaded.files,
    });
    expect(r.verdict).toBe('OK');
    expect(codes(r)).not.toContain('FILE_MISSING');
  });

  it('catches a swapped attachment (the name says one thing, the bytes another)', async () => {
    const pack = await anchored(entries());
    const loaded = loadPack(zip(pack, Buffer.from('%PDF-1.4 palsu')));
    // The file is stored under its own hash, so the entry's hash finds nothing: reported as missing, not accepted.
    const r = await verifyEvidencePack(loaded.pack, {
      trustedCerts: [tsa.caCert],
      files: loaded.files,
    });
    expect(codes(r)).toContain('FILE_MISSING');
    expect(createHash('sha256').update('%PDF-1.4 palsu').digest('hex')).not.toBe(sha256Hex(FILE));
  });

  it('refuses unreadable input', () => {
    expect(() => loadPack(Buffer.from('not json'))).toThrow(/not valid JSON/);
    expect(() => loadPack(zipSync({ 'other.txt': Buffer.from('x') }))).toThrow(/no pack.json/);
  });
});

describe('certificates', () => {
  it('extracts the TSA certificate from a token and parses PEM bundles', async () => {
    const token = await fetchMockToken(tsa.url, Buffer.from('x'));
    expect(extractTokenCertificates(token)).toHaveLength(1);
    expect(extractTokenCertificates(Buffer.from('junk'))).toEqual([]);
    expect(parsePemCertificates(tsa.caPem)).toHaveLength(1);
    expect(() => parsePemCertificates('nothing here')).toThrow();
  });
});
