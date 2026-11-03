// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '@paper-trail/chain';
import { hash, verify } from '@node-rs/argon2';
import type { RequestHandler, Response } from 'express';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';

export const SESSION_COOKIE = 'pt_session';
export const CSRF_COOKIE = 'pt_csrf';
export const CSRF_HEADER = 'x-csrf-token';

// OWASP minimum for Argon2id: 19 MiB memory, 2 iterations, 1 lane. 2 = Argon2id (the library's enum is `const`).
const ARGON2ID = { algorithm: 2 as never, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2ID);

export const verifyPassword = (hashed: string, password: string): Promise<boolean> =>
  verify(hashed, password).catch(() => false);

let dummyHash: Promise<string> | undefined;
/** Verifies against a throwaway hash so unknown emails cost the same time as wrong passwords. */
export const burnPasswordTime = async (password: string): Promise<void> => {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
};

export const newToken = (): string => randomBytes(32).toString('base64url');

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface AuthState {
  sessionId: string;
  csrfToken: string;
  user: { id: string; email: string; createdAt: Date };
}

export const getAuth = (res: Response): AuthState | undefined =>
  res.locals['auth'] as AuthState | undefined;

export const requireAuth = (res: Response): AuthState => {
  const auth = getAuth(res);
  if (!auth) throw new AppError(401, 'UNAUTHENTICATED', 'Silakan masuk terlebih dahulu.');
  return auth;
};

export const createSession = async (db: Db, userId: string, config: Config) => {
  const token = newToken();
  const csrfToken = newToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3_600_000);
  await db.session.create({ data: { userId, tokenHash: sha256Hex(token), csrfToken, expiresAt } });
  return { token, csrfToken, expiresAt };
};

const cookieBase = (config: Config) =>
  ({ sameSite: 'lax', secure: config.NODE_ENV === 'production', path: '/' }) as const;

export const setAuthCookies = (
  res: Response,
  config: Config,
  s: { token: string; csrfToken: string; expiresAt: Date },
) => {
  res.cookie(SESSION_COOKIE, s.token, {
    ...cookieBase(config),
    httpOnly: true,
    expires: s.expiresAt,
  });
  res.cookie(CSRF_COOKIE, s.csrfToken, {
    ...cookieBase(config),
    httpOnly: false,
    expires: s.expiresAt,
  });
};

export const clearAuthCookies = (res: Response, config: Config) => {
  res.clearCookie(SESSION_COOKIE, { ...cookieBase(config), httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...cookieBase(config), httpOnly: false });
};

/** Loads the session from the cookie into res.locals.auth. Anonymous requests simply have no auth. */
export const loadSession =
  (db: Db): RequestHandler =>
  async (req, res, next) => {
    const token = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE];
    if (typeof token === 'string' && token.length >= 32 && token.length <= 128) {
      const session = await db.session.findUnique({
        where: { tokenHash: sha256Hex(token) },
        include: { user: true },
      });
      if (session && session.expiresAt > new Date()) {
        const { id, email, createdAt } = session.user;
        res.locals['auth'] = {
          sessionId: session.id,
          csrfToken: session.csrfToken,
          user: { id, email, createdAt },
        } satisfies AuthState;
      } else if (session) {
        await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
      }
    }
    next();
  };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for every state-changing request: the Origin header (when present) must be ours, and the
 * X-CSRF-Token header must equal the pt_csrf cookie (double submit) and, when logged in, the session's token.
 */
export const csrfProtection =
  (config: Config): RequestHandler =>
  (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const forbidden = () =>
      new AppError(403, 'CSRF_INVALID', 'Permintaan ditolak. Muat ulang halaman lalu coba lagi.');

    const origin = req.headers.origin;
    if (origin !== undefined && origin !== new URL(config.WEB_ORIGIN).origin)
      return next(forbidden());

    const header = req.get(CSRF_HEADER);
    const cookie = (req.cookies as Record<string, unknown> | undefined)?.[CSRF_COOKIE];
    if (!header || typeof cookie !== 'string' || !safeEqual(header, cookie))
      return next(forbidden());
    const auth = getAuth(res);
    if (auth && !safeEqual(header, auth.csrfToken)) return next(forbidden());
    next();
  };
