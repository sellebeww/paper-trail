// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Email verification and password reset, against a real database and an in-memory mailer.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, startTestApp } from '../test/client.js';
import type { MemoryMailer } from './mailer.js';
import type { MemoryStore } from './storage.js';

type App = Awaited<ReturnType<typeof startTestApp<MemoryStore>>>;
let app: App;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

const NEW_PASSWORD = 'kata-sandi-baru-yang-panjang';
const mailer = () => app.mailer as MemoryMailer;
const mailsTo = (email: string) => mailer().outbox.filter((m) => m.to === email);

const until = async (probe: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25)))
    if (probe()) return;
  throw new Error('timed out');
};
/** Lets any mail that was going to be sent get sent, then reports what arrived. */
const settle = () => new Promise((r) => setTimeout(r, 300));

const tokenIn = (text: string, path: string) => {
  const m = new RegExp(`/${path}#([A-Za-z0-9_-]{43})\\b`).exec(text);
  if (!m) throw new Error(`no ${path} link in mail:\n${text}`);
  return m[1]!;
};
const newAccount = async () => {
  const email = `${randomUUID()}@example.test`;
  const c = app.client();
  await c.register(email);
  await until(() => mailsTo(email).length === 1);
  return { c, email, verifyToken: tokenIn(mailsTo(email)[0]!.text, 'konfirmasi-email') };
};
const verifiedAccount = async () => {
  const a = await newAccount();
  expect(
    (await a.c.json('POST', '/auth/verify-email', { json: { token: a.verifyToken } })).status,
  ).toBe(200);
  return a;
};
/** Moves the clock for a user's tokens back, past the resend cooldown. */
const ageTokens = (email: string, ms: number) =>
  app.db
    .$executeRaw`UPDATE user_tokens SET created_at = created_at - ${ms}::int * interval '1 millisecond',
    expires_at = expires_at - ${ms}::int * interval '1 millisecond'
    WHERE user_id = (SELECT id FROM users WHERE email = ${email})`;

describe('email verification', () => {
  it('mails a link on sign-up, verifies once, and refuses the link a second time', async () => {
    const { c, email, verifyToken } = await newAccount();
    expect(mailsTo(email)[0]!.subject).toMatch(/Verifikasi email/);
    expect((await c.json('GET', '/auth/me')).body.user.email_verified).toBe(false);

    const ok = await c.json('POST', '/auth/verify-email', { json: { token: verifyToken } });
    expect(ok.status).toBe(200);
    expect((await c.json('GET', '/auth/me')).body.user.email_verified).toBe(true);

    const again = await c.json('POST', '/auth/verify-email', { json: { token: verifyToken } });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('TOKEN_INVALID');
  });

  it('works from another browser without logging in (the link opens anywhere)', async () => {
    const { email, verifyToken } = await newAccount();
    const stranger = app.client();
    expect(
      (await stranger.json('POST', '/auth/verify-email', { json: { token: verifyToken } })).status,
    ).toBe(200);
    const login = app.client();
    expect(
      (await login.json('POST', '/auth/login', { json: { email, password: PASSWORD } })).body.user
        .email_verified,
    ).toBe(true);
  });

  it('rejects unknown, malformed, expired and wrong-kind tokens with the same answer', async () => {
    const c = app.client();
    const { email, verifyToken } = await newAccount();
    await ageTokens(email, 25 * 3_600_000); // verification links last 24 hours
    const answers = await Promise.all(
      ['x'.repeat(43), 'short', '../../etc/passwd', verifyToken].map((token) =>
        c.json('POST', '/auth/verify-email', { json: { token } }),
      ),
    );
    for (const r of answers) {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('TOKEN_INVALID');
    }
    // A verification token must not work as a reset token.
    const fresh = await newAccount();
    const asReset = await c.json('POST', '/auth/password-reset', {
      json: { token: fresh.verifyToken, password: NEW_PASSWORD },
    });
    expect(asReset.body.error.code).toBe('TOKEN_INVALID');
  });

  it('lets a logged-in owner ask for a new link, but only one per minute', async () => {
    const { c, email } = await newAccount();
    await ageTokens(email, 120_000);
    expect((await c.json('POST', '/auth/verify-email/request')).status).toBe(202);
    expect((await c.json('POST', '/auth/verify-email/request')).status).toBe(202); // answered, but nothing sent
    await until(() => mailsTo(email).length === 2);
    await settle();
    expect(mailsTo(email)).toHaveLength(2);
    expect((await app.client().json('POST', '/auth/verify-email/request')).status).toBe(401);
  });

  it('makes the newest link the only one that works', async () => {
    const { c, email, verifyToken: oldToken } = await newAccount();
    await ageTokens(email, 120_000);
    await c.json('POST', '/auth/verify-email/request');
    await until(() => mailsTo(email).length === 2);
    const newest = tokenIn(mailsTo(email)[1]!.text, 'konfirmasi-email');
    expect((await c.json('POST', '/auth/verify-email', { json: { token: oldToken } })).status).toBe(
      400,
    );
    expect((await c.json('POST', '/auth/verify-email', { json: { token: newest } })).status).toBe(
      200,
    );
  });

  it('stores only a hash of the token and never puts it in the database in clear', async () => {
    const { email, verifyToken } = await newAccount();
    const rows = await app.db.$queryRaw<{ token_hash: string }[]>`
      SELECT token_hash FROM user_tokens WHERE user_id = (SELECT id FROM users WHERE email = ${email})`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.token_hash).not.toContain(verifyToken);
  });
});

