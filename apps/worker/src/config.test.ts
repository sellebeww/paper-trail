// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('worker config', () => {
  it('requires AMQP_URL', () => {
    expect(() => loadConfig({})).toThrow();
    expect(loadConfig({ AMQP_URL: 'amqp://localhost' }).AMQP_URL).toBe('amqp://localhost');
  });
});
