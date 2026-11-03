// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { describeHealth } from './health';

describe('describeHealth', () => {
  it('reports unreachable server', () => {
    expect(describeHealth(null)).toEqual([
      { tone: 'error', label: 'Server tidak dapat dihubungi' },
    ]);
  });

  it('flags only the failing service', () => {
    const view = describeHealth({
      status: 'degraded',
      checks: { postgres: 'up', rabbitmq: 'down' },
    });
    expect(view.map((v) => v.tone)).toEqual(['ok', 'warn']);
  });
});
