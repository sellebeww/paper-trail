// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { renderPackPdf } from '../pdf.js';
import { buildLedgerExport, packJson, packZip, type ExportOptions } from '../services/export.js';
import { ownLedger } from './ledgers.js';

const idParams = z.object({ id: z.uuid() });
const seq = z.number().int().min(0);

const selection = {
  from_seq: seq.optional(),
  to_seq: seq.optional(),
  from_date: z.iso.datetime().optional(),
  to_date: z.iso.datetime().optional(),
  payloads: z.union([z.literal('all'), z.literal('none'), z.array(seq).max(10_000)]).default('all'),
  include_title: z.boolean().default(true),
  anchor_bridge: z.boolean().default(true),
};

const oneBound = (b: {
  from_seq?: number;
  from_date?: string;
  to_seq?: number;
  to_date?: string;
}) => !(b.from_seq !== undefined && b.from_date) && !(b.to_seq !== undefined && b.to_date);
const BOUND_MESSAGE = 'Pilih rentang berdasarkan nomor ATAU tanggal, jangan keduanya.';

const postBody = z
  .object({
    ...selection,
    include_files: z.boolean().default(false),
    format: z.enum(['json', 'zip']).optional(),
  })
  .strict()
  .refine(oneBound, BOUND_MESSAGE)
  .refine(
    (b) => !(b.format === 'json' && b.include_files),
    'Berkas hanya bisa disertakan dalam format zip.',
  );

/** Query-string flavour of the same selection (GET has no body). */
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const pdfQuery = z
  .object({
    from_seq: z.coerce.number().int().min(0).optional(),
    to_seq: z.coerce.number().int().min(0).optional(),
    from_date: z.iso.datetime().optional(),
    to_date: z.iso.datetime().optional(),
    payloads: z
      .string()
      .regex(/^(all|none|\d+(,\d+)*)$/, 'payloads: all, none, atau daftar nomor dipisah koma')
      .default('all'),
    include_title: bool.default(true),
    anchor_bridge: bool.default(true),
    generated_at: z.iso.datetime().optional(),
  })
  .refine(oneBound, BOUND_MESSAGE);

const MAX_PAST_MS = 30 * 24 * 3_600_000;

type Selection = {
  from_seq?: number | undefined;
  to_seq?: number | undefined;
  from_date?: string | undefined;
  to_date?: string | undefined;
  payloads: 'all' | 'none' | number[];
  include_title: boolean;
  anchor_bridge: boolean;
};

const toOptions = (b: Selection, includeFiles: boolean): ExportOptions => ({
  ...(b.from_seq !== undefined ? { fromSeq: b.from_seq } : {}),
  ...(b.to_seq !== undefined ? { toSeq: b.to_seq } : {}),
  ...(b.from_date ? { fromDate: new Date(b.from_date) } : {}),
  ...(b.to_date ? { toDate: new Date(b.to_date) } : {}),
  payloads: b.payloads,
  includeTitle: b.include_title,
  includeFiles,
  anchorBridge: b.anchor_bridge,
});

const fileName = (ledgerId: string, from: number, to: number, ext: string) =>
  `paper-trail-${ledgerId.slice(0, 8)}-${from}-${to}.${ext}`;

export const exportRoutes = ({ db, store, config }: AppContext): Router => {
  const router = Router();
  const limiter = rateLimit({
    windowMs: 10 * 60_000,
    limit: config.EXPORT_RATE_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(
        new AppError(
          429,
          'RATE_LIMITED',
          'Terlalu banyak permintaan ekspor. Coba lagi beberapa menit lagi.',
        ),
      ),
  });

  router.post('/ledgers/:id/export', limiter, async (req, res) => {
    const ledger = await ownLedger(db, res, idParams.parse(req.params).id);
    const body = postBody.parse(req.body ?? {});
    const zip = (body.format ?? (body.include_files ? 'zip' : 'json')) === 'zip';
    const built = await buildLedgerExport(
      db,
      store,
      ledger,
      toOptions(body, body.include_files),
      config.EXPORT_MAX_FILES_BYTES,
    );
    const { pack } = built;
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Pack-Hash', pack.pack_hash);
    const name = fileName(ledger.id, pack.scope.from_seq, pack.scope.to_seq, zip ? 'zip' : 'json');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    if (zip) res.type('application/zip').send(packZip(built));
    else res.type('application/json').send(packJson(pack));
  });

  router.get('/ledgers/:id/export.pdf', limiter, async (req, res) => {
    const ledger = await ownLedger(db, res, idParams.parse(req.params).id);
    const q = pdfQuery.parse(req.query);
    const generatedAt = q.generated_at ? new Date(q.generated_at) : undefined;
    if (
      generatedAt &&
      (generatedAt.getTime() > Date.now() + 60_000 ||
        generatedAt.getTime() < Date.now() - MAX_PAST_MS)
    ) {
      throw new AppError(
        400,
        'INVALID_GENERATED_AT',
        'generated_at harus dalam 30 hari terakhir dan tidak di masa depan.',
      );
    }
    const payloads =
      q.payloads === 'all' || q.payloads === 'none'
        ? q.payloads
        : q.payloads.split(',').map(Number);
    const options = toOptions({ ...q, payloads }, false);
    const { pack } = await buildLedgerExport(
      db,
      store,
      ledger,
      { ...options, ...(generatedAt ? { generatedAt } : {}) },
      0,
    );
    const pdf = await renderPackPdf(pack, config.WEB_ORIGIN);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Pack-Hash', pack.pack_hash);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName(ledger.id, pack.scope.from_seq, pack.scope.to_seq, 'pdf')}"`,
    );
    res.type('application/pdf').send(pdf);
  });

  return router;
};
