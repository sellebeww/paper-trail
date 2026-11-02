// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { describe, expect, it } from 'vitest';
import { USAGE } from './index.js';

describe('verifier package', () => {
  it('documents its CLI usage', () => {
    expect(USAGE).toContain('papertrail-verify');
  });
});
