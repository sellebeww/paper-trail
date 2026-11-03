// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Browser tests (Playwright driving the system Chrome) against a production build. Run: pnpm test:e2e
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Every file runs `vite build` into the same dist/, so files must not overlap.
    fileParallelism: false,
  },
});
