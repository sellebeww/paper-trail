// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import {
  burnPasswordTime,
  clearAuthCookies,
  consumeUserToken,
  createSession,
  CSRF_COOKIE,
  getAuth,
  hashPassword,
  isTokenShape,
  issueUserToken,
  newToken,
  requireAuth,
  setAuthCookies,
  verifyPassword,
  type UserTokenKind,
} from '../auth.js';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';

const credentials = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10, 'Kata sandi minimal 10 karakter.').max(128),
  })
  .strict();

const tokenBody = z.object({ token: z.string().max(100) }).strict();
const resetRequestBody = z.object({ email: credentials.shape.email }).strict();
const resetBody = z
  .object({ token: z.string().max(100), password: credentials.shape.password })
  .strict();

const TOKEN_INVALID = () =>
  new AppError(
    400,
    'TOKEN_INVALID',
    'Tautan ini tidak berlaku atau sudah dipakai. Minta tautan baru.',
  );

const loginBody = z
  .object({ email: credentials.shape.email, password: z.string().min(1).max(128) })
  .strict();

export const authRoutes = ({ db, config, mailer }: AppContext): Router => {
  const router = Router();
  const origin = new URL(config.WEB_ORIGIN).origin;

  // Links carry the token in the fragment, which browsers never send to a server or a Referer.
  const MAIL: Record<
    UserTokenKind,
    { path: string; subject: string; intro: string; expires: string }
  > = {
    verify_email: {
      path: '/konfirmasi-email',
      subject: 'Verifikasi email Paper Trail / Verify your Paper Trail email',
      intro:
        'Klik tautan ini untuk memverifikasi email Anda. Email terverifikasi diperlukan untuk mengatur ulang kata sandi.\nOpen this link to verify your email. A verified email is needed to reset your password.',
      expires: 'Berlaku 24 jam / valid for 24 hours.',
    },
    reset_password: {
      path: '/atur-ulang-sandi',
      subject: 'Atur ulang kata sandi Paper Trail / Reset your Paper Trail password',
      intro:
        'Klik tautan ini untuk memilih kata sandi baru. Semua sesi masuk akan dikeluarkan.\nOpen this link to choose a new password. All logged-in sessions will be signed out.',
      expires: 'Berlaku 1 jam / valid for 1 hour.',
    },
  };

  /** Issues a token and mails the link. Never throws: callers must not learn whether mail went out. */
  const sendLink = async (user: { id: string; email: string }, kind: UserTokenKind) => {
    try {
      const token = await issueUserToken(db, user.id, kind);
      if (!token) return;
      const m = MAIL[kind];
      await mailer.send({
        to: user.email,
        subject: m.subject,
        text: `${m.intro}\n\n${origin}${m.path}#${token}\n\n${m.expires}\n\nJika bukan Anda yang meminta ini, abaikan email ini. / If you did not request this, ignore this email.\n`,
      });
    } catch {
      console.error(JSON.stringify({ msg: 'account mail failed', kind }));
    }
  };

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

  const publicUser = (u: {
    id: string;
    email: string;
    createdAt: Date;
    emailVerifiedAt: Date | null;
  }) => ({
    id: u.id,
    email: u.email,
    email_verified: u.emailVerifiedAt !== null,
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
    void sendLink(user, 'verify_email');
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

  router.post('/auth/verify-email/request', limiter, async (_req, res) => {
    const { user } = requireAuth(res);
    if (user.emailVerifiedAt) return void res.json({ already_verified: true });
    await sendLink(user, 'verify_email');
    res.status(202).json({ sent: true });
  });

  router.post('/auth/verify-email', limiter, async (req, res) => {
    const { token } = tokenBody.parse(req.body);
    const userId = await consumeUserToken(db, token, 'verify_email');
    if (!userId) throw TOKEN_INVALID();
    await db.user.updateMany({
      where: { id: userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    res.json({ verified: true });
  });

  // Same answer for every address, and the work happens after the answer, so neither the body nor the timing
  // says whether the address has an account. Only verified addresses get a link (see schema.prisma, User).
  router.post('/auth/password-reset/request', limiter, async (req, res) => {
    const { email } = resetRequestBody.parse(req.body);
    res.status(202).json({ accepted: true });
    const user = await db.user.findUnique({ where: { email } }).catch(() => null);
    if (user?.emailVerifiedAt) await sendLink(user, 'reset_password');
  });

  router.post('/auth/password-reset', limiter, async (req, res) => {
    const { token, password } = resetBody.parse(req.body);
    if (!isTokenShape(token)) throw TOKEN_INVALID();
    const passwordHash = await hashPassword(password);
    const ok = await db.$transaction(async (tx) => {
      const userId = await consumeUserToken(tx, token, 'reset_password');
      if (!userId) return false;
      // Receiving the mail proves control of the address; every existing session is signed out.
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await tx.user.updateMany({
        where: { id: userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      });
      await tx.session.deleteMany({ where: { userId } });
      return true;
    });
    if (!ok) throw TOKEN_INVALID();
    res.json({ reset: true });
  });

  router.get('/auth/me', (_req, res) => {
    const auth = requireAuth(res);
    res.json({ user: publicUser(auth.user), csrf_token: auth.csrfToken });
  });

  return router;
};
