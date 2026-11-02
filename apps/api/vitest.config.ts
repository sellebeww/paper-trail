// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Test against the chain source directly, so tests never run on a stale build.
export const alias = {
  '@paper-trail/chain': resolve(import.meta.dirname, '../../packages/chain/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: { exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'] },
});
