// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { Anchor, ApiEntry } from './api';
import { checkSavedHead, hash8, isAnchored, shorten, witnessMarks } from './format';
import { en, id, type MessageKey } from './messages';
import { credentialsSchema, exportSchema } from './schemas';

const anchor = (seq: number): Anchor => ({
  status: 'ok',
  anchored_head_seq: seq,
  anchored_head_hash: 'a'.repeat(64),
  gen_time: '2026-11-03T05:00:00.000Z',
  tsa_url: null,
  attempts: 1,
  updated_at: '2026-11-03T05:00:01.000Z',
});

const entry = (seq: number, type: ApiEntry['type'], payload: ApiEntry['payload']): ApiEntry => ({
  id: `id-${seq}`,
  v: 1,
  ledger_id: 'l',
  seq,
  type,
  created_at: '2026-11-03T04:00:00.000Z',
  author_ref: 'owner:x',
  payload_hash: 'p'.repeat(64),
  prev_hash: 'q'.repeat(64),
  entry_hash: String(seq).repeat(64).slice(0, 64),
  payload,
});

describe('anchor status', () => {
  it('an entry is anchored only up to the confirmed anchor’s head', () => {
    expect(isAnchored(0, null)).toBe(false);
    expect(isAnchored(2, anchor(2))).toBe(true);
    expect(isAnchored(3, anchor(2))).toBe(false);
  });
});

describe('witness marks', () => {
  it('collects witness names under the entry they witnessed', () => {
    const list = [
      entry(0, 'note', { text: 'a' }),
      entry(1, 'witness_cosign', { target_seq: 0, witness_name: 'Siti' }),
      entry(2, 'witness_cosign', { target_seq: 0, witness_name: 'Budi' }),
    ];
    const marks = witnessMarks(list);
    expect(marks.get(0)?.map((m) => m.name)).toEqual(['Siti', 'Budi']);
    expect(marks.get(1)).toBeUndefined();
  });
});

describe('saved head check', () => {
  const chain = [entry(0, 'note', { text: 'a' }), entry(1, 'note', { text: 'b' })];
  it('compares the head we saw with the server’s chain', () => {
    expect(checkSavedHead(null, chain)).toBe('none');
    expect(checkSavedHead({ seq: 1, hash: chain[1]!.entry_hash }, chain)).toBe('ok');
    expect(checkSavedHead({ seq: 1, hash: 'f'.repeat(64) }, chain)).toBe('mismatch');
    expect(checkSavedHead({ seq: 5, hash: 'f'.repeat(64) }, chain)).toBe('shorter');
  });
});

describe('small helpers', () => {
  it('shows 8 hash characters and a placeholder when there is none', () => {
    expect(hash8('0123456789abcdef')).toBe('01234567');
    expect(hash8(null)).toBe('--------');
  });
  it('shortens by characters, not UTF-16 units', () => {
    expect(shorten('😀😀😀😀', 2)).toBe('😀😀…');
    expect(shorten('  a   b ', 10)).toBe('a b');
  });
});

describe('i18n', () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it('English defines every Indonesian key, with the same placeholders', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(id).sort());
    for (const key of Object.keys(id) as MessageKey[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(id[key]));
    }
  });
  it('never claims absolute guarantees', () => {
    const all = [...Object.values(id), ...Object.values(en)].join('\n').toLowerCase();
    expect(all).not.toMatch(/100\s?%|anti-?manipulasi|tamper-?proof|unhackable|dijamin aman/);
  });
});

describe('form schemas', () => {
  const t = (key: MessageKey) => key;
  it('register needs a 10+ character password, login only a non-empty one', () => {
    const short = { email: 'a@b.co', password: 'pendek' };
    expect(credentialsSchema(t, 'register').safeParse(short).success).toBe(false);
    expect(credentialsSchema(t, 'login').safeParse({ ...short, password: 'x' }).success).toBe(true);
  });
  it('export range must be ordered and start at 1', () => {
    const base = { include_title: 'yes', payloads: 'all', include_files: 'no', range: 'seq' };
    const ok = exportSchema(t).safeParse({ ...base, from: '2', to: '5' });
    const reversed = exportSchema(t).safeParse({ ...base, from: '5', to: '2' });
    const zero = exportSchema(t).safeParse({ ...base, from: '0', to: '' });
    expect([ok.success, reversed.success, zero.success]).toEqual([true, false, false]);
  });
});
