// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig as loadWorkerConfig } from '../../worker/src/config.js';
import { loadConfig } from './config.js';

/** The values a newcomer gets by following the README: `cp .env.example .env`. */
const exampleEnv = Object.fromEntries(
  readFileSync(resolve(import.meta.dirname, '../../../.env.example'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

describe('configuration', () => {
  it('accepts .env.example exactly as shipped (API and worker)', () => {
    const api = loadConfig(exampleEnv);
    expect(api.STORAGE_DIR).toBeTruthy();
    expect(api.MAILER).toBe('console');
    expect(api.SMTP_URL).toBeUndefined(); // an empty value means "not set"
    expect(() => loadWorkerConfig(exampleEnv)).not.toThrow();
  });

  it('needs somewhere to put files', () => {
    const noStorage = Object.fromEntries(
      Object.entries(exampleEnv).filter(
        ([k]) => !/^(STORAGE_DIR|S3_(ENDPOINT|BUCKET|ACCESS_KEY|SECRET_KEY))$/.test(k),
      ),
    );
    expect(() => loadConfig(noStorage)).toThrow(/STORAGE_DIR/);
    expect(
      loadConfig({
        ...noStorage,
        S3_ENDPOINT: 'http://s3.test',
        S3_BUCKET: 'bucket',
        S3_ACCESS_KEY: 'a',
        S3_SECRET_KEY: 'b',
      }).S3_BUCKET,
    ).toBe('bucket');
  });

  it('refuses the console mailer in production, where it would print one-time links into the logs', () => {
    expect(() => loadConfig({ ...exampleEnv, NODE_ENV: 'production' })).toThrow(/MAILER/);
    expect(() => loadConfig({ ...exampleEnv, NODE_ENV: 'production', MAILER: 'smtp' })).toThrow(
      /SMTP_URL/,
    );
    expect(
      loadConfig({
        ...exampleEnv,
        NODE_ENV: 'production',
        MAILER: 'smtp',
        SMTP_URL: 'smtps://u:p@mail.test:465',
      }).MAILER,
    ).toBe('smtp');
  });
});
