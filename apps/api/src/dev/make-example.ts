// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Regenerates docs/examples/* from fictional data. Anchors come from the local MOCK TSA, whose throwaway CA
// is written next to the packs so they can be verified offline. The tokens prove nothing about real time.
//   pnpm --filter @paper-trail/api example:pack
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  anchorData,
  buildEntry,
  buildEvidencePack,
  buildWitnessMessage,
  canonicalize,
  sha256Hex,
  witnessAuthorRef,
  type AnchorRecord,
  type Entry,
  type PayloadObject,
} from '@paper-trail/chain';
import { extractTokenCertificates } from '@paper-trail/verifier';
import { createMockTsa, fetchMockToken } from '@paper-trail/verifier/testing';
import { renderPackPdf } from '../pdf.js';
import { GENERATOR, packJson, packZip } from '../services/export.js';

const OUT = resolve(import.meta.dirname, '../../../../docs/examples');
const LEDGER = '3b1f7a0e-52c4-4d68-9b0e-7a1c2d3e4f50';
const OWNER = 'owner:00000000-0000-4000-8000-000000000001';
const FILE = Buffer.from('%PDF-1.4\n% Slip gaji contoh (fiktif)\n');

const tsa = await createMockTsa();
try {
  const day = (d: number, h: number, m: number) =>
    new Date(Date.UTC(2026, 9, 26 + d, h - 7, m)).toISOString(); // WIB
  const chain: Entry[] = [];
  const push = (type: Entry['type'], at: string, payload: PayloadObject, author = OWNER) =>
    chain.push(
      buildEntry(
        { ledger_id: LEDGER, type, created_at: at, author_ref: author, payload },
        chain.at(-1) ?? null,
      ),
    );

  push('note', day(0, 17, 5), {
    text: 'Senin: lembur sampai jam 21.00. Atasan bilang uang lembur "nanti saja".',
  });
  push('note', day(1, 18, 20), {
    text: 'Selasa: lembur lagi 3 jam. Rekan kerja Budi ikut lembur di bagian yang sama.',
  });
  push('file', day(2, 9, 0), {
    content_sha256: sha256Hex(FILE),
    size: FILE.length,
    media_type: 'application/pdf',
    name: 'slip-gaji-oktober.pdf',
  });

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const witnessPub = publicKey.export({ format: 'jwk' }).x!;
  const unsigned = {
    invite_id: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
    target_seq: 1,
    target_entry_hash: chain[1]!.entry_hash,
    statement: 'confirm' as const,
    witness_name: 'Budi (contoh)',
    witness_pub: witnessPub,
    alg: 'Ed25519' as const,
    signed_client_time: day(2, 12, 30),
  };
  const signature = sign(
    null,
    Buffer.from(canonicalize(buildWitnessMessage(LEDGER, unsigned))),
    privateKey,
  ).toString('base64url');
  push(
    'witness_cosign',
    day(2, 12, 31),
    { ...unsigned, signature } as unknown as PayloadObject,
    witnessAuthorRef(witnessPub),
  );

  push('note', day(3, 17, 10), {
    text: 'Rabu: gaji bulan ini keluar tanpa uang lembur. Saya minta penjelasan tertulis.',
  });
  push('note', day(4, 8, 45), {
    text: 'Kamis: HRD menjawab lisan, tidak mau memberi jawaban tertulis.',
  });

  const anchor = async (e: Entry): Promise<AnchorRecord> => {
    const token = await fetchMockToken(tsa.url, anchorData(e));
    return {
      v: 1,
      ledger_id: LEDGER,
      head_seq: e.seq,
      head_hash: e.entry_hash,
      anchor_digest: e.entry_hash,
      tsa_label: 'http://mock-tsa.example.invalid/tsr',
      tst: token.toString('base64url'),
      certs: extractTokenCertificates(token).map((c) => Buffer.from(c).toString('base64url')),
      gen_time: new Date().toISOString(),
    };
  };
  const anchors = [await anchor(chain[3]!), await anchor(chain[5]!)];

  const base = {
    generatedAt: new Date().toISOString(),
    generator: GENERATOR,
    ledger: { id: LEDGER, title: 'CONTOH (data fiktif): sengketa uang lembur', category: 'kerja' },
    ledgerHeadSeq: 5,
    payloads: 'all' as const,
    anchors,
  };
  const full = buildEvidencePack({
    ...base,
    entries: chain,
    requestedToSeq: 5,
    filesIncluded: [sha256Hex(FILE)],
  });
  const partial = buildEvidencePack({ ...base, entries: chain.slice(1, 4), requestedToSeq: 2 }); // entries 1–2, bridged to the anchor at 3

  await mkdir(OUT, { recursive: true });
  await writeFile(resolve(OUT, 'example-pack.json'), packJson(full));
  await writeFile(resolve(OUT, 'example-pack-partial.json'), packJson(partial));
  await writeFile(
    resolve(OUT, 'example-pack.zip'),
    packZip({
      pack: full,
      files: new Map([[sha256Hex(FILE), { bytes: FILE, mime: 'application/pdf' }]]),
    }),
  );
  await writeFile(
    resolve(OUT, 'example-pack.pdf'),
    await renderPackPdf(full, 'https://paper-trail.example'),
  );
  await writeFile(resolve(OUT, 'example-tsa-root.pem'), tsa.caPem);
  console.log(
    `Wrote docs/examples/ (full pack ${full.pack_hash.slice(0, 12)}…, partial ${partial.pack_hash.slice(0, 12)}…)`,
  );
} finally {
  await tsa.close();
}
