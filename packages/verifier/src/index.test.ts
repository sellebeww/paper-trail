// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { USAGE } from './index.js';

describe('verifier package', () => {
  it('documents its CLI usage', () => {
    expect(USAGE).toContain('paper-trail-verify');
  });
});
