// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Regenerates packages/verifier/fixtures from docs/examples/example-pack.json: one valid pack and one pack per
// kind of tampering, each with the result a correct verifier must give (fixtures/expected.json). Tampered packs
// are resealed (pack_hash recomputed), as a forger would do, so the check under test is the one that catches it.
// Run: pnpm --filter @paper-trail/verifier fixtures
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildEntry,
  computePackHash,
  summarizeWitness,
  type Entry,
  type EvidencePack,
  type PayloadObject,
} from '@paper-trail/chain';

const root = resolve(import.meta.dirname, '../../..');
const out = resolve(import.meta.dirname, '../fixtures');
const base = JSON.parse(
  readFileSync(resolve(root, 'docs/examples/example-pack.json'), 'utf8'),
) as EvidencePack;
const copy = (): EvidencePack => structuredClone(base);
const reseal = (p: EvidencePack): EvidencePack => ({ ...p, pack_hash: computePackHash(p) });

/** Rebuilds entries from `from` on with the same content, as a forger re-hashing the tail would. */
const rehash = (entries: Entry[], from: number): Entry[] => {
  const chain = entries.slice(0, from);
  for (const e of entries.slice(from))
    chain.push(
      buildEntry(
        {
          ledger_id: e.ledger_id,
          type: e.type,
          created_at: e.created_at,
          author_ref: e.author_ref,
          payload: e.payload as PayloadObject,
        },
        chain.at(-1) ?? null,
      ),
    );
  return chain;
};

interface Expected {
  file: string;
  description: string;
  exit: number;
  headline: string;
  code?: string;
  seq?: number;
}
const fixtures: [Expected, EvidencePack][] = [];
const add = (e: Expected, pack: EvidencePack) => fixtures.push([e, pack]);

add(
  {
    file: 'valid.json',
    description: 'The Step 6 example pack, unchanged.',
    exit: 0,
    headline: 'Rantai utuh',
  },
  copy(),
);

{
  const p = copy();
  (p.entries[1]!.payload as { text: string }).text = 'Selasa: tidak ada lembur.';
  add(
    {
      file: 'entry-modified.json',
      description: 'The text of entry 1 was changed after the fact.',
      exit: 1,
      headline: 'Terputus di entri 1',
      code: 'PAYLOAD_HASH_MISMATCH',
      seq: 1,
    },
    reseal(p),
  );
}

{
  const p = copy();
  p.entries.splice(4, 1);
  p.scope = { ...p.scope, to_seq: 4, requested_to_seq: 4 };
  p.disclosure.payloads_included = p.entries.map((e) => e.seq);
  add(
    {
      file: 'entry-deleted.json',
      description: 'Entry 4 was removed and the scope adjusted to hide it.',
      exit: 1,
      headline: 'Terputus di entri 4',
      code: 'SEQ_GAP',
      seq: 4,
    },
    reseal(p),
  );
}

{
  const p = copy();
  (p.entries[3]!.payload as { witness_name: string }).witness_name = 'Pak RT (palsu)';
  p.entries = rehash(p.entries, 3);
  p.witnesses = p.entries.map(summarizeWitness).filter((w) => w !== null);
  const last = p.entries.at(-1)!;
  p.head = { seq: last.seq, hash: last.entry_hash };
  add(
    {
      file: 'fake-witness.json',
      description:
        'The witness name was changed and every hash after it recomputed; the signature no longer matches.',
      exit: 4,
      headline: 'Paket tidak lolos pemeriksaan: tanda tangan saksi di entri 3 tidak sah',
      code: 'WITNESS_SIG_INVALID',
      seq: 3,
    },
    reseal(p),
  );
}

{
  const p = copy();
  p.anchors[1] = { ...p.anchors[1]!, tst: p.anchors[0]!.tst, certs: p.anchors[0]!.certs };
  add(
    {
      file: 'fake-anchor.json',
      description:
        'The anchor for entry 5 carries the token of another head (a genuine token, for the wrong data).',
      exit: 5,
      headline: 'Paket tidak lolos pemeriksaan: jangkar waktu untuk entri 5 tidak sah',
      code: 'ANCHOR_INVALID',
      seq: 5,
    },
    reseal(p),
  );
}

{
  const p = copy();
  p.pack_hash = computePackHash({ ...p, generated_at: '2026-01-01T00:00:00.000Z' });
  add(
    {
      file: 'wrong-pack-hash.json',
      description: 'Content unchanged, but pack_hash belongs to different content.',
      exit: 3,
      headline: 'Isi paket berbeda dari sidik jarinya (paket diubah)',
      code: 'PACK_HASH_MISMATCH',
    },
    p,
  );
}

{
  const p = copy() as unknown as { format_version: string };
  p.format_version = '2.0';
  add(
    {
      file: 'unknown-version.json',
      description: 'format_version is not one this verifier knows.',
      exit: 2,
      headline: 'Paket tidak lolos pemeriksaan: versi format paket tidak dikenal',
      code: 'FORMAT_UNSUPPORTED',
    },
    reseal(p as unknown as EvidencePack),
  );
}

mkdirSync(out, { recursive: true });
for (const [e, pack] of fixtures)
  writeFileSync(resolve(out, e.file), `${JSON.stringify(pack, null, 2)}\n`);
writeFileSync(
  resolve(out, 'expected.json'),
  `${JSON.stringify(
    fixtures.map(([e]) => e),
    null,
    2,
  )}\n`,
);
console.log(`wrote ${fixtures.length} fixtures to ${out}`);
