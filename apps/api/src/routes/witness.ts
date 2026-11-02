// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import {
  buildWitnessMessage,
  isValidWitnessName,
  sha256Hex,
  verifyWitnessSignature,
  witnessAuthorRef,
  type PayloadObject,
  type WitnessCosignPayload,
} from '@paper-trail/chain';
import { Router, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { newToken, requireAuth } from '../auth.js';
import type { AppContext } from '../context.js';
import type { Db } from '../db.js';
import { AppError, notFound } from '../errors.js';
import type { Entry as EntryRow, Witness, WitnessInvite } from '../generated/prisma/client.js';
import { appendEntry } from '../services/ledger.js';
import { sendAttachment } from './ledgers.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const idParams = z.object({ id: z.uuid() });

const createInviteBody = z
  .object({
    expires_in_hours: z.number().int().min(1).max(720).optional(),
    owner_display_name: z
      .string()
      .transform((s) => s.normalize('NFC').trim())
      .pipe(z.string().min(1).max(80))
      .refine((s) => s.isWellFormed() && !/\p{Cc}/u.test(s), 'Nama tidak valid.')
      .optional(),
  })
  .strict();

const signBody = z
  .object({
    alg: z.enum(['Ed25519', 'ES256']),
    witness_pub: z.string().max(100),
    signature: z.string().max(100),
    witness_name: z.string().max(400),
    signed_client_time: z.string().max(30),
  })
  .strict();

/**
 * One response for every unusable token — unknown, malformed, expired, used or revoked — so a guesser
 * learns nothing about which tokens exist (THREAT_MODEL §5.2).
 */
const unavailable = () =>
  new AppError(
    404,
    'INVITE_UNAVAILABLE',
    'Tautan saksi ini tidak berlaku. Minta tautan baru kepada orang yang mengirimkannya.',
  );

type InviteStatus = 'open' | 'used' | 'revoked' | 'expired';
const statusOf = (i: WitnessInvite, now = new Date()): InviteStatus =>
  i.usedAt ? 'used' : i.revokedAt ? 'revoked' : i.expiresAt <= now ? 'expired' : 'open';

const inviteJson = (i: WitnessInvite & { witness: Witness | null }) => ({
  id: i.id,
  entry_id: i.targetEntryId,
  status: statusOf(i),
  owner_display_name: i.ownerDisplayName,
  created_at: i.createdAt.toISOString(),
  expires_at: i.expiresAt.toISOString(),
  used_at: i.usedAt?.toISOString() ?? null,
  revoked_at: i.revokedAt?.toISOString() ?? null,
  witness: i.witness && {
    display_name: i.witness.displayName,
    alg: i.witness.alg,
    signed_at: i.witness.signedAt.toISOString(),
    cosign_entry_id: i.witness.cosignEntryId,
  },
});

/** The invite behind a token, only while it can still be used. */
const openInvite = async (db: Db, token: string) => {
  if (!TOKEN.test(token)) return null;
  const invite = await db.witnessInvite.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { targetEntry: true },
  });
  return invite && statusOf(invite) === 'open' ? invite : null;
};

const envelope = (e: {
  v: 1;
  ledger_id: string;
  seq: number;
  type: string;
  created_at: string;
  author_ref: string;
  payload_hash: string;
  prev_hash: string;
  entry_hash: string;
}) => ({
  v: e.v,
  ledger_id: e.ledger_id,
  seq: e.seq,
  type: e.type,
  created_at: e.created_at,
  author_ref: e.author_ref,
  payload_hash: e.payload_hash,
  prev_hash: e.prev_hash,
  entry_hash: e.entry_hash,
});

