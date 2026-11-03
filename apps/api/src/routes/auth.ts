// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import {
  burnPasswordTime,
  clearAuthCookies,
  createSession,
  CSRF_COOKIE,
  getAuth,
  hashPassword,
  newToken,
  requireAuth,
  setAuthCookies,
  verifyPassword,
} from '../auth.js';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';

const credentials = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10, 'Kata sandi minimal 10 karakter.').max(128),
  })
  .strict();

const loginBody = z
  .object({ email: credentials.shape.email, password: z.string().min(1).max(128) })
  .strict();

export const authRoutes = ({ db, config }: AppContext): Router => {
  const router = Router();

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

  const publicUser = (u: { id: string; email: string; createdAt: Date }) => ({
    id: u.id,
    email: u.email,
    created_at: u.createdAt.toISOString(),
  });

  // Hands a logged-out client a CSRF token for the pre-login POSTs (register, login).
  router.get('/auth/csrf', (req, res) => {
    const auth = getAuth(res);
    const existing = (req.cookies as Record<string, unknown> | undefined)?.[CSRF_COOKIE];
    const csrfToken =
      auth?.csrfToken ?? (typeof existing === 'string' && existing ? existing : newToken());
    if (!auth && csrfToken !== existing) {
      res.cookie(CSRF_COOKIE, csrfToken, {
        sameSite: 'lax',
        secure: config.NODE_ENV === 'production',
        path: '/',
        httpOnly: false,
      });
    }
    res.json({ csrf_token: csrfToken });
  });

  router.post('/auth/register', limiter, async (req, res) => {
    const { email, password } = credentials.parse(req.body);
    const passwordHash = await hashPassword(password);
    let user;
    try {
      user = await db.user.create({ data: { email, passwordHash } });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new AppError(409, 'EMAIL_TAKEN', 'Email ini sudah terdaftar.');
      }
      throw err;
    }
    const session = await createSession(db, user.id, config);
    setAuthCookies(res, config, session);
    res.status(201).json({ user: publicUser(user), csrf_token: session.csrfToken });
  });

  router.post('/auth/login', limiter, async (req, res) => {
    const { email, password } = loginBody.parse(req.body);
    const user = await db.user.findUnique({ where: { email } });
    const ok = user
      ? await verifyPassword(user.passwordHash, password)
      : (await burnPasswordTime(password), false);
    if (!user || !ok)
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Email atau kata sandi salah.');
    const session = await createSession(db, user.id, config);
    setAuthCookies(res, config, session);
    res.json({ user: publicUser(user), csrf_token: session.csrfToken });
  });

  router.post('/auth/logout', async (_req, res) => {
    const auth = getAuth(res);
    if (auth) await db.session.deleteMany({ where: { id: auth.sessionId } });
    clearAuthCookies(res, config);
    res.status(204).end();
  });

  router.get('/auth/me', (_req, res) => {
    const auth = requireAuth(res);
    res.json({ user: publicUser(auth.user), csrf_token: auth.csrfToken });
  });

  return router;
};
