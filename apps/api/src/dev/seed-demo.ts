// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Seeds a FICTIONAL demo into the local database: a demo account with an unpaid-overtime ledger of 15 entries
// (13 notes + 2 witness co-signs) and 2 anchors from a throwaway MOCK TSA, then writes a valid evidence pack,
// a deliberately tampered copy and the mock TSA root to demo/ for trying out /verify. Safe to re-run: an
// existing demo ledger is reused and only the packs are rewritten. Never run against production data.
//   pnpm demo
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  anchorData,
  buildWitnessMessage,
  canonicalize,
  sha256Hex,
  verifyWitnessSignature,
  witnessAuthorRef,
  type PayloadObject,
  type WitnessCosignPayload,
} from '@paper-trail/chain';
import {
  headline,
  parsePemCertificates,
  verifyEvidencePack,
  verifyTimestampToken,
} from '@paper-trail/verifier';
import { createMockTsa, fetchMockToken, type MockTsa } from '@paper-trail/verifier/testing';
import { hashPassword } from '../auth.js';
import { createDb, type Db } from '../db.js';
import type { Ledger } from '../generated/prisma/client.js';
import { appendEntry, toChainEntry, type StoredEntry } from '../services/ledger.js';
import { buildLedgerExport, packJson } from '../services/export.js';
import { MemoryStore } from '../storage.js';

const OUT = resolve(import.meta.dirname, '../../../../demo');
const ROOT_PEM = resolve(OUT, 'demo-tsa-root.pem');
const EMAIL = 'demo@papertrail.local';
const PASSWORD = 'demo-lembur-2026'; // local demo only; the script refuses NODE_ENV=production
const TITLE = 'DEMO (fiktif): lembur tidak dibayar, PT Contoh Jaya';

/** `daysAgo` days before today at a WIB (UTC+7) wall-clock time. */
const wib = (daysAgo: number, h: number, m: number) => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h - 7, m));
};

// [days ago, hour, minute, text]. Witness co-signs follow notes 1 and 5, making 15 entries in all.
const NOTES: [number, number, number, string][] = [
  [
    20,
    17,
    10,
    'Senin: diminta lembur oleh supervisor (Pak Hendra) sampai 21.30. Tidak ada surat perintah lembur.',
  ],
  [
    19,
    21,
    45,
    'Selasa: lembur lagi sampai 21.30, stok gudang. Budi (rekan satu shift) juga lembur.',
  ],
  [
    18,
    22,
    5,
    'Rabu: lembur 4 jam. Saya foto papan absen manual jam 22.00 (absen elektronik mati setelah 17.00).',
  ],
  [
    17,
    8,
    30,
    'Kamis: tanya HRD soal formulir lembur. Jawaban lisan: "lembur di gudang tidak dihitung".',
  ],
  [16, 21, 50, 'Jumat: lembur sampai 21.45. Total minggu ini sekitar 15 jam di luar jam kerja.'],
  [13, 21, 40, 'Senin: lembur 3,5 jam. Satpam (Sari) mencatat jam keluar saya di buku tamu pos.'],
  [12, 22, 0, 'Selasa: lembur 4 jam. Supervisor mengirim pesan WhatsApp minta tetap tinggal.'],
  [11, 9, 15, 'Rabu: menyimpan tangkapan layar pesan WhatsApp supervisor dari kemarin.'],
  [9, 21, 35, 'Jumat: lembur 3 jam. Total dua minggu sekitar 28 jam.'],
  [5, 10, 0, 'Selasa: slip gaji keluar. Tidak ada komponen upah lembur sama sekali.'],
  [4, 14, 20, 'Rabu: email ke HRD minta rincian perhitungan upah lembur sesuai aturan pengupahan.'],
  [2, 16, 45, 'Jumat: belum ada jawaban HRD. Menghubungi serikat pekerja untuk konsultasi.'],
  [1, 15, 10, 'Sabtu: HRD menjawab "akan dicek". Catatan ini disiapkan untuk mediasi.'],
];
const WITNESSES = [
  { after: 1, name: 'Budi (rekan kerja, contoh)', minutesLater: 50 },
  { after: 5, name: 'Sari (satpam, contoh)', minutesLater: 35 },
];