export const witnessRoutes = ({ db, store, config }: AppContext): Router => {
  const router = Router();

  // ---- Owner side ----------------------------------------------------------------------------

  const ownEntry = async (res: Response, id: string): Promise<EntryRow> => {
    const auth = requireAuth(res);
    const entry = await db.entry.findFirst({ where: { id, ledger: { ownerId: auth.user.id } } });
    if (!entry) throw notFound('Catatan');
    return entry;
  };

  router.post('/entries/:id/witness-invites', async (req, res) => {
    const entry = await ownEntry(res, idParams.parse(req.params).id);
    const body = createInviteBody.parse(req.body);
    if (entry.type === 'witness_cosign') {
      throw new AppError(400, 'INVALID_TARGET', 'Tanda tangan saksi tidak bisa disaksikan lagi.');
    }
    const token = newToken();
    const hours = body.expires_in_hours ?? config.WITNESS_INVITE_TTL_HOURS;
    const invite = await db.witnessInvite.create({
      data: {
        ledgerId: entry.ledgerId,
        targetEntryId: entry.id,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + hours * 3_600_000),
        ownerDisplayName: body.owner_display_name ?? null,
      },
      include: { witness: true },
    });
    res.setHeader('Cache-Control', 'no-store');
    // The token is in the URL fragment, which browsers never send to any server.
    res.status(201).json({
      invite: inviteJson(invite),
      token,
      url: `${new URL(config.WEB_ORIGIN).origin}/saksi#${token}`,
    });
  });

  router.get('/entries/:id/witness-invites', async (req, res) => {
    const entry = await ownEntry(res, idParams.parse(req.params).id);
    const invites = await db.witnessInvite.findMany({
      where: { targetEntryId: entry.id },
      include: { witness: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ invites: invites.map(inviteJson) });
  });

  router.delete('/witness-invites/:id', async (req, res) => {
    const auth = requireAuth(res);
    const { id } = idParams.parse(req.params);
    const invite = await db.witnessInvite.findFirst({
      where: { id, ledger: { ownerId: auth.user.id } },
    });
    if (!invite) throw notFound('Undangan');
    if (invite.revokedAt) return void res.status(204).end();
    // Conditional update: loses cleanly against a witness signing at the same moment.
    const { count } = await db.witnessInvite.updateMany({
      where: { id, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0)
      throw new AppError(409, 'INVITE_USED', 'Undangan ini sudah dipakai dan tidak bisa dicabut.');
    res.status(204).end();
  });

  // ---- Public (witness) side -----------------------------------------------------------------

  const limitedHandler = (_req: Request, _res: Response, next: (err: unknown) => void) =>
    next(
      new AppError(429, 'RATE_LIMITED', 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.'),
    );
  const perIp = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.WITNESS_RATE_LIMIT_IP,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: limitedHandler,
  });
  const perToken = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.WITNESS_RATE_LIMIT_TOKEN,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Keyed by a hash so the token itself is never kept in the limiter's memory.
    keyGenerator: (req) => `witness:${sha256Hex(String(req.params['token']))}`,
    handler: limitedHandler,
  });
  const noStore = (_req: Request, res: Response, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };

  router.get('/witness/:token', perIp, perToken, noStore, async (req, res) => {
    const invite = await openInvite(db, String(req.params['token']));
    if (!invite) throw unavailable();
    const e = invite.targetEntry;
    res.json({
      invite: {
        id: invite.id,
        expires_at: invite.expiresAt.toISOString(),
        owner_display_name: invite.ownerDisplayName,
      },
      entry: {
        ledger_id: e.ledgerId,
        seq: e.seq,
        type: e.type,
        created_at: e.createdAt.toISOString(),
        entry_hash: e.entryHash,
        payload: e.payload,
        has_attachment: e.type === 'photo' || e.type === 'file',
      },
    });
  });

  router.get('/witness/:token/attachment', perIp, perToken, noStore, async (req, res) => {
    const invite = await openInvite(db, String(req.params['token']));
    if (!invite) throw unavailable();
    const attachment = await db.attachment.findFirst({
      where: { entryId: invite.targetEntryId },
      include: { entry: true },
    });
    if (!attachment) throw unavailable();
    await sendAttachment(res, store, attachment, 'inline');
  });

  router.post('/witness/:token/sign', perIp, perToken, noStore, async (req, res) => {
    const invite = await openInvite(db, String(req.params['token']));
    if (!invite) throw unavailable();
    const body = signBody.parse(req.body);
    if (!isValidWitnessName(body.witness_name)) {
      throw new AppError(
        400,
        'INVALID_NAME',
        'Nama harus 1–80 karakter, tanpa spasi di awal atau akhir.',
      );
    }

    // Target and invite come from the server, never from the request: the signature only verifies
    // if the witness signed exactly what this invite points at.
    const target = invite.targetEntry;
    const payload: WitnessCosignPayload = {
      invite_id: invite.id,
      target_seq: target.seq,
      target_entry_hash: target.entryHash,
      statement: 'confirm',
      witness_name: body.witness_name,
      witness_pub: body.witness_pub,
      alg: body.alg,
      signed_client_time: body.signed_client_time,
      signature: body.signature,
    };
    const check = verifyWitnessSignature(invite.ledgerId, payload);
    if (!check.ok)
      throw new AppError(
        400,
        'SIGNATURE_INVALID',
        'Tanda tangan tidak valid. Muat ulang halaman lalu coba lagi.',
      );

    const entry = await appendEntry(
      db,
      invite.ledgerId,
      {
        type: 'witness_cosign',
        authorRef: witnessAuthorRef(payload.witness_pub),
        payload: payload as unknown as PayloadObject,
      },
      undefined,
      {
        // Consumed inside the append transaction, under the ledger lock: of two parallel
        // signatures exactly one sees used_at IS NULL; the other rolls back without an entry.
        beforeInsert: async (tx) => {
          const used = await tx.$executeRaw`
            UPDATE witness_invites SET used_at = now()
            WHERE id = ${invite.id}::uuid AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`;
          if (used !== 1) throw unavailable();
        },
        afterInsert: async (tx, cosign) => {
          await tx.witness.create({
            data: {
              ledgerId: invite.ledgerId,
              inviteId: invite.id,
              targetEntryId: target.id,
              cosignEntryId: cosign.id,
              displayName: payload.witness_name,
              publicKey: payload.witness_pub,
              alg: payload.alg,
              signature: payload.signature,
              signedAt: new Date(cosign.created_at),
            },
          });
        },
      },
    );

    const { signature, ...unsigned } = payload;
    res.status(201).json({
      receipt: {
        format: 'papertrail.witness-receipt/0.1',
        signed_message: buildWitnessMessage(invite.ledgerId, unsigned),
        signature,
        cosign_entry: envelope(entry),
        target_entry: { seq: target.seq, entry_hash: target.entryHash },
      },
    });
  });

  return router;
};
