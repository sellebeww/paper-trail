// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Test against the chain source directly, so tests never run on a stale build.
export const alias = {
  '@paper-trail/chain': resolve(import.meta.dirname, '../../packages/chain/src/index.ts'),
  '@paper-trail/verifier/testing': resolve(
    import.meta.dirname,
    '../../packages/verifier/src/testing/mock-tsa.ts',
  ),
  '@paper-trail/verifier': resolve(import.meta.dirname, '../../packages/verifier/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: { exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'] },
});
