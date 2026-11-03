// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export const alias = {
  '@paper-trail/chain': resolve(import.meta.dirname, '../chain/src/index.ts'),
  '@paper-trail/verifier/testing': resolve(import.meta.dirname, 'src/testing/mock-tsa.ts'),
  '@paper-trail/verifier': resolve(import.meta.dirname, 'src/index.ts'),
};

export default defineConfig({ resolve: { alias }, test: { testTimeout: 15_000 } });
