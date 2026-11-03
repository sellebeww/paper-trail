// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';
import { alias } from './vitest.config.js';

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
