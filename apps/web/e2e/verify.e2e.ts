// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// /verify in a real browser: the Step 6 packs pass, every broken fixture fails with the expected headline (the same
// one the CLI prints), and verifying sends nothing over the network.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { build, preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const web = resolve(import.meta.dirname, '..');
const examples = resolve(web, '../../docs/examples');
const fixtures = resolve(web, '../../packages/verifier/fixtures');
const roots = join(examples, 'example-tsa-root.pem');
const expected = JSON.parse(readFileSync(join(fixtures, 'expected.json'), 'utf8')) as {
  file: string;
  exit: number;
  headline: string;
}[];

let server: PreviewServer;
let browser: Browser;
let url: string;
beforeAll(async () => {
  await build({ root: web, logLevel: 'error' });
  server = await preview({ root: web, logLevel: 'error', preview: { port: 0 } });
  url = server.resolvedUrls!.local[0]!;
  // System Chrome by default, so no browser download is needed; PW_CHANNEL='' uses Playwright's own Chromium.
  browser = await chromium.launch({ channel: process.env['PW_CHANNEL'] ?? 'chrome' });
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Opens /verify, verifies the given input, and returns the requests made after clicking. */
const verify = async (
  page: Page,
  input: { file?: string; paste?: string; roots?: boolean },
): Promise<string[]> => {
  await page.goto(`${url}verify`);
  await page.getByRole('button', { name: 'Verifikasi' }).waitFor();
  if (input.file) await page.setInputFiles('#pack-file', input.file);
  if (input.paste) await page.fill('#pack-text', input.paste);
  if (input.roots) await page.setInputFiles('#roots-file', roots);
  const requests: string[] = [];
  page.on('request', (r) => requests.push(`${r.method()} ${r.url()}`));
  await page.getByRole('button', { name: 'Verifikasi' }).click();
  await page.getByTestId('headline').waitFor();
  return requests;
};

describe('/verify', () => {
  it.each(expected)('fixture $file → "$headline"', async ({ file, exit, headline }) => {
    const page = await browser.newPage();
    const requests = await verify(page, { file: join(fixtures, file), roots: true });
    expect(await page.getByTestId('headline').textContent()).toBe(
      `${exit === 0 ? '✔' : '✘'} ${headline}`,
    );
    expect(requests).toEqual([]);
    await page.close();
  });

  it.each(['example-pack.json', 'example-pack.zip'])(
    'the Step 6 pack %s passes, attachments included',
    async (file) => {
      const page = await browser.newPage();
      const requests = await verify(page, { file: join(examples, file), roots: true });
      expect(await page.getByTestId('headline').textContent()).toBe('✔ Rantai utuh');
      expect(await page.getByTestId('check-anchors').getAttribute('data-status')).toBe('pass');
      expect(await page.getByTestId('check-attachments').getAttribute('data-status')).toBe(
        file.endsWith('.zip') ? 'pass' : 'skip',
      );
      expect(requests).toEqual([]);
      await page.close();
    },
  );

  it('accepts a pasted pack and, without TSA roots, warns that the TSA certificate was not checked', async () => {
    const page = await browser.newPage();
    await verify(page, { paste: readFileSync(join(examples, 'example-pack.json'), 'utf8') });
    expect(await page.getByTestId('headline').textContent()).toBe('✔ Rantai utuh');
    expect(await page.getByTestId('warnings').textContent()).toContain('ANCHOR_UNVERIFIED');
    expect(await page.getByTestId('check-anchors').getAttribute('data-status')).toBe('warn');
    await page.close();
  });

  it('shows where the chain broke, the warnings of a partial pack, and the disclaimer', async () => {
    const page = await browser.newPage();
    await verify(page, { file: join(fixtures, 'entry-deleted.json'), roots: true });
    expect(await page.getByText('Rantai terputus di').textContent()).toContain('entri 4');
    expect(await page.getByTestId('check-chain').getAttribute('data-status')).toBe('fail');
    expect(await page.getByText('tidak menjamin penerimaan sebagai alat bukti').count()).toBe(1);

    await verify(page, { file: join(examples, 'example-pack-partial.json'), roots: true });
    expect(await page.getByTestId('headline').textContent()).toBe(
      '✔ Rantai utuh pada rentang yang diekspor',
    );
    expect(await page.getByTestId('warnings').textContent()).toContain('PARTIAL_PACK');
    await page.close();
  });

  it('from the PDF QR link (/verifikasi#<pack_hash>), says whether the pack is the one the PDF summarises', async () => {
    const { pack_hash } = JSON.parse(readFileSync(join(examples, 'example-pack.json'), 'utf8')) as {
      pack_hash: string;
    };
    const page = await browser.newPage();
    for (const [file, verdict] of [
      [join(examples, 'example-pack.json'), 'Sama dengan hash di ringkasan PDF'],
      [join(fixtures, 'entry-modified.json'), 'Berbeda dari hash di ringkasan PDF'],
    ] as const) {
      await page.goto(`${url}verifikasi#${pack_hash}`);
      await page.setInputFiles('#pack-file', file);
      await page.getByRole('button', { name: 'Verifikasi' }).click();
      expect(await page.getByTestId('pack-hash').textContent()).toContain(verdict);
    }
    await page.close();
  });

  it('reports a file that is not a pack instead of crashing', async () => {
    const page = await browser.newPage();
    await page.goto(`${url}verify`);
    await page.fill('#pack-text', 'bukan json');
    await page.getByRole('button', { name: 'Verifikasi' }).click();
    expect(await page.getByRole('alert').textContent()).toContain('Paket tidak dapat dibaca');
    await page.close();
  });
});
