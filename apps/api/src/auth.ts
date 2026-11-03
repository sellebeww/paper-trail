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
  user: { id: string; email: string; createdAt: Date; emailVerifiedAt: Date | null };
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

export type UserTokenKind = 'verify_email' | 'reset_password';
const TOKEN_TTL_MS: Record<UserTokenKind, number> = {
  verify_email: 24 * 3_600_000,
  reset_password: 3_600_000,
};
/** One mail per kind per user per minute: stops the form being used to flood someone's inbox. */
const RESEND_COOLDOWN_MS = 60_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export const isTokenShape = (token: string): boolean => TOKEN_SHAPE.test(token);

/**
 * Issues a one-time token and invalidates earlier unused ones of the same kind, so only the newest link works.
 * Returns null when one was issued less than a minute ago (the caller then sends nothing).
 */
export const issueUserToken = async (
  db: Db,
  userId: string,
  kind: UserTokenKind,
): Promise<string | null> => {
  const token = newToken();
  // The advisory lock serializes concurrent requests for the same user and kind, so the cooldown check and the
  // insert cannot interleave (otherwise a burst of requests would each pass the check and each send a mail).
  const issued = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${userId}:${kind}`}))`;
    const recent = await tx.userToken.findFirst({
      where: { userId, kind, createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) } },
      select: { id: true },
    });
    if (recent) return false;
    await tx.userToken.deleteMany({ where: { userId, kind, usedAt: null } });
    await tx.userToken.create({
      data: {
        userId,
        kind,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS[kind]),
      },
    });
    return true;
  });
  if (!issued) return null;
  return token;
};

/**
 * Uses a token up, exactly once, and returns whose it was. A single UPDATE decides: of two parallel requests with the
 * same token one gets the row, the other gets nothing. Pass a transaction client to tie it to other writes.
 */
export const consumeUserToken = async (
  db: Pick<Db, '$queryRaw'>,
  token: string,
  kind: UserTokenKind,
): Promise<string | null> => {
  if (!isTokenShape(token)) return null;
  const rows = await db.$queryRaw<{ user_id: string }[]>`
    UPDATE user_tokens SET used_at = now()
    WHERE token_hash = ${sha256Hex(token)} AND kind = ${kind}::user_token_kind
      AND used_at IS NULL AND expires_at > now()
    RETURNING user_id::text AS user_id`;
  return rows[0]?.user_id ?? null;
};

/** Removes spent and long-expired tokens. */
export const purgeUserTokens = async (db: Db): Promise<number> =>
  (
    await db.userToken.deleteMany({
      where: {
        OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date(Date.now() - 86_400_000) } }],
      },
    })
  ).count;

/** Deletes sessions past their expiry (they are otherwise removed only when someone presents them). */
export const purgeExpiredSessions = async (db: Db): Promise<number> =>
  (await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })).count;

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
        const { id, email, createdAt, emailVerifiedAt } = session.user;
        res.locals['auth'] = {
          sessionId: session.id,
          csrfToken: session.csrfToken,
          user: { id, email, createdAt, emailVerifiedAt },
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
