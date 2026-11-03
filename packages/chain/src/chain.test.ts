// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  buildEntry,
  ChainError,
  computeEntryHash,
  computePayloadHash,
  GENESIS_PREV_HASH,
  type EntryInput,
} from './entry.js';
import { sha256Hex } from './hash.js';
import type { Entry, PayloadObject } from './types.js';
import { verifyChain } from './verify.js';

const LEDGER = '6f1c0a52-3d1e-4b0a-9f55-0c7d6a2e8b11';
const OTHER_LEDGER = '0b5e9a7c-1111-4222-8333-944455556666';

const input = (n: number, payload: PayloadObject = { text: `catatan ${n}` }): EntryInput => ({
  ledger_id: LEDGER,
  type: 'note',
  created_at: new Date(Date.UTC(2026, 10, 2, 8, 0, n)).toISOString(),
  author_ref: 'owner:9d2f4c1a',
  payload,
});

const makeChain = (length: number): Entry[] => {
  const chain: Entry[] = [];
  for (let i = 0; i < length; i++) chain.push(buildEntry(input(i), chain.at(-1) ?? null));
  return chain;
};

/** Rehashes an entry after tampering, as an attacker who knows the format would. */
const reseal = (e: Entry): Entry => ({ ...e, entry_hash: computeEntryHash(e) });

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 "abc" vector and hashes strings as UTF-8', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('é')).toBe(sha256Hex(new Uint8Array([0xc3, 0xa9])));
  });
});

