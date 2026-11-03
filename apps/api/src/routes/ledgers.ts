// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { pipeline } from 'node:stream/promises';
import type { PayloadObject } from '@paper-trail/chain';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db.js';
import { AppError, notFound } from '../errors.js';
import type { Attachment, Entry as EntryRow, Ledger } from '../generated/prisma/client.js';
import type { ObjectStore } from '../storage.js';
import { ALLOWED_TYPES, readUpload } from '../uploads.js';
import { appendEntry, toChainEntry, type StoredEntry } from '../services/ledger.js';

const idParams = z.object({ id: z.uuid() });

// Text goes into jsonb and into JCS: NUL is not storable and lone surrogates cannot be canonicalized.
const text = (max: number) =>
  z
    .string()
    .refine(
      (s) => s.isWellFormed() && !s.includes('\u0000'),
      'Teks mengandung karakter yang tidak valid.',
    )
    .transform((s) => s.normalize('NFC')) // SPEC §1: the server normalizes text to NFC before hashing
    .pipe(z.string().min(1).max(max))
    .refine((s) => s.trim().length > 0, 'Teks tidak boleh kosong.');

const createLedgerBody = z
  .object({
    title: text(120),
    category: z.enum(['kerja', 'sewa', 'freelance', 'gig', 'lainnya']),
  })
  .strict();

const noteBody = z.object({ type: z.literal('note'), text: text(10_000) }).strict();

