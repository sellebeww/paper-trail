// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import {
  buildEvidencePack,
  type AnchorRecord,
  type Entry,
  type EvidencePack,
} from '@paper-trail/chain';
import { extractTokenCertificates } from '@paper-trail/verifier';
import { zipSync } from 'fflate';
import type { Db } from '../db.js';
import { AppError } from '../errors.js';
import type { Ledger } from '../generated/prisma/client.js';
import type { ObjectStore } from '../storage.js';
import { ALLOWED_TYPES } from '../uploads.js';
import { toChainEntry } from './ledger.js';

export const GENERATOR = { name: 'paper-trail', version: '0.1.0' } as const;

export interface ExportOptions {
  fromSeq?: number;
  toSeq?: number;
  fromDate?: Date;
  toDate?: Date;
  payloads: 'all' | 'none' | number[];
  includeTitle: boolean;
  includeFiles: boolean;
  /** Extend a partial range with envelope-only entries up to the next confirmed anchor (SPEC §6.2). */
  anchorBridge: boolean;
  /** Label only (SPEC §6.3). Lets a PDF be rebuilt identically to a JSON pack downloaded earlier. */
  generatedAt?: Date;
}

const invalidRange = (message: string) => new AppError(400, 'INVALID_RANGE', message);

/** Resolves seq or date bounds to an inclusive [from, to] range inside the ledger. */
const resolveRange = async (db: Db, ledger: Ledger, head: number, o: ExportOptions) => {
  let from = o.fromSeq ?? 0;
  let to = o.toSeq ?? head;
  if (o.fromDate) {
    const first = await db.entry.findFirst({
      where: { ledgerId: ledger.id, createdAt: { gte: o.fromDate } },
      orderBy: { seq: 'asc' },
      select: { seq: true },
    });
    if (!first) throw invalidRange('Tidak ada catatan pada atau setelah tanggal awal itu.');
    from = first.seq;
  }
  if (o.toDate) {
    const last = await db.entry.findFirst({
      where: { ledgerId: ledger.id, createdAt: { lte: o.toDate } },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    if (!last) throw invalidRange('Tidak ada catatan pada atau sebelum tanggal akhir itu.');
    to = last.seq;
  }
  if (to > head) throw invalidRange(`Catatan terakhir adalah nomor ${head}.`);
  if (from > to) throw invalidRange('Rentang kosong: awal lebih besar dari akhir.');
  return { from, to };
};

const anchorRecord = (a: {
  ledgerId: string;
  anchoredHeadSeq: number;
  anchoredHeadHash: string;
  anchorDigest: string;
  tsaUrl: string;
  tstToken: Uint8Array | null;
  tstGenTime: Date | null;
}): AnchorRecord => {
  const token = Buffer.from(a.tstToken!);
  return {
    v: 1,
    ledger_id: a.ledgerId,
    head_seq: a.anchoredHeadSeq,
    head_hash: a.anchoredHeadHash,
    anchor_digest: a.anchorDigest,
    tsa_label: a.tsaUrl,
    tst: token.toString('base64url'),
    certs: extractTokenCertificates(token).map((c) => Buffer.from(c).toString('base64url')),
    gen_time: a.tstGenTime!.toISOString(),
  };
};

export interface BuiltExport {
  pack: EvidencePack;
  /** sha256 → bytes, for the zip. Empty unless includeFiles. */
  files: Map<string, { bytes: Buffer; mime: string }>;
}

/**
 * Builds an evidence pack for one ledger (SPEC §6). Reads only; the pack is assembled by
 * packages/chain so the format has a single definition.
 */
export const buildLedgerExport = async (
  db: Db,
  store: ObjectStore,
  ledger: Ledger,
  o: ExportOptions,
  maxFileBytes: number,
): Promise<BuiltExport> => {
  if (ledger.headSeq === null)
    throw new AppError(400, 'EMPTY_LEDGER', 'Ledger ini belum punya catatan.');
  const head = ledger.headSeq;
  const { from, to: requestedTo } = await resolveRange(db, ledger, head, o);

  const confirmedWhere = { ledgerId: ledger.id, status: 'ok' as const, tstToken: { not: null } };
  let to = requestedTo;
  if (o.anchorBridge && requestedTo < head) {
    const next = await db.anchor.findFirst({
      where: { ...confirmedWhere, anchoredHeadSeq: { gte: requestedTo } },
      orderBy: { anchoredHeadSeq: 'asc' },
      select: { anchoredHeadSeq: true },
    });
    if (next) to = next.anchoredHeadSeq;
  }

  const rows = await db.entry.findMany({
    where: { ledgerId: ledger.id, seq: { gte: from, lte: to } },
    orderBy: { seq: 'asc' },
  });
  if (rows.length !== to - from + 1) throw new Error('entries are not contiguous'); // cannot happen: triggers + UNIQUE
  const entries: Entry[] = rows.map(toChainEntry);

  const anchors = await db.anchor.findMany({
    where: { ...confirmedWhere, anchoredHeadSeq: { gte: from, lte: to } },
    orderBy: { anchoredHeadSeq: 'asc' },
  });

  const candidateFiles = entries
    .filter((e) => e.seq <= requestedTo && e.payload && (e.type === 'photo' || e.type === 'file'))
    .map((e) => (e.payload as { content_sha256: string }).content_sha256);

  const pack = buildEvidencePack({
    generatedAt: (o.generatedAt ?? new Date()).toISOString(),
    generator: GENERATOR,
    ledger: {
      id: ledger.id,
      category: ledger.category,
      ...(o.includeTitle ? { title: ledger.title } : {}),
    },
    entries,
    requestedToSeq: requestedTo,
    ledgerHeadSeq: head,
    payloads: o.payloads,
    anchors: anchors.map(anchorRecord),
    ...(o.includeFiles ? { filesIncluded: candidateFiles } : {}),
  });

  const files = new Map<string, { bytes: Buffer; mime: string }>();
  if (o.includeFiles && pack.disclosure.files_included.length) {
    const attachments = await db.attachment.findMany({
      where: { sha256: { in: pack.disclosure.files_included }, entry: { ledgerId: ledger.id } },
      distinct: ['sha256'],
    });
    const total = attachments.reduce((n, a) => n + a.sizeBytes, 0);
    if (total > maxFileBytes) {
      throw new AppError(
        413,
        'EXPORT_TOO_LARGE',
        'Berkas terlalu besar untuk satu paket. Pilih rentang yang lebih kecil atau ekspor tanpa berkas.',
      );
    }
    for (const a of attachments) {
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of await store.get(a.storageKey))
          chunks.push(Buffer.from(chunk as Uint8Array));
      } catch {
        throw new AppError(
          503,
          'STORAGE_UNAVAILABLE',
          'Berkas sementara tidak dapat diambil. Coba lagi nanti.',
        );
      }
      files.set(a.sha256, { bytes: Buffer.concat(chunks), mime: a.mime });
    }
  }
  return { pack, files };
};

