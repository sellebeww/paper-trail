// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { healthRoutes } from './app.js';

const up = async () => {};
const down = async () => {
  throw new Error('unreachable');
};

let server: ReturnType<ReturnType<typeof express>['listen']> | undefined;

const get = async (deps: Parameters<typeof healthRoutes>[0]) => {
  server = express().use(healthRoutes(deps)).listen(0);
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  return { status: res.status, body: await res.json() };
};

afterEach(() => server?.close());

describe('GET /health', () => {
  it('returns 200 when postgres and rabbitmq are up', async () => {
    const { status, body } = await get({ postgres: up, rabbitmq: up });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', checks: { postgres: 'up', rabbitmq: 'up' } });
  });

  it('returns 503 and names the failing dependency without leaking errors', async () => {
    const { status, body } = await get({ postgres: up, rabbitmq: down });
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'degraded', checks: { postgres: 'up', rabbitmq: 'down' } });
  });
});
