// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Property-based tests: any tampering with a valid chain that the hash chain is meant to catch is caught,
// whatever the chain's contents, length, or where the tampering happens. See THREAT_MODEL for the two
// changes a chain alone cannot catch (tail truncation and a resealed last entry); anchors cover those.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildEntry, computeEntryHash, computePayloadHash } from './entry.js';
import { ENTRY_TYPES, type Entry } from './types.js';
import { verifyChain } from './verify.js';

const LEDGER = '6f1c0a52-3d1e-4b0a-9f55-0c7d6a2e8b11';
const BASE_MS = Date.UTC(2026, 10, 2, 8);

/** A valid chain built from random note texts and non-decreasing timestamps. */
const chainArb = fc
  .array(
    fc.record({ text: fc.string({ minLength: 1, unit: 'grapheme' }), gap: fc.nat(86_400_000) }),
    {
      minLength: 2,
      maxLength: 12,
    },
  )
  .map((items) => {
    const chain: Entry[] = [];
    let t = BASE_MS;
    for (const { text, gap } of items) {
      t += gap;
      const e = buildEntry(
        {
          ledger_id: LEDGER,
          type: 'note',
          created_at: new Date(t).toISOString(),
          author_ref: 'owner:9d2f4c1a',
          payload: { text },
        },
        chain.at(-1) ?? null,
      );
      chain.push(e);
    }
    return chain;
  });

const flipHex = (h: string, at: number) => {
  const i = at % h.length;
  return h.slice(0, i) + (h[i] === '0' ? '1' : '0') + h.slice(i + 1);
};

type Field = Exclude<keyof Entry, 'payload'>;
const FIELDS: Field[] = [
  'v',
  'ledger_id',
  'seq',
  'type',
  'created_at',
  'author_ref',
  'payload_hash',
  'prev_hash',
  'entry_hash',
];

/** A different, same-typed value for `field`, so the change is a real edit and not just a shape error. */
const changeField = (e: Entry, field: Field, k: number): Entry => {
  const next = { ...e } as Record<string, unknown>;
  switch (field) {
    case 'v':
      next['v'] = 2;
      break;
    case 'seq':
      next['seq'] = e.seq + 1 + (k % 5);
      break;
    case 'type':
      next['type'] = ENTRY_TYPES.filter((t) => t !== e.type && t !== 'witness_cosign')[k % 2];
      break;
    case 'created_at':
      next['created_at'] = new Date(Date.parse(e.created_at) + 1 + k).toISOString();
      break;
    case 'payload_hash':
    case 'prev_hash':
    case 'entry_hash':
      next[field] = flipHex(e[field], k);
      break;
    default:
      next[field] = `${e[field]}x`;
  }
  return next as unknown as Entry;
};

const at = (chain: Entry[], i: number) => i % chain.length;

describe('verifyChain (property-based)', () => {
  it('accepts every chain it builds', async () => {
    await fc.assert(
      fc.asyncProperty(chainArb, async (chain) => {
        expect((await verifyChain(chain)).ok).toBe(true);
      }),
    );
  });

  it('detects any field edit, anywhere, without resealing', async () => {
    await fc.assert(
      fc.asyncProperty(
        chainArb,
        fc.nat(),
        fc.constantFrom(...FIELDS),
        fc.nat(),
        async (chain, i, field, k) => {
          const idx = at(chain, i);
          const tampered = chain.map((e, j) => (j === idx ? changeField(e, field, k) : e));
          const result = await verifyChain(tampered);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.brokenAtSeq).toBeLessThanOrEqual(idx + 1);
        },
      ),
    );
  });

  it('detects a changed payload, anywhere', async () => {
    await fc.assert(
      fc.asyncProperty(chainArb, fc.nat(), fc.string({ minLength: 1 }), async (chain, i, extra) => {
        const idx = at(chain, i);
        const tampered = chain.map((e, j) =>
          j === idx ? { ...e, payload: { text: `${String(e.payload?.['text'])}${extra}` } } : e,
        );
        const result = await verifyChain(tampered);
        expect(result).toMatchObject({
          ok: false,
          code: 'PAYLOAD_HASH_MISMATCH',
          brokenAtSeq: idx,
        });
      }),
    );
  });

  it('detects an edit resealed by an attacker who knows the format, unless it is the last entry', async () => {
    await fc.assert(
      fc.asyncProperty(chainArb, fc.nat(), fc.string({ minLength: 1 }), async (chain, i, text) => {
        const idx = i % (chain.length - 1); // never the last entry: see the limit test below
        const tampered = chain.map((e, j) => {
          if (j !== idx) return e;
          const payload = { text: `${String(e.payload?.['text'])}${text}` };
          const edited = { ...e, payload, payload_hash: computePayloadHash(payload) };
          return { ...edited, entry_hash: computeEntryHash(edited) };
        });
        const result = await verifyChain(tampered);
        expect(result).toMatchObject({ ok: false, code: 'BROKEN_AT_SEQ', brokenAtSeq: idx + 1 });
      }),
    );
  });

  it('detects a deleted, inserted, duplicated or reordered entry', async () => {
    const structural = fc.oneof(
      fc.record({ kind: fc.constant('delete' as const), i: fc.nat() }),
      fc.record({ kind: fc.constant('duplicate' as const), i: fc.nat() }),
      fc.record({ kind: fc.constant('swap' as const), i: fc.nat(), j: fc.nat() }),
      fc.record({ kind: fc.constant('insert' as const), i: fc.nat(), text: fc.string() }),
    );
    await fc.assert(
      fc.asyncProperty(chainArb, structural, async (chain, m) => {
        const t = [...chain];
        if (m.kind === 'delete') {
          t.splice(m.i % (chain.length - 1), 1); // deleting the last entry is a tail truncation
        } else if (m.kind === 'duplicate') {
          const idx = at(chain, m.i);
          t.splice(idx, 0, chain[idx]!);
        } else if (m.kind === 'swap') {
          const a = at(chain, m.i);
          const b = (a + 1 + (m.j % (chain.length - 1))) % chain.length;
          [t[a], t[b]] = [t[b]!, t[a]!];
        } else {
          // A forged entry that links correctly to its predecessor, inserted in the middle.
          const idx = m.i % (chain.length - 1);
          const forged = buildEntry(
            {
              ledger_id: LEDGER,
              type: 'note',
              created_at: chain[idx]!.created_at,
              author_ref: 'owner:9d2f4c1a',
              payload: { text: `palsu ${m.text}` },
            },
            chain[idx]!,
          );
          t.splice(idx + 1, 0, forged);
        }
        expect((await verifyChain(t)).ok).toBe(false);
      }),
    );
  });

  it('documents the limit: a chain alone cannot see tail truncation or a resealed last entry', async () => {
    await fc.assert(
      fc.asyncProperty(chainArb, async (chain) => {
        expect((await verifyChain(chain.slice(0, -1))).ok).toBe(true);
        const last = chain.at(-1)!;
        const payload = { text: 'ditulis ulang' };
        const edited = { ...last, payload, payload_hash: computePayloadHash(payload) };
        const resealed = [
          ...chain.slice(0, -1),
          { ...edited, entry_hash: computeEntryHash(edited) },
        ];
        expect((await verifyChain(resealed)).ok).toBe(true);
      }),
      { numRuns: 20 },
    );
  });
});