describe('password reset', () => {
  const requestReset = (email: string) =>
    app.client().json('POST', '/auth/password-reset/request', { json: { email } });

  it('resets the password, signs out every session and invalidates the link', async () => {
    const { c: laptop, email } = await verifiedAccount();
    const phone = app.client();
    await phone.json('POST', '/auth/login', { json: { email, password: PASSWORD } });
    expect((await phone.json('GET', '/auth/me')).status).toBe(200);

    expect((await requestReset(email)).status).toBe(202);
    await until(() => mailsTo(email).some((m) => /Atur ulang/.test(m.subject)));
    const mail = mailsTo(email).find((m) => /Atur ulang/.test(m.subject))!;
    const token = tokenIn(mail.text, 'atur-ulang-sandi');

    const reset = await app
      .client()
      .json('POST', '/auth/password-reset', { json: { token, password: NEW_PASSWORD } });
    expect(reset.status).toBe(200);

    expect((await laptop.json('GET', '/auth/me')).status).toBe(401);
    expect((await phone.json('GET', '/auth/me')).status).toBe(401);
    const old = await app
      .client()
      .json('POST', '/auth/login', { json: { email, password: PASSWORD } });
    expect(old.status).toBe(401);
    const fresh = await app
      .client()
      .json('POST', '/auth/login', { json: { email, password: NEW_PASSWORD } });
    expect(fresh.status).toBe(200);

    const reuse = await app.client().json('POST', '/auth/password-reset', {
      json: { token, password: 'sandi-lain-yang-panjang' },
    });
    expect(reuse.body.error.code).toBe('TOKEN_INVALID');
    expect(
      (await app.client().json('POST', '/auth/login', { json: { email, password: NEW_PASSWORD } }))
        .status,
    ).toBe(200);
  });

  it('answers identically for unknown, unverified and verified addresses, and mails only the verified one', async () => {
    const unverified = await newAccount();
    const verified = await verifiedAccount();
    const unknown = `${randomUUID()}@example.test`;

    const answers = [];
    for (const email of [unknown, unverified.email, verified.email])
      answers.push(await requestReset(email));
    expect(new Set(answers.map((r) => r.status))).toEqual(new Set([202]));
    expect(new Set(answers.map((r) => JSON.stringify(r.body)))).toHaveProperty('size', 1);

    await until(() => mailsTo(verified.email).some((m) => /Atur ulang/.test(m.subject)));
    await settle();
    expect(mailsTo(unknown)).toHaveLength(0);
    expect(mailsTo(unverified.email).filter((m) => /Atur ulang/.test(m.subject))).toHaveLength(0);
  });

  it('sends one reset mail per minute per address', async () => {
    const { email } = await verifiedAccount();
    await requestReset(email);
    await requestReset(email);
    await requestReset(email);
    await until(() => mailsTo(email).some((m) => /Atur ulang/.test(m.subject)));
    await settle();
    expect(mailsTo(email).filter((m) => /Atur ulang/.test(m.subject))).toHaveLength(1);
  });

  it('keeps the link usable after a too-short password, and lets exactly one of two parallel resets win', async () => {
    const { email } = await verifiedAccount();
    await requestReset(email);
    await until(() => mailsTo(email).some((m) => /Atur ulang/.test(m.subject)));
    const token = tokenIn(
      mailsTo(email).find((m) => /Atur ulang/.test(m.subject))!.text,
      'atur-ulang-sandi',
    );

    const weak = await app
      .client()
      .json('POST', '/auth/password-reset', { json: { token, password: 'pendek' } });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');

    const [a, b] = await Promise.all([
      app
        .client()
        .json('POST', '/auth/password-reset', { json: { token, password: NEW_PASSWORD } }),
      app.client().json('POST', '/auth/password-reset', {
        json: { token, password: 'sandi-yang-lain-lagi' },
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  it('refuses an expired reset link', async () => {
    const { email } = await verifiedAccount();
    await requestReset(email);
    await until(() => mailsTo(email).some((m) => /Atur ulang/.test(m.subject)));
    const token = tokenIn(
      mailsTo(email).find((m) => /Atur ulang/.test(m.subject))!.text,
      'atur-ulang-sandi',
    );
    await ageTokens(email, 2 * 3_600_000); // reset links last one hour
    const r = await app
      .client()
      .json('POST', '/auth/password-reset', { json: { token, password: NEW_PASSWORD } });
    expect(r.body.error.code).toBe('TOKEN_INVALID');
  });

  it('verifies the address when a reset is completed by email', async () => {
    const { email } = await verifiedAccount();
    await app.db.user.update({ where: { email }, data: { emailVerifiedAt: null } }); // as if it were never verified
    await app.db
      .$executeRaw`DELETE FROM user_tokens WHERE user_id = (SELECT id FROM users WHERE email = ${email})`;
    const user = await app.db.user.findUniqueOrThrow({ where: { email } });
    const { issueUserToken } = await import('./auth.js');
    const token = (await issueUserToken(app.db, user.id, 'reset_password'))!;
    expect(
      (
        await app
          .client()
          .json('POST', '/auth/password-reset', { json: { token, password: NEW_PASSWORD } })
      ).status,
    ).toBe(200);
    expect(
      (await app.db.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt,
    ).not.toBeNull();
  });
});