describe('buildEntry', () => {
  it('builds a genesis entry with seq 0 and all-zero prev_hash', () => {
    const e = buildEntry(input(0), null);
    expect(e.seq).toBe(0);
    expect(e.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(e.entry_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('links each entry to the previous one', () => {
    const [a, b] = makeChain(2);
    expect(b!.seq).toBe(1);
    expect(b!.prev_hash).toBe(a!.entry_hash);
  });

  it('matches the pinned test vector in docs/SPEC.md Appendix A', () => {
    const e = buildEntry(
      {
        ledger_id: LEDGER,
        type: 'note',
        created_at: '2026-11-02T11:20:00.000Z',
        author_ref: 'owner:9d2f4c1a',
        payload: { text: 'Atasan menolak membayar lembur.' },
      },
      null,
    );
    expect(e.payload_hash).toBe('c8c6d06f3e1cc1e4a1b01ea8ffe0ec652c596a6518c08fdce704ffddd404bedb');
    expect(e.entry_hash).toBe('a423b1287ae37ea5e0f675aad051408898f526a272cc8863f11d1177be723950');
  });

  it('rejects floats, null and non-object payloads', () => {
    expect(() => buildEntry(input(0, { amount: 1.5 }), null)).toThrow(ChainError);
    expect(() => buildEntry(input(0, { a: null } as unknown as PayloadObject), null)).toThrow(
      ChainError,
    );
    expect(() => buildEntry(input(0, ['x'] as unknown as PayloadObject), null)).toThrow(ChainError);
  });

  it('rejects malformed envelope fields', () => {
    expect(() => buildEntry({ ...input(0), created_at: '2026-11-02 08:00' }, null)).toThrow(
      ChainError,
    );
    expect(() => buildEntry({ ...input(0), ledger_id: LEDGER.toUpperCase() }, null)).toThrow(
      ChainError,
    );
    expect(() => buildEntry({ ...input(0), author_ref: 'budi@example.com' }, null)).toThrow(
      ChainError,
    );
    expect(() => buildEntry({ ...input(0), type: 'memo' as never }, null)).toThrow(ChainError);
  });

  it('refuses a witness_cosign genesis, a foreign prev, and a clock going backwards', () => {
    expect(() => buildEntry({ ...input(0), type: 'witness_cosign' }, null)).toThrow(ChainError);
    const [a] = makeChain(1);
    expect(() => buildEntry({ ...input(1), ledger_id: OTHER_LEDGER }, a!)).toThrow(ChainError);
    expect(() => buildEntry({ ...input(1), created_at: '2026-11-01T00:00:00.000Z' }, a!)).toThrow(
      ChainError,
    );
  });
});

describe('payload hashing', () => {
  it('gives the same hash for different key orders', () => {
    expect(computePayloadHash({ a: 1, b: { c: 'x', d: 'y' } })).toBe(
      computePayloadHash({ b: { d: 'y', c: 'x' }, a: 1 }),
    );
  });

  it('handles Unicode and emoji, and verifies them in a chain', async () => {
    const text = 'Gaji belum dibayar 😡 — Rp1.500.000 · ñ · 中文 · 👩🏽‍🔧';
    const e = buildEntry(input(0, { text }), null);
    expect((await verifyChain([e])).ok).toBe(true);
    expect(computePayloadHash({ text })).toBe(sha256Hex(`{"text":"${text}"}`));
  });

  it('does not normalize: NFC and NFD forms hash differently (normalization is the server’s job)', () => {
    const nfc = 'Café'.normalize('NFC');
    const nfd = 'Café'.normalize('NFD');
    expect(computePayloadHash({ text: nfc })).not.toBe(computePayloadHash({ text: nfd }));
  });
});

describe('verifyChain', () => {
  it('accepts a valid chain', async () => {
    expect(await verifyChain(makeChain(5))).toMatchObject({
      ok: true,
      code: 'CHAIN_OK',
      length: 5,
    });
  });

  it('accepts an empty chain and a chain with undisclosed payloads', async () => {
    expect((await verifyChain([])).ok).toBe(true);
    const hidden = makeChain(3).map(({ payload: _payload, ...rest }) => rest);
    expect((await verifyChain(hidden)).ok).toBe(true);
  });

  describe('middle entry modified', () => {
    it('payload changed only → PAYLOAD_HASH_MISMATCH', async () => {
      const chain = makeChain(5);
      chain[2] = { ...chain[2]!, payload: { text: 'diubah' } };
      expect(await verifyChain(chain)).toMatchObject({
        ok: false,
        code: 'PAYLOAD_HASH_MISMATCH',
        brokenAtSeq: 2,
      });
    });

    it('payload and payload_hash changed → BROKEN_AT_SEQ at that entry', async () => {
      const chain = makeChain(5);
      const payload = { text: 'diubah' };
      chain[2] = { ...chain[2]!, payload, payload_hash: computePayloadHash(payload) };
      expect(await verifyChain(chain)).toMatchObject({
        ok: false,
        code: 'BROKEN_AT_SEQ',
        brokenAtSeq: 2,
      });
    });

    it('fully resealed entry → BROKEN_AT_SEQ at the next entry', async () => {
      const chain = makeChain(5);
      const payload = { text: 'diubah' };
      chain[2] = reseal({ ...chain[2]!, payload, payload_hash: computePayloadHash(payload) });
      expect(await verifyChain(chain)).toMatchObject({
        ok: false,
        code: 'BROKEN_AT_SEQ',
        brokenAtSeq: 3,
      });
    });

    it('created_at changed → BROKEN_AT_SEQ', async () => {
      const chain = makeChain(5);
      chain[2] = { ...chain[2]!, created_at: '2026-01-01T00:00:00.000Z' };
      expect(await verifyChain(chain)).toMatchObject({
        ok: false,
        code: 'BROKEN_AT_SEQ',
        brokenAtSeq: 2,
      });
    });
  });

  it('entry deleted → SEQ_GAP', async () => {
    const chain = makeChain(5);
    chain.splice(2, 1);
    expect(await verifyChain(chain)).toMatchObject({ ok: false, code: 'SEQ_GAP', brokenAtSeq: 2 });
  });

  it('entry deleted and later entries renumbered → BROKEN_AT_SEQ', async () => {
    const chain = makeChain(5);
    chain.splice(2, 1);
    const renumbered = chain.map((e, i) => (i >= 2 ? reseal({ ...e, seq: i }) : e));
    expect(await verifyChain(renumbered)).toMatchObject({
      ok: false,
      code: 'BROKEN_AT_SEQ',
      brokenAtSeq: 2,
    });
  });

  it('entry inserted with a duplicate seq → SEQ_GAP', async () => {
    const chain = makeChain(5);
    const forged = buildEntry(input(1, { text: 'sisipan' }), chain[1]!);
    chain.splice(2, 0, forged);
    expect(await verifyChain(chain)).toMatchObject({ ok: false, code: 'SEQ_GAP', brokenAtSeq: 3 });
  });

  it('entry inserted and later entries renumbered → BROKEN_AT_SEQ after the insertion', async () => {
    const chain = makeChain(5);
    const forged = buildEntry(input(1, { text: 'sisipan' }), chain[1]!);
    const tail = chain.slice(2).map((e) => reseal({ ...e, seq: e.seq + 1 }));
    const tampered = [...chain.slice(0, 2), forged, ...tail];
    expect(await verifyChain(tampered)).toMatchObject({
      ok: false,
      code: 'BROKEN_AT_SEQ',
      brokenAtSeq: 3,
    });
  });

  it('order swapped → SEQ_GAP', async () => {
    const chain = makeChain(5);
    [chain[1], chain[2]] = [chain[2]!, chain[1]!];
    expect(await verifyChain(chain)).toMatchObject({ ok: false, code: 'SEQ_GAP', brokenAtSeq: 1 });
  });

  it('order swapped and seq rewritten → BROKEN_AT_SEQ', async () => {
    const chain = makeChain(5);
    const swapped = [
      chain[0]!,
      reseal({ ...chain[2]!, seq: 1 }),
      reseal({ ...chain[1]!, seq: 2 }),
      ...chain.slice(3),
    ];
    expect(await verifyChain(swapped)).toMatchObject({
      ok: false,
      code: 'BROKEN_AT_SEQ',
      brokenAtSeq: 1,
    });
  });

  it('duplicate seq → SEQ_GAP', async () => {
    const chain = makeChain(4);
    chain.splice(3, 0, chain[2]!);
    expect(await verifyChain(chain)).toMatchObject({ ok: false, code: 'SEQ_GAP', brokenAtSeq: 3 });
  });

  it('wrong genesis → GENESIS_INVALID', async () => {
    const chain = makeChain(3);
    expect(
      await verifyChain([reseal({ ...chain[0]!, prev_hash: 'a'.repeat(64) }), ...chain.slice(1)]),
    ).toMatchObject({
      ok: false,
      code: 'GENESIS_INVALID',
      brokenAtSeq: 0,
    });
    expect(await verifyChain(chain.slice(1))).toMatchObject({ ok: false, code: 'GENESIS_INVALID' });
  });

  it('entry from another ledger → LEDGER_MISMATCH', async () => {
    const chain = makeChain(3);
    chain[1] = reseal({ ...chain[1]!, ledger_id: OTHER_LEDGER });
    expect(await verifyChain(chain)).toMatchObject({
      ok: false,
      code: 'LEDGER_MISMATCH',
      brokenAtSeq: 1,
    });
  });

  it('timestamps going backwards → TIME_REGRESSION', async () => {
    const chain = makeChain(3);
    const back = reseal({
      ...chain[2]!,
      created_at: chain[0]!.created_at.replace('08:00:00', '07:00:00'),
    });
    expect(await verifyChain([chain[0]!, chain[1]!, back])).toMatchObject({
      ok: false,
      code: 'TIME_REGRESSION',
      brokenAtSeq: 2,
    });
  });

  it('malformed input → PACK_MALFORMED', async () => {
    const chain = makeChain(2);
    expect(
      await verifyChain([{ ...chain[0]!, entry_hash: chain[0]!.entry_hash.toUpperCase() }]),
    ).toMatchObject({
      code: 'PACK_MALFORMED',
    });
    expect(await verifyChain([null as unknown as Entry])).toMatchObject({ code: 'PACK_MALFORMED' });
    expect(await verifyChain([{ ...chain[0]!, payload: { n: 1.5 } }])).toMatchObject({
      code: 'PACK_MALFORMED',
    });
  });
});
