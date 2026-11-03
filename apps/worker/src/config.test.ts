// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { AMQP_URL: 'amqp://localhost', WORKER_DATABASE_URL: 'postgresql://w@localhost/db' };

describe('worker config', () => {
  it('requires the broker and the worker database role', () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ AMQP_URL: 'amqp://localhost' })).toThrow();
    expect(loadConfig(base)).toMatchObject({
      ANCHOR_INTERVAL_HOURS: 6,
      TSA_URLS: [],
      RETRY_DELAYS_MS: [10_000, 60_000, 300_000, 1_800_000],
    });
  });

  it('parses a TSA fallback list and rejects non-URLs', () => {
    expect(
      loadConfig({ ...base, TSA_URLS: 'https://a.example/tsr, http://b.example/tsr' }).TSA_URLS,
    ).toEqual(['https://a.example/tsr', 'http://b.example/tsr']);
    expect(() => loadConfig({ ...base, TSA_URLS: 'not a url' })).toThrow();
  });

  it('needs SMTP_URL for email notifications', () => {
    expect(() => loadConfig({ ...base, NOTIFIER: 'email' })).toThrow();
    expect(
      loadConfig({ ...base, NOTIFIER: 'email', SMTP_URL: 'smtp://localhost:2525' }).NOTIFIER,
    ).toBe('email');
  });
});
