// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';
import { MemoryStore } from '../src/storage.js';
import { testDatabaseUrls } from './global-setup.js';

export const PASSWORD = 'kata-sandi-panjang-1';
export const ORIGIN = 'http://localhost:5173';

export const startTestApp = async (overrides: Record<string, string> = {}) => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrls().test,
    AMQP_URL: 'amqp://unused',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_BUCKET: 'test-bucket',
    S3_ACCESS_KEY: 'unused',
    S3_SECRET_KEY: 'unused',
    API_RATE_LIMIT: '100000',
    AUTH_RATE_LIMIT: '100000',
    EXPORT_RATE_LIMIT: '100000',
    UPLOAD_MAX_BYTES: String(2 * 1024 * 1024),
    ...overrides,
  });
  const db = createDb(config.DATABASE_URL);
  const store = new MemoryStore();
  const server = buildApp({
    db,
    store,
    config,
    health: { postgres: async () => {}, rabbitmq: async () => {} },
  }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    db,
    store,
    base,
    client: () => new TestClient(base),
    close: async () => {
      server.close();
      await db.$disconnect();
    },
  };
};

/** Response bodies are untyped in tests on purpose: assertions probe fields directly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TestJson = any;

export interface RequestOptions {
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** Send the CSRF header from the cookie jar (default). Set false to simulate a forged request. */
  csrf?: boolean;
}

/** A minimal browser: keeps cookies and echoes the CSRF cookie into the CSRF header. */
export class TestClient {
  readonly jar = new Map<string, string>();
  constructor(private readonly base: string) {}

  private remember(res: Response) {
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!;
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      if (/expires=thu, 01 jan 1970/i.test(cookie) || /max-age=0/i.test(cookie))
        this.jar.delete(name);
      else this.jar.set(name, pair.slice(i + 1));
    }
  }

  async raw(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const { csrf = true } = opts;
    const unsafe = method !== 'GET' && method !== 'HEAD';
    if (unsafe && csrf && !this.jar.has('pt_csrf')) await this.raw('GET', '/auth/csrf');

    const headers: Record<string, string> = {};
    if (this.jar.size) headers['cookie'] = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (unsafe && csrf && this.jar.has('pt_csrf'))
      headers['x-csrf-token'] = this.jar.get('pt_csrf')!;
    if (opts.json !== undefined) headers['content-type'] = 'application/json';
    Object.assign(headers, opts.headers);

    const res = await fetch(this.base + path, {
      method,
      headers,
      body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
      redirect: 'manual',
    });
    this.remember(res);
    return res;
  }

  async json(method: string, path: string, opts: RequestOptions = {}) {
    const res = await this.raw(method, path, opts);
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: (text ? JSON.parse(text) : undefined) as TestJson,
    };
  }

  async register(email = `${randomUUID()}@example.test`, password = PASSWORD) {
    const res = await this.json('POST', '/auth/register', { json: { email, password } });
    if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
    return { email, user: res.body.user as { id: string; email: string } };
  }
}

export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

export const uploadForm = (
  type: string,
  bytes: Uint8Array,
  filename: string,
  claimedMime = 'application/octet-stream',
  caption?: string,
) => {
  const form = new FormData();
  form.set('type', type); // must precede the file part
  if (caption) form.set('caption', caption);
  form.set('file', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: claimedMime }), filename);
  return form;
};
