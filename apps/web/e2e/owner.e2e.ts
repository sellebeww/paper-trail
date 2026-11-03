// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// The owner flow in a real (phone-sized) browser against the real API, database, RabbitMQ and worker:
// register → ledger → text + photo entries → invite a witness → witness co-signs in another tab →
// manual anchor (worker CLI, mock TSA) → export JSON + PDF → /verify says "Rantai utuh".
// Files are held in memory (apps/api/src/dev/serve-memory.ts) because MinIO is not needed for this flow.
// Needs: `pnpm infra:up` (Postgres + RabbitMQ). Run: pnpm --filter @paper-trail/web test:e2e
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { build, preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { expectAccessible } from './a11y';
import { createTestDatabase } from '../../api/test/global-setup.js';

const web = resolve(import.meta.dirname, '..');
const root = resolve(web, '../..');
const tsx = join(root, 'node_modules/.bin/tsx');
const API_PORT = '3917';
const WEB_PORT = 4917;
const TSA_PORT = '3918';
const DB = 'papertrail_browser_test'; // createTestDatabase only allows [a-z_]
const PASSWORD = 'kata-sandi-panjang-1';
// 1x1 transparent PNG: real magic bytes, because the API detects the type from content.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const children: { name: string; proc: ChildProcess; log: string[] }[] = [];

/** Starts a TypeScript process with the repo's `source` export condition and waits for a line. */
const start = (name: string, cwd: string, file: string, env: NodeJS.ProcessEnv, ready: RegExp) => {
  const proc = spawn(tsx, ['--conditions=source', file], { cwd, env, stdio: 'pipe' });
  const log: string[] = [];
  children.push({ name, proc, log });
  return new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`${name} not ready:\n${log.join('')}`)), 60_000);
    const onData = (chunk: Buffer) => {
      log.push(chunk.toString());
      const hit = ready.exec(log.join(''));
      if (hit) {
        clearTimeout(timer);
        ok(hit[1] ?? hit[0]);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (c: Buffer) => log.push(c.toString()));
    proc.on('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`${name} exited (${code}):\n${log.join('')}`));
    });
  });
};

/** Runs a TypeScript CLI to completion. */
const run = (cwd: string, file: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<string>((ok, fail) => {
    const proc = spawn(tsx, ['--conditions=source', file, ...args], { cwd, env, stdio: 'pipe' });
    let out = '';
    proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
    proc.stderr.on('data', (c: Buffer) => (out += c.toString()));
    proc.on('exit', (code) => (code === 0 ? ok(out) : fail(new Error(`exit ${code}:\n${out}`))));
  });

const withDb = (urlText: string) => {
  const u = new URL(urlText);
  u.pathname = `/${DB}`;
  return u.toString();
};

let server: PreviewServer;
let browser: Browser;
let context: BrowserContext;
let url: string;
let workerEnv: NodeJS.ProcessEnv;
let caPem: string;
const tmp = mkdtempSync(join(tmpdir(), 'pt-e2e-'));

beforeAll(async () => {
  process.loadEnvFile(join(root, '.env'));
  await createTestDatabase(DB); // fresh, migrated database: entries are append-only, so a new one is the only reset
  const base = process.env as Record<string, string>;
  const queuePrefix = `e2e${Date.now().toString(36)}`;
  caPem = join(tmp, 'tsa-ca.pem');

  const tsaUrl = await start(
    'mock-tsa',
    join(root, 'apps/worker'),
    'src/cli/mock-tsa.ts',
    { ...base, MOCK_TSA_PORT: TSA_PORT, MOCK_TSA_CA_OUT: caPem },
    /TSA_URLS=(\S+)/,
  );
  workerEnv = {
    ...base,
    WORKER_DATABASE_URL: withDb(base['WORKER_DATABASE_URL']!),
    QUEUE_PREFIX: queuePrefix,
    TSA_URLS: tsaUrl,
    TSA_CA_CERTS: caPem,
    ANCHOR_INTERVAL_HOURS: '24',
  };
  await Promise.all([
    start(
      'api',
      join(root, 'apps/api'),
      'src/dev/serve-memory.ts',
      {
        ...base,
        DATABASE_URL: withDb(base['DATABASE_URL']!),
        API_PORT,
        WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
        AUTH_RATE_LIMIT: '1000',
      },
      /listening/,
    ),
    start('worker', join(root, 'apps/worker'), 'src/index.ts', workerEnv, /./),
  ]);

  process.env['API_PORT'] = API_PORT; // read by vite.config.ts for the /api proxy
  await build({ root: web, logLevel: 'error' });
  server = await preview({
    root: web,
    logLevel: 'error',
    preview: { port: WEB_PORT, strictPort: true, host: 'localhost' },
  });
  url = `http://localhost:${WEB_PORT}/`;
  // System Chrome by default; PW_CHANNEL='' uses Playwright's own Chromium. A phone-sized, touch viewport.
  browser = await chromium.launch({ channel: process.env['PW_CHANNEL'] ?? 'chrome' });
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    acceptDownloads: true,
  });
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await server?.close();
  for (const c of children) c.proc.kill('SIGTERM');
});

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const link = (page: Page, name: string) => page.getByRole('link', { name, exact: true });

