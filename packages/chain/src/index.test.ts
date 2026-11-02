// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { describe, expect, it } from 'vitest';
import { SPEC_VERSION } from './index.js';

describe('chain package', () => {
  it('declares the spec version it targets', () => {
    expect(SPEC_VERSION).toBe('0.1');
  });
});