const listQuery = z.object({
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const entryJson = (e: StoredEntry) => ({
  id: e.id,
  v: e.v,
  ledger_id: e.ledger_id,
  seq: e.seq,
  type: e.type,
  created_at: e.created_at,
  author_ref: e.author_ref,
  payload_hash: e.payload_hash,
  prev_hash: e.prev_hash,
  entry_hash: e.entry_hash,
  payload: e.payload,
});

const rowJson = (row: EntryRow) => entryJson({ ...toChainEntry(row), id: row.id });

const ledgerJson = (l: Ledger) => ({
  id: l.id,
  title: l.title,
  category: l.category,
  head_seq: l.headSeq,
  head_hash: l.headHash,
  created_at: l.createdAt.toISOString(),
});

const headJson = (
  ledgerId: string,
  headSeq: number | null,
  headHash: string | null,
  headCreatedAt: string | null,
) => ({
  ledger_id: ledgerId,
  head_seq: headSeq,
  head_hash: headHash,
  head_created_at: headCreatedAt,
  server_time: new Date().toISOString(),
});

/** The caller's ledger, or 404. A foreign ledger is indistinguishable from a missing one. */
export const ownLedger = async (db: Db, res: Response, id: string): Promise<Ledger> => {
  const auth = requireAuth(res);
  const ledger = await db.ledger.findFirst({ where: { id, ownerId: auth.user.id } });
  if (!ledger) throw notFound('Ledger');
  return ledger;
};

const sendAppended = (res: Response, entry: StoredEntry) => {
  res.setHeader('X-Ledger-Head-Seq', String(entry.seq));
  res.setHeader('X-Ledger-Head-Hash', entry.entry_hash);
  res.status(201).json({
    entry: entryJson(entry),
    head: headJson(entry.ledger_id, entry.seq, entry.entry_hash, entry.created_at),
  });
};

const asciiName = (name: string) => name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

export const ledgerRoutes = ({ db, store, config }: AppContext): Router => {
  const router = Router();

  router.post('/ledgers', async (req, res) => {
    const auth = requireAuth(res);
    const body = createLedgerBody.parse(req.body);
    const ledger = await db.ledger.create({ data: { ownerId: auth.user.id, ...body } });
    res.status(201).json({ ledger: ledgerJson(ledger) });
  });

  router.get('/ledgers', async (_req, res) => {
    const auth = requireAuth(res);
    const ledgers = await db.ledger.findMany({
      where: { ownerId: auth.user.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ ledgers: ledgers.map(ledgerJson) });
  });

  router.get('/ledgers/:id', async (req, res) => {
    const ledger = await ownLedger(db, res, idParams.parse(req.params).id);
    const anchorJson = (
      a: {
        status: string;
        anchoredHeadSeq: number;
        anchoredHeadHash: string;
        tstGenTime: Date | null;
        tsaUrl: string;
        attempts: number;
        updatedAt: Date;
      } | null,
    ) =>
      a && {
        status: a.status,
        anchored_head_seq: a.anchoredHeadSeq,
        anchored_head_hash: a.anchoredHeadHash,
        gen_time: a.tstGenTime?.toISOString() ?? null,
        tsa_url: a.tsaUrl || null,
        attempts: a.attempts,
        updated_at: a.updatedAt.toISOString(),
      };
    const [last, confirmed] = await Promise.all([
      db.anchor.findFirst({
        where: { ledgerId: ledger.id },
        orderBy: [{ anchoredHeadSeq: 'desc' }, { createdAt: 'desc' }],
      }),
      db.anchor.findFirst({
        where: { ledgerId: ledger.id, status: 'ok' },
        orderBy: { anchoredHeadSeq: 'desc' },
      }),
    ]);
    res.json({
      ledger: ledgerJson(ledger),
      last_anchor: anchorJson(last),
      last_confirmed_anchor: anchorJson(confirmed),
      // Entries with no external time proof yet (SPEC §8, UNANCHORED_TAIL).
      unanchored_entries:
        ledger.headSeq === null ? 0 : ledger.headSeq - (confirmed?.anchoredHeadSeq ?? -1),
    });
  });

  router.get('/ledgers/:id/head', async (req, res) => {
    const ledger = await ownLedger(db, res, idParams.parse(req.params).id);
    const headEntry =
      ledger.headSeq === null
        ? null
        : await db.entry.findUnique({
            where: { ledgerId_seq: { ledgerId: ledger.id, seq: ledger.headSeq } },
            select: { createdAt: true },
          });
    res.setHeader('Cache-Control', 'no-store');
    res.json(
      headJson(
        ledger.id,
        ledger.headSeq,
        ledger.headHash,
        headEntry?.createdAt.toISOString() ?? null,
      ),
    );
  });

  // Cursor = last seq already seen. seq is immutable and only grows, so appends during paging
  // can only add entries at the end; pages never skip or repeat an entry.
  router.get('/ledgers/:id/entries', async (req, res) => {
    const ledger = await ownLedger(db, res, idParams.parse(req.params).id);
    const { cursor, limit } = listQuery.parse(req.query);
    const rows = await db.entry.findMany({
      where: { ledgerId: ledger.id, seq: { gt: cursor ?? -1 } },
      orderBy: { seq: 'asc' },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    res.json({
      entries: page.map(rowJson),
      next_cursor: rows.length > limit ? page[page.length - 1]!.seq : null,
    });
  });

  router.post('/ledgers/:id/entries', async (req, res) => {
    const ledger = await ownLedger(db, res, idParams.parse(req.params).id);
    const body = noteBody.parse(req.body);
    const entry = await appendEntry(db, ledger.id, {
      type: 'note',
      authorRef: `owner:${requireAuth(res).user.id}`,
      payload: { text: body.text },
    });
    sendAppended(res, entry);
  });

  router.post('/ledgers/:id/entries/upload', async (req, res) => {
    const ledger = await ownLedger(db, res, idParams.parse(req.params).id); // before reading any bytes
    const upload = await readUpload(req, store, config.UPLOAD_MAX_BYTES);
    try {
      const type = upload.fields['type'] === 'photo' ? 'photo' : 'file';
      const caption = upload.fields['caption']
        ? text(500).parse(upload.fields['caption'])
        : undefined;
      const common = { content_sha256: upload.sha256, size: upload.size, media_type: upload.mime };
      const payload: PayloadObject =
        type === 'photo'
          ? { ...common, ...(caption ? { caption } : {}) }
          : { ...common, name: upload.filename };
      const entry = await appendEntry(db, ledger.id, {
        type,
        authorRef: `owner:${requireAuth(res).user.id}`,
        payload,
        attachment: {
          storageKey: upload.storageKey,
          mime: upload.mime,
          sizeBytes: upload.size,
          sha256: upload.sha256,
        },
      });
      sendAppended(res, entry);
    } catch (err) {
      await store.delete(upload.storageKey).catch(() => undefined);
      throw err;
    }
  });

  router.get('/entries/:id/attachment', async (req, res) => {
    const auth = requireAuth(res);
    const attachment = await db.attachment.findFirst({
      where: { entry: { id: idParams.parse(req.params).id, ledger: { ownerId: auth.user.id } } },
      include: { entry: true },
    });
    if (!attachment) throw notFound('Lampiran');
    await sendAttachment(res, store, attachment, 'attachment');
  });

  return router;
};

/**
 * Streams a stored file after the caller has authorized access. `inline` lets a witness view a photo
 * in the page; the sandboxing CSP and nosniff still stop the file from running as a document.
 */
export const sendAttachment = async (
  res: Response,
  store: ObjectStore,
  attachment: Attachment & { entry: EntryRow },
  disposition: 'attachment' | 'inline',
) => {
  let body;
  try {
    body = await store.get(attachment.storageKey);
  } catch {
    throw new AppError(
      503,
      'STORAGE_UNAVAILABLE',
      'Berkas sementara tidak dapat diambil. Coba lagi nanti.',
    );
  }
  const payload = attachment.entry.payload as { name?: string };
  const ext = ALLOWED_TYPES[attachment.mime]?.ext ?? 'bin';
  const name = payload.name ?? `foto-${attachment.entry.seq}.${ext}`;
  res.setHeader('Content-Type', attachment.mime);
  res.setHeader('Content-Length', String(attachment.sizeBytes));
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  await pipeline(body, res);
};
