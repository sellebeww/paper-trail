// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Irreversible actions, so each needs more than a session: the password again and the thing being destroyed typed
// out. A stolen session alone cannot wipe someone's evidence (docs/THREAT_MODEL.md).
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { clearAuthCookies, requireAuth, verifyPassword } from '../auth.js';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { eraseAccount, eraseLedger } from '../services/erase.js';
import { ownLedger } from './ledgers.js';

const idParams = z.object({ id: z.uuid() });
const nfc = (s: string) => s.normalize('NFC').trim();
const eraseLedgerBody = z
  .object({ confirm_title: z.string().max(200), password: z.string().min(1).max(128) })
  .strict();
const eraseAccountBody = z
  .object({ confirm_email: z.string().max(254), password: z.string().min(1).max(128) })
  .strict();

export const eraseRoutes = ({ db, store, config }: AppContext): Router => {
  const router = Router();
  // Same budget as logging in: the password check here is a guessing oracle for anyone holding a session.
  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.AUTH_RATE_LIMIT,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) =>
      next(
        new AppError(
          429,
          'RATE_LIMITED',
          'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.',
        ),
      ),
  });

  const checkPassword = async (userId: string, password: string) => {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, password)))
      throw new AppError(403, 'PASSWORD_INVALID', 'Kata sandi salah.');
    return user;
  };

  router.post('/ledgers/:id/erase', limiter, async (req, res) => {
    const auth = requireAuth(res);
    const ledger = await ownLedger(db, res, idParams.parse(req.params).id);
    const body = eraseLedgerBody.parse(req.body);
    await checkPassword(auth.user.id, body.password);
    if (nfc(body.confirm_title) !== nfc(ledger.title))
      throw new AppError(
        400,
        'CONFIRMATION_MISMATCH',
        'Judul yang diketik tidak sama dengan judul ledger.',
      );
    const { entries } = await eraseLedger(db, store, ledger.id);
    res.json({ erased_entries: entries });
  });

  router.post('/account/erase', limiter, async (req, res) => {
    const auth = requireAuth(res);
    const body = eraseAccountBody.parse(req.body);
    const user = await checkPassword(auth.user.id, body.password);
    if (body.confirm_email.trim().toLowerCase() !== user.email)
      throw new AppError(
        400,
        'CONFIRMATION_MISMATCH',
        'Email yang diketik tidak sama dengan email akun.',
      );
    const done = await eraseAccount(db, store, user.id);
    clearAuthCookies(res, config);
    res.json({ erased_entries: done.entries, erased_ledgers: done.ledgers });
  });

  return router;
};