/** A witness co-sign through the same steps as POST /witness/:token/sign: invite, device key, signature. */
const cosign = async (db: Db, ledgerId: string, target: StoredEntry, name: string, at: Date) => {
  const invite = await db.witnessInvite.create({
    data: {
      ledgerId,
      targetEntryId: target.id,
      tokenHash: sha256Hex(randomBytes(32)),
      expiresAt: new Date(Date.now() + 3_600_000),
      ownerDisplayName: 'Rina (pekerja gudang, contoh)',
    },
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const unsigned = {
    invite_id: invite.id,
    target_seq: target.seq,
    target_entry_hash: target.entry_hash,
    statement: 'confirm' as const,
    witness_name: name,
    witness_pub: publicKey.export({ format: 'jwk' }).x!,
    alg: 'Ed25519' as const,
    signed_client_time: at.toISOString(),
  };
  const message = Buffer.from(canonicalize(buildWitnessMessage(ledgerId, unsigned)));
  const payload: WitnessCosignPayload = {
    ...unsigned,
    signature: sign(null, message, privateKey).toString('base64url'),
  };
  if (!(await verifyWitnessSignature(ledgerId, payload)).ok)
    throw new Error('demo witness signature does not verify');
  return appendEntry(
    db,
    ledgerId,
    {
      type: 'witness_cosign',
      authorRef: witnessAuthorRef(payload.witness_pub),
      payload: payload as unknown as PayloadObject,
    },
    () => at,
    {
      beforeInsert: async (tx) => {
        await tx.witnessInvite.update({ where: { id: invite.id }, data: { usedAt: at } });
      },
      afterInsert: async (tx, entry) => {
        await tx.witness.create({
          data: {
            ledgerId,
            inviteId: invite.id,
            targetEntryId: target.id,
            cosignEntryId: entry.id,
            displayName: name,
            publicKey: payload.witness_pub,
            alg: payload.alg,
            signature: payload.signature,
            signedAt: at,
          },
        });
      },
    },
  );
};

const ensureDemoLedger = async (db: Db): Promise<Ledger> => {
  const user =
    (await db.user.findUnique({ where: { email: EMAIL } })) ??
    (await db.user.create({ data: { email: EMAIL, passwordHash: await hashPassword(PASSWORD) } }));
  const existing = await db.ledger.findFirst({ where: { ownerId: user.id, title: TITLE } });
  if (existing) return existing;

  const ledger = await db.ledger.create({
    data: { ownerId: user.id, title: TITLE, category: 'kerja' },
  });
  const entries: StoredEntry[] = [];
  for (const [i, [days, h, m, text]] of NOTES.entries()) {
    const note = await appendEntry(
      db,
      ledger.id,
      { type: 'note', authorRef: `owner:${user.id}`, payload: { text } },
      () => wib(days, h, m),
    );
    entries.push(note);
    const w = WITNESSES.find((x) => x.after === i);
    if (w) {
      const at = new Date(Date.parse(note.created_at) + w.minutesLater * 60_000);
      entries.push(await cosign(db, ledger.id, note, w.name, at));
    }
  }
  if (entries.length !== 15) throw new Error(`expected 15 demo entries, got ${entries.length}`);
  return db.ledger.findUniqueOrThrow({ where: { id: ledger.id } });
};

/** Anchors heads 7 and 14 with the mock TSA, as the worker would. Returns how many it created. */
const ensureAnchors = async (db: Db, ledger: Ledger, tsa: MockTsa) => {
  let created = 0;
  for (const seq of [7, 14]) {
    if (await db.anchor.findFirst({ where: { ledgerId: ledger.id, anchoredHeadSeq: seq } }))
      continue;
    const head = toChainEntry(
      await db.entry.findUniqueOrThrow({
        where: { ledgerId_seq: { ledgerId: ledger.id, seq } },
      }),
    );
    const token = await fetchMockToken(tsa.url, anchorData(head));
    const { genTime } = await verifyTimestampToken(token, anchorData(head), [tsa.caCert]);
    await db.anchor.create({
      data: {
        ledgerId: ledger.id,
        anchoredHeadSeq: seq,
        anchoredHeadHash: head.entry_hash,
        anchorDigest: head.entry_hash,
        tsaUrl: 'http://mock-tsa.demo.invalid/tsr',
        tstToken: new Uint8Array(token),
        tstGenTime: genTime,
        status: 'ok',
        attempts: 1,
      },
    });
    created++;
  }
  return created;
};

if (process.env['NODE_ENV'] === 'production')
  throw new Error('refusing to seed demo data with NODE_ENV=production');
const url = process.env['DATABASE_URL'];
if (!url) throw new Error('DATABASE_URL is not set. Run `pnpm infra:up` and the migrations first.');

const db = createDb(url);
const tsa = await createMockTsa(); // a fresh throwaway CA every run
try {
  const ledger = await ensureDemoLedger(db);
  await mkdir(OUT, { recursive: true });
  // Anchors made on an earlier run were signed by that run's CA, so keep its root rather than this one.
  // Without it (another checkout seeded this database) the anchors still verify, minus the certificate chain.
  const rootPem =
    (await ensureAnchors(db, ledger, tsa)) > 0
      ? tsa.caPem
      : await readFile(ROOT_PEM, 'utf8').catch(() => {
          console.warn(
            `No ${ROOT_PEM} for the existing demo anchors: the TSA chain will not be checked.`,
          );
          return '';
        });

  const { pack } = await buildLedgerExport(
    db,
    new MemoryStore(),
    ledger,
    { payloads: 'all', includeTitle: true, includeFiles: false, anchorBridge: true },
    0,
  );
  // What someone without the hash formula would try: change one figure in an old note, hashes untouched.
  const tampered = structuredClone(pack);
  const victim = tampered.entries.find((e) => e.seq === 3)!; // "Rabu: … jam 22.00"
  victim.payload = { text: String(victim.payload?.['text']).replace('22.00', '20.00') };

  await writeFile(resolve(OUT, 'demo-pack.json'), packJson(pack));
  await writeFile(
    resolve(OUT, 'demo-pack-tampered.json'),
    `${JSON.stringify(tampered, null, 2)}\n`,
  );
  if (rootPem) await writeFile(ROOT_PEM, rootPem);

  // Self-check: the valid pack verifies against the mock root, the tampered one must not.
  const trustedCerts = rootPem ? parsePemCertificates(rootPem) : [];
  const good = await verifyEvidencePack(JSON.parse(packJson(pack).toString()), { trustedCerts });
  const bad = await verifyEvidencePack(tampered, { trustedCerts });
  console.log(`demo/demo-pack.json          → ${headline(good)}`);
  console.log(`demo/demo-pack-tampered.json → ${headline(bad)}`);
  if (good.verdict !== 'OK' || bad.verdict !== 'FAILED') throw new Error('demo self-check failed');

  console.log(`
Demo ready. FICTIONAL data; the mock TSA's anchors prove nothing about real time.
  Owner app:  log in as ${EMAIL} / ${PASSWORD}
  Verifier:   open /verify and upload demo/demo-pack.json, then demo/demo-pack-tampered.json;
              add demo/demo-tsa-root.pem as the TSA root to check the anchors' certificate chain too.`);
} finally {
  await tsa.close();
  await db.$disconnect();
}
