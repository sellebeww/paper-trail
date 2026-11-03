// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildEntry, GENESIS_PREV_HASH } from './entry.js';
import { sha256Hex } from './hash.js';
import { canonicalize } from './jcs.js';
import { buildEvidencePack, computePackHash } from './pack.js';
import type { AnchorRecord, Entry, EvidencePack, PayloadObject } from './types.js';
import { verifyAttachments, verifyPack, type AnchorTokenResult } from './verify-pack.js';
import { buildWitnessMessage } from './witness-message.js';
import { witnessAuthorRef } from './witness.js';

const LEDGER = '6f1c0a52-3d1e-4b0a-9f55-0c7d6a2e8b11';
const t = (n: number) => new Date(Date.UTC(2026, 10, 3, 8, 0, n)).toISOString();
const FILE = Buffer.from('%PDF-1.4 slip gaji');

/** 8 entries: notes, a file (seq 2), a cosign of seq 1 (seq 3), more notes. */
const buildBase = (): Entry[] => {
  const chain: Entry[] = [];
  const push = (type: Entry['type'], payload: PayloadObject, authorRef = 'owner:9d2f4c1a') =>
    chain.push(
      buildEntry(
        { ledger_id: LEDGER, type, created_at: t(chain.length), author_ref: authorRef, payload },
        chain.at(-1) ?? null,
      ),
    );
  push('note', { text: 'Atasan menolak membayar lembur 😡' });
  push('note', { text: 'Saksi: Budi hadir.' });
  push('file', {
    content_sha256: sha256Hex(FILE),
    size: FILE.length,
    media_type: 'application/pdf',
    name: 'slip gaji.pdf',
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }).x!;
  const unsigned = {
    invite_id: '1d6e3c9a-8b2f-4c71-9a0e-5f4d3c2b1a09',
    target_seq: 1,
    target_entry_hash: chain[1]!.entry_hash,
    statement: 'confirm' as const,
    witness_name: 'Budi Santoso',
    witness_pub: pub,
    alg: 'Ed25519' as const,
    signed_client_time: t(3),
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
  for (let i = 4; i < 8; i++) push('note', { text: `catatan ${i}` });
  return chain;
};

// One fixed chain (the witness key is random, so it must not be rebuilt per call); tests mutate clones.
const BASE = buildBase();
const makeEntries = (): Entry[] => structuredClone(BASE);

const anchorFor = (e: Entry, tst = 'dG9rZW4'): AnchorRecord => ({
  v: 1,
  ledger_id: LEDGER,
  head_seq: e.seq,
  head_hash: e.entry_hash,
  anchor_digest: e.entry_hash,
  tsa_label: 'http://tsa.test/tsr',
  tst,
  certs: [],
  gen_time: t(30),
});

const make = (over: Partial<Parameters<typeof buildEvidencePack>[0]> = {}) =>
  buildEvidencePack({
    generatedAt: t(60),
    generator: { name: 'paper-trail', version: '0.0.0' },
    ledger: { id: LEDGER, title: 'Sengketa lembur', category: 'kerja' },
    entries: makeEntries(),
    requestedToSeq: 7,
    ledgerHeadSeq: 7,
    payloads: 'all',
    anchors: [],
    filesIncluded: [sha256Hex(FILE)],
    ...over,
  });

/** What an attacker who edits a pack would do next: recompute the checksum. */
const reseal = (pack: EvidencePack): EvidencePack => ({
  ...pack,
  pack_hash: computePackHash(pack),
});
const codes = (r: Awaited<ReturnType<typeof verifyPack>>) => r.findings.map((f) => f.code);
const okToken = (genTime = new Date(t(30)), chainVerified = true): AnchorTokenResult => ({
  ok: true,
  genTime,
  accuracyMs: 0,
  chainVerified,
});

describe('buildEvidencePack + verifyPack (full export)', () => {
  it('verifies, and says plainly that nothing is time-proven without an anchor', async () => {
    const pack = make();
    expect(pack.format_version).toBe('1.0');
    expect(pack.scope).toEqual({
      from_seq: 0,
      to_seq: 7,
      first_prev_hash: GENESIS_PREV_HASH,
      requested_to_seq: 7,
      ledger_head_seq: 7,
    });
    expect(pack.head).toEqual({ seq: 7, hash: pack.entries[7]!.entry_hash });
    expect(pack.witnesses).toHaveLength(1);
    const r = await verifyPack(pack);
    expect(r.verdict).toBe('OK');
    expect(codes(r)).toEqual(expect.arrayContaining(['CHAIN_OK', 'NO_ANCHOR']));
    expect(codes(r)).not.toContain('PARTIAL_PACK');
    expect(r.summary).toMatchObject({
      entries: 8,
      from_genesis: true,
      chain_intact: true,
      witnesses_verified: 1,
    });
  });

  it('survives a JSON round trip and key reordering (pack_hash is canonical)', async () => {
    const pack = make();
    const reversed = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reversed)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reversed(x)]),
            )
          : v;
    const shuffled = JSON.parse(JSON.stringify(reversed(pack))) as EvidencePack;
    expect(Object.keys(shuffled)[0]).not.toBe(Object.keys(pack)[0]);
    expect(computePackHash(shuffled)).toBe(pack.pack_hash);
    expect((await verifyPack(JSON.parse(JSON.stringify(pack, null, 2)))).verdict).toBe('OK');
  });

  it('detects a one-byte change at any sampled position of the serialized pack', async () => {
    const text = JSON.stringify(make());
    let checked = 0;
    for (let i = 0; i < text.length; i += 7) {
      const mutated =
        text.slice(0, i) + String.fromCharCode(text.charCodeAt(i) ^ 1) + text.slice(i + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(mutated);
      } catch {
        checked++; // no longer JSON: caught before verification
        continue;
      }
      const r = await verifyPack(parsed);
      expect([i, r.verdict]).toEqual([i, 'FAILED']);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  it.each([
    [
      'an edited payload',
      (p: EvidencePack) => void (p.entries[0]!.payload = { text: 'diubah' }),
      'PAYLOAD_HASH_MISMATCH',
    ],
    [
      'an edited timestamp',
      (p: EvidencePack) => void (p.entries[2]!.created_at = t(0)),
      'BROKEN_AT_SEQ',
    ],
    [
      'a removed entry',
      (p: EvidencePack) => {
        p.entries.splice(4, 1);
        p.scope.to_seq = 6;
        p.scope.requested_to_seq = 6;
        p.head = { seq: 6, hash: p.entries[6]!.entry_hash };
      },
      'SEQ_GAP',
    ],
    [
      'a swapped witness name',
      (p: EvidencePack) =>
        void ((p.entries[3]!.payload as Record<string, unknown>)['witness_name'] = 'Orang Lain'),
      'PAYLOAD_HASH_MISMATCH',
    ],
  ])('detects %s even if the attacker recomputes pack_hash', async (_label, tamper, code) => {
    const pack = make();
    tamper(pack);
    const r = await verifyPack(reseal(pack));
    expect(r.verdict).toBe('FAILED');
    expect(codes(r)).toContain(code);
  });

  it('flags a changed pack that was not resealed with PACK_HASH_MISMATCH', async () => {
    const pack = make();
    pack.generator.version = '9.9.9';
    const r = await verifyPack(pack);
    expect(codes(r)).toContain('PACK_HASH_MISMATCH');
    expect(r.summary.chain_intact).toBe(true); // the chain itself is fine; only the wrapper changed
  });

  it('rejects other formats and malformed input without throwing', async () => {
    expect(codes(await verifyPack({ ...make(), format_version: '0.1' }))).toEqual([
      'FORMAT_UNSUPPORTED',
    ]);
    for (const bad of [
      null,
      5,
      [],
      {},
      { format_version: '1.0' },
      { ...make(), entries: [] },
      { ...make(), pack_hash: 'ABC' },
    ]) {
      expect((await verifyPack(bad)).verdict).toBe('FAILED');
    }
  });
});

describe('disclosure', () => {
  it('keeps the chain verifiable when payloads are withheld, and hides witness details', async () => {
    const pack = make({ payloads: 'none' });
    expect(pack.entries.every((e) => e.payload === undefined)).toBe(true);
    expect(pack.disclosure).toEqual({ payloads_included: [], files_included: [] });
    expect(pack.witnesses).toEqual([]);
    expect((await verifyPack(pack)).verdict).toBe('OK');
  });

  it('discloses only the chosen entries', async () => {
    const pack = make({ payloads: [0, 3] });
    expect(pack.disclosure.payloads_included).toEqual([0, 3]);
    expect(pack.witnesses.map((w) => w.entry_seq)).toEqual([3]);
    expect(JSON.stringify(pack)).not.toContain('Saksi: Budi hadir');
    expect((await verifyPack(pack)).verdict).toBe('OK');
  });

  it('lists a file only when its entry is disclosed', () => {
    expect(make().disclosure.files_included).toEqual([sha256Hex(FILE)]);
    expect(make({ payloads: [0] }).disclosure.files_included).toEqual([]);
  });

  it('rejects inconsistent bookkeeping', async () => {
    const pack = make();
    pack.disclosure.payloads_included = [0];
    expect(codes(await verifyPack(reseal(pack)))).toContain('PACK_MALFORMED');
  });
});

describe('witness summaries', () => {
  it('must say exactly what the cosign entries say', async () => {
    const pack = make();
    pack.witnesses[0]!.witness_name = 'Nama Palsu';
    expect(codes(await verifyPack(reseal(pack)))).toContain('WITNESS_SUMMARY_MISMATCH');
    pack.witnesses = [];
    expect(codes(await verifyPack(reseal(pack)))).toContain('WITNESS_SUMMARY_MISMATCH');
  });
});

describe('partial export (SPEC §6.2)', () => {
  const partial = (
    from: number,
    to: number,
    over: Partial<Parameters<typeof buildEvidencePack>[0]> = {},
  ) =>
    buildEvidencePack({
      generatedAt: t(60),
      generator: { name: 'paper-trail', version: '0.0.0' },
      ledger: { id: LEDGER },
      entries: makeEntries().slice(from, to + 1),
      requestedToSeq: to,
      ledgerHeadSeq: 7,
      payloads: 'all',
      anchors: [],
      ...over,
    });

  it('verifies a middle segment, states what is missing, and carries the first prev_hash', async () => {
    const all = makeEntries();
    const pack = partial(3, 6);
    expect(pack.scope).toMatchObject({
      from_seq: 3,
      to_seq: 6,
      first_prev_hash: all[2]!.entry_hash,
      ledger_head_seq: 7,
    });
    const r = await verifyPack(pack);
    expect(r.verdict).toBe('OK');
    expect(r.summary).toMatchObject({
      from_seq: 3,
      to_seq: 6,
      from_genesis: false,
      chain_intact: true,
    });
    const note = r.findings.find((f) => f.code === 'PARTIAL_PACK')!;
    expect(note.severity).toBe('warning');
    expect(note.detail).toMatch(/starts at entry 3/);
    expect(note.detail).toMatch(/ends at entry 6/);
  });

  it('notes, without failing, a cosign whose target is outside the range', async () => {
    const r = await verifyPack(partial(3, 6));
    expect(r.summary.witnesses_verified).toBe(1);
    expect(
      r.findings.some((f) => f.severity === 'info' && /outside the exported range/.test(f.detail)),
    ).toBe(true);
  });

  it('detects tampering inside the segment and a wrong first_prev_hash', async () => {
    const pack = partial(3, 6);
    pack.scope.first_prev_hash = 'a'.repeat(64);
    const r = await verifyPack(reseal(pack));
    expect(r.verdict).toBe('FAILED');
    expect(r.findings.find((f) => f.severity === 'error')).toMatchObject({
      code: 'BROKEN_AT_SEQ',
      seq: 3,
    });

    const edited = partial(3, 6);
    edited.entries[1]!.payload = { text: 'diubah' };
    expect(codes(await verifyPack(reseal(edited)))).toContain('PAYLOAD_HASH_MISMATCH');
  });

  it('DOES NOT prove the segment belongs where it claims: a fabricated first_prev_hash passes unless anchored', async () => {
    // An owner can invent entries and call them "entry 5 onward". The verifier cannot tell; it must say so.
    const entry = buildEntry(
      {
        ledger_id: LEDGER,
        type: 'note',
        created_at: t(10),
        author_ref: 'owner:1',
        payload: { text: 'karangan' },
      },
      { ...makeEntries()[4]!, seq: 4, entry_hash: 'f'.repeat(64) },
    );
    const pack = buildEvidencePack({
      generatedAt: t(60),
      generator: { name: 'x', version: '0' },
      ledger: { id: LEDGER },
      entries: [entry],
      requestedToSeq: 5,
      ledgerHeadSeq: 5,
      payloads: 'all',
      anchors: [],
    });
    expect(pack.scope.from_seq).toBe(5);
    const r = await verifyPack(pack);
    expect(r.verdict).toBe('OK');
    expect(codes(r)).toEqual(expect.arrayContaining(['PARTIAL_PACK', 'NO_ANCHOR']));
  });

  it('builds bridge entries without payloads and still verifies', async () => {
    const all = makeEntries();
    const pack = buildEvidencePack({
      generatedAt: t(60),
      generator: { name: 'x', version: '0' },
      ledger: { id: LEDGER },
      entries: all.slice(2, 8),
      requestedToSeq: 4,
      ledgerHeadSeq: 7,
      payloads: 'all',
      anchors: [anchorFor(all[7]!)],
    });
    expect(pack.scope).toMatchObject({ from_seq: 2, to_seq: 7, requested_to_seq: 4 });
    expect(pack.disclosure.payloads_included).toEqual([2, 3, 4]);
    expect((await verifyPack(pack)).verdict).toBe('OK');

    const leaky = JSON.parse(JSON.stringify(pack)) as EvidencePack;
    leaky.entries[5]!.payload = all[7]!.payload!;
    leaky.disclosure.payloads_included = [2, 3, 4, 7];
    expect(codes(await verifyPack(reseal(leaky)))).toContain('PACK_MALFORMED');
  });
});

describe('anchors (token crypto injected by packages/verifier)', () => {
  it('structure: an anchor outside the pack or with a wrong digest is invalid', async () => {
    const pack = make();
    const e = pack.entries[7]!;
    const cases = [
      [{ ...anchorFor(e), head_hash: 'a'.repeat(64) }, 'HEAD_MISMATCH'],
      [{ ...anchorFor(e), anchor_digest: 'b'.repeat(64) }, 'DIGEST_MISMATCH'],
      [{ ...anchorFor(e), tst: '' }, 'TOKEN_MALFORMED'],
      [{ ...anchorFor(e), head_seq: 99 }, 'HEAD_MISMATCH'],
    ] as const;
    for (const [bad, reason] of cases) {
      const r = await verifyPack(reseal({ ...pack, anchors: [bad] }), {
        checkAnchorToken: async () => okToken(),
      });
      expect(r.findings.find((f) => f.code === 'ANCHOR_INVALID')).toMatchObject({ reason });
      expect(r.verdict).toBe('FAILED');
    }
  });

  it('a verified anchor at the head covers everything', async () => {
    const pack = make({ anchors: [anchorFor(makeEntries()[7]!)] });
    const r = await verifyPack(pack, { checkAnchorToken: async () => okToken(new Date(t(30))) });
    expect(r.verdict).toBe('OK');
    expect(r.summary).toMatchObject({ anchors_verified: 1, anchored_through_seq: 7 });
    expect(codes(r)).not.toContain('NO_ANCHOR');
    expect(codes(r)).not.toContain('UNANCHORED_TAIL');
  });

  it('an earlier anchor leaves an unanchored tail; a rejected token is ANCHOR_INVALID with its reason', async () => {
    const early = make({ anchors: [anchorFor(makeEntries()[4]!)] });
    const r = await verifyPack(early, { checkAnchorToken: async () => okToken() });
    expect(r.findings.find((f) => f.code === 'UNANCHORED_TAIL')).toMatchObject({
      seq: 5,
      severity: 'warning',
    });
    expect(r.summary.anchored_through_seq).toBe(4);

    const rejected = await verifyPack(early, {
      checkAnchorToken: async () => ({ ok: false, reason: 'CERT_UNTRUSTED', detail: 'no path' }),
    });
    expect(rejected.findings.find((f) => f.code === 'ANCHOR_INVALID')).toMatchObject({
      reason: 'CERT_UNTRUSTED',
      seq: 4,
    });
    expect(rejected.verdict).toBe('FAILED');
  });

  it('an entry newer than its covering anchor is ANCHOR_TIME_CONFLICT; a second of slack is tolerated', async () => {
    const pack = make({ anchors: [anchorFor(makeEntries()[7]!)] });
    const r = await verifyPack(pack, { checkAnchorToken: async () => okToken(new Date(t(3))) });
    expect(r.findings.find((f) => f.code === 'ANCHOR_TIME_CONFLICT')).toMatchObject({
      seq: 5,
      severity: 'error',
    });

    const sameSecond = await verifyPack(pack, {
      checkAnchorToken: async () => okToken(new Date(Date.parse(t(7)) - 900)),
    });
    expect(codes(sameSecond)).not.toContain('ANCHOR_TIME_CONFLICT');
  });

  it('warns when the TSA chain was not checked, and when no token verifier ran at all', async () => {
    const pack = make({ anchors: [anchorFor(makeEntries()[7]!)] });
    expect(
      codes(
        await verifyPack(pack, { checkAnchorToken: async () => okToken(new Date(t(30)), false) }),
      ),
    ).toContain('ANCHOR_UNVERIFIED');
    const bare = await verifyPack(pack);
    expect(codes(bare)).toContain('ANCHOR_UNVERIFIED');
    expect(bare.summary.anchors_verified).toBe(0);
  });
});

describe('verifyAttachments', () => {
  it('accepts matching files and reports missing or altered ones', () => {
    const pack = make();
    const sha = sha256Hex(FILE);
    expect(verifyAttachments(pack, new Map([[sha, FILE]]))).toEqual([]);
    expect(verifyAttachments(pack, new Map())).toMatchObject([
      { code: 'FILE_MISSING', severity: 'warning', seq: 2 },
    ]);
    expect(
      verifyAttachments(pack, new Map([[sha, Buffer.from('%PDF-1.4 slip gajI')]])),
    ).toMatchObject([{ code: 'FILE_HASH_MISMATCH', severity: 'error', seq: 2 }]);
  });
});