const README_ID = [
  'PAKET BUKTI PAPER TRAIL',
  '',
  'Isi:',
  '  pack.json   paket bukti (rantai catatan, tanda tangan saksi, jangkar waktu)',
  '  files/      berkas lampiran, diberi nama sesuai kode SHA-256 isinya',
  '',
  'Cara memeriksa (tanpa akun, tanpa internet):',
  '  npx paper-trail-verify paket.zip --roots akar-tsa.pem',
  'atau buka halaman /verify Paper Trail (pemeriksaan berjalan di browser, paket tidak dikirim),',
  'atau ikuti docs/VERIFY.md untuk memeriksa hanya dengan Python dan OpenSSL.',
  '',
  'Paper Trail membantu membuktikan bahwa catatan tidak diubah setelah dibuat dan kapan catatan itu ada.',
  'Ini bukan nasihat hukum dan tidak menjamin penerimaan sebagai alat bukti. Konsultasikan dengan pendamping hukum.',
  '',
].join('\n');

export const packJson = (pack: EvidencePack) =>
  Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, 'utf8');

/** pack.json + README.txt + files/<sha256>.<ext>. Files are stored, not compressed (they already are). */
export const packZip = ({ pack, files }: BuiltExport): Buffer => {
  const parts: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    'pack.json': packJson(pack),
    'README.txt': Buffer.from(README_ID, 'utf8'),
  };
  for (const [sha, f] of files) {
    parts[`files/${sha}.${ALLOWED_TYPES[f.mime]?.ext ?? 'bin'}`] = [f.bytes, { level: 0 }];
  }
  return Buffer.from(zipSync(parts));
};