const download = async (page: Page, trigger: () => Promise<void>, file: string) => {
  const [dl] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const path = join(tmp, file);
  await dl.saveAs(path);
  return path;
};

/** Set E2E_SHOTS=<dir> to keep phone-sized screenshots of the key screens for a visual review. */
const shot = async (page: Page, name: string) => {
  const dir = process.env['E2E_SHOTS'];
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
};

describe('owner flow', () => {
  it('register → ledger → entries → witness → anchor → export → /verify: Rantai utuh', async () => {
    const page = await context.newPage();
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));

    // 1. Register. An anonymous visitor lands on the login screen.
    await page.goto(url);
    await page.getByRole('heading', { name: /Catatan yang tidak bisa Anda ubah/ }).waitFor();
    await expectAccessible(page, 'login');
    await button(page, 'Daftar').click();
    await page.getByLabel('Email').fill(`budi-${Date.now()}@example.test`);
    await page.getByLabel('Kata sandi').fill(PASSWORD);
    await button(page, 'Buat akun').click();
    await page.getByRole('heading', { name: 'Ledger saya' }).waitFor();
    await expectAccessible(page, 'ledger list (empty)');

    // 2. Create a ledger.
    await button(page, 'Ledger baru').first().click();
    await page.getByLabel(/^Judul/).fill('Sengketa lembur');
    await button(page, 'Buat ledger').click();
    await page.getByRole('heading', { name: 'Sengketa lembur', level: 1 }).waitFor();
    const ledgerId = /\/ledger\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
    expect(await page.getByTestId('head-hash').textContent()).toContain('belum ada');
    expect(await page.getByTestId('anchor-line').textContent()).toContain('Belum ada entri');

    // 3. A text entry: the receipt shows the 8-character code and the new head.
    await link(page, 'Teks').click();
    await page.getByLabel('Apa yang terjadi?').fill('Atasan menolak membayar lembur Senin.');
    await button(page, 'Catat sekarang').click();
    await page.getByTestId('receipt').waitFor();
    await expectAccessible(page, 'receipt');
    await shot(page, '1-receipt');
    const entry1 = (await page.getByTestId('receipt-entry-hash').getAttribute('data-hash'))!;
    const head1 = (await page.getByTestId('receipt-head-hash').getAttribute('data-hash'))!;
    expect(entry1).toMatch(/^[0-9a-f]{64}$/);
    expect(head1).toBe(entry1); // first entry: the head is the entry itself
    expect(await page.getByTestId('receipt-entry-hash').textContent()).toBe(entry1.slice(0, 8));
    await link(page, 'Ke linimasa').click();
    await page.getByTestId('stamp-waiting').first().waitFor();
    expect(await page.getByTestId('head-hash').textContent()).toContain(head1.slice(0, 8));

    // 4. A photo, straight from the picker on the ledger screen (the camera on a phone).
    await page.setInputFiles('input[data-kind="foto"]', {
      name: 'bukti.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await page.getByRole('heading', { name: 'Tambah foto' }).waitFor();
    await page.getByLabel(/^Keterangan/).fill('Papan jadwal lembur');
    await button(page, 'Catat sekarang').click();
    await page.getByTestId('receipt').waitFor();
    const head2 = (await page.getByTestId('receipt-head-hash').getAttribute('data-hash'))!;
    expect(head2).not.toBe(head1);
    await link(page, 'Ke linimasa').click();
    await page.locator('#entry-1').waitFor();
    expect(await page.getByTestId('head-hash').textContent()).toContain(head2.slice(0, 8));
    // Newest on top.
    expect(await page.locator('.timeline li').first().getAttribute('data-seq')).toBe('1');

    await shot(page, '2-timeline');
    // The phone-sized layout never scrolls sideways.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // 5. Invite a witness for entry 1 and read the link.
    await page.locator('#entry-0').getByRole('link', { name: 'Undang saksi' }).click();
    await page.getByLabel(/^Nama yang ditampilkan/).fill('Budi');
    await button(page, 'Buat tautan saksi').click();
    await page.getByTestId('invite-created').waitFor();
    await shot(page, '3-witness-link');
    const inviteUrl = await page.locator('#invite-url').inputValue();
    expect(inviteUrl).toContain('/saksi#');

    // 6. The witness co-signs in another tab.
    const witness = await context.newPage();
    await witness.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, `http://localhost:${WEB_PORT}`));
    await witness.getByText('Atasan menolak membayar lembur Senin.').waitFor();
    await expectAccessible(witness, 'witness page');
    await witness.locator('#witness-name').fill('Siti Saksi');
    await witness.getByRole('checkbox').check();
    await witness.getByRole('button', { name: 'Saya menyaksikan ini' }).click();
    await witness.getByText(/Kesaksian Anda sudah tercatat/).waitFor();
    await witness.close();

    // The owner's panel notices (it polls) and the timeline shows the badge.
    await page.getByText('Sudah disaksikan').waitFor({ timeout: 20_000 });
    await link(page, 'Kembali').click();
    await page.locator('#entry-0').getByText('Disaksikan: Siti Saksi').waitFor();
    await page.locator('#entry-2').waitFor(); // the witness_cosign entry
    expect(await page.locator('#entry-2').textContent()).toContain('Siti Saksi menyatakan');

    // 7. Anchor by hand: queue the job with the worker CLI; the running worker asks the mock TSA.
    await run(join(root, 'apps/worker'), 'src/cli/anchor-now.ts', [ledgerId], workerEnv);
    await vi.waitFor(
      async () => {
        await button(page, 'Segarkan').click();
        await page.waitForTimeout(400);
        expect(await page.getByTestId('anchor-line').textContent()).not.toContain('Belum pernah');
        expect(await page.getByTestId('stamp-waiting').count()).toBe(0);
      },
      { timeout: 45_000, interval: 1_000 },
    );
    expect(await page.getByTestId('stamp-anchored').count()).toBe(3);
    await expectAccessible(page, 'ledger timeline');
    await shot(page, '4-anchored');

    // 8. Export the pack and the PDF summary.
    await link(page, 'Ekspor').click();
    await page.getByRole('heading', { name: 'Ekspor', level: 1 }).waitFor();
    await expectAccessible(page, 'export');
    const packPath = await download(
      page,
      () => button(page, 'Unduh paket (JSON)').click(),
      'paket.json',
    );
    const pdfPath = await download(
      page,
      () => button(page, 'Unduh ringkasan (PDF)').click(),
      'ringkasan.pdf',
    );
    expect(readFileSync(pdfPath).subarray(0, 4).toString()).toBe('%PDF');
    const packHash = (await page.getByTestId('pack-hash').getAttribute('data-hash'))!;
    expect(JSON.parse(readFileSync(packPath, 'utf8')).pack_hash).toBe(packHash);
    await page.getByText('memiliki hash yang sama').waitFor();
    await shot(page, '5-export');

    // 9. Verify it offline in the browser, against the mock TSA's root.
    const verify = await context.newPage();
    await verify.goto(`${url}verify`);
    await verify.setInputFiles('#pack-file', packPath);
    await verify.setInputFiles('#roots-file', caPem);
    await verify.getByRole('button', { name: 'Verifikasi' }).click();
    await verify.getByTestId('headline').waitFor();
    await expectAccessible(verify, 'verify result');
    expect(await verify.getByTestId('headline').textContent()).toBe('✔ Rantai utuh');
    expect(await verify.getByTestId('check-anchors').getAttribute('data-status')).toBe('pass');
    await verify.close();

    expect(pageErrors.map((e) => e.message)).toEqual([]);
  });

  it('verify email → forgot password → reset → log in with the new password', async () => {
    await context.clearCookies(); // the previous test left this browser logged in
    const page = await context.newPage();
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));
    const email = `rina-${Date.now()}@example.test`;
    const NEW_PASSWORD = 'kata-sandi-baru-yang-panjang';

    /** The link in the newest mail to `email`, read from the API's console mailer (development only). */
    const linkFor = (subject: RegExp) =>
      vi.waitFor(
        () => {
          const log = children.find((c) => c.name === 'api')!.log.join('');
          for (const line of log.split('\n').reverse()) {
            if (!line.includes('"mail (console mailer')) continue;
            const mail = JSON.parse(line) as { to: string; subject: string; text: string };
            if (mail.to !== email || !subject.test(mail.subject)) continue;
            return /https?:\/\/\S+#[\w-]{43}/.exec(mail.text)![0];
          }
          throw new Error('mail not sent yet');
        },
        { timeout: 15_000, interval: 100 },
      );

    // Sign up: the app asks for verification, and the mail carries the token in the URL fragment.
    await page.goto(url);
    await button(page, 'Daftar').click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Kata sandi').fill(PASSWORD);
    await button(page, 'Buat akun').click();
    await page.getByRole('heading', { name: 'Ledger saya' }).waitFor();
    await page.getByText(/Email Anda belum diverifikasi/).waitFor();
    await expectAccessible(page, 'unverified banner');
    await shot(page, '6-unverified-banner');

    const verifyLink = await linkFor(/Verifikasi email/);
    expect(new URL(verifyLink).pathname).toBe('/konfirmasi-email');
    await page.goto(verifyLink);
    await page.getByText('Email Anda sudah terverifikasi').waitFor();
    expect(page.url()).not.toContain('#'); // the token is removed from the address bar
    await link(page, 'Ke Paper Trail').click();
    await page.getByRole('heading', { name: 'Ledger saya' }).waitFor();
    expect(await page.getByText(/Email Anda belum diverifikasi/).count()).toBe(0);

    // The same link cannot be used again.
    await page.goto(verifyLink);
    await page.getByText(/tidak berlaku atau sudah dipakai/).waitFor();

    // Forgot password → mail → choose a new password.
    await page.goto(url);
    await button(page, 'Keluar').click();
    await page.getByRole('link', { name: 'Lupa kata sandi?' }).click();
    await page.getByLabel('Email').fill(email);
    await button(page, 'Kirim tautan').click();
    await page.getByText(/tautan sudah dikirim/).waitFor();
    await shot(page, '7-forgot-sent');

    const resetLink = await linkFor(/Atur ulang kata sandi/);
    await page.goto(resetLink);
    await page.getByRole('heading', { name: 'Pilih kata sandi baru' }).waitFor();
    expect(page.url()).not.toContain('#');
    await expectAccessible(page, 'reset password');
    await shot(page, '8-reset-form');
    await page.getByLabel('Kata sandi baru').fill(NEW_PASSWORD);
    await button(page, 'Simpan kata sandi baru').click();
    await page.getByText(/Kata sandi sudah diganti/).waitFor();

    // The old password no longer works, the new one does.
    await link(page, 'Masuk').click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Kata sandi').fill(PASSWORD);
    await button(page, 'Masuk ke akun').click();
    await page.getByText('Email atau kata sandi salah.').waitFor();
    await page.getByLabel('Kata sandi').fill(NEW_PASSWORD);
    await button(page, 'Masuk ke akun').click();
    await page.getByRole('heading', { name: 'Ledger saya' }).waitFor();

    expect(pageErrors.map((e) => e.message)).toEqual([]);
    await page.close();
  });
});
