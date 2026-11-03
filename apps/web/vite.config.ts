// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), '');
  const apiPort = env['API_PORT'] ?? '3000';
  const chain = resolve(import.meta.dirname, '../../packages/chain/src');
  const verifier = resolve(import.meta.dirname, '../../packages/verifier/src');
  return {
    plugins: [react()],
    resolve: {
      // Bundle the package sources directly. /verify runs the same chain and verifier code as the CLI.
      alias: [
        { find: /^@paper-trail\/chain\/browser$/, replacement: `${chain}/browser.ts` },
        { find: /^@paper-trail\/chain$/, replacement: `${chain}/index.ts` },
        { find: /^@paper-trail\/verifier$/, replacement: `${verifier}/index.ts` },
      ],
    },
    server: {
      proxy: {
        '/api': {
          target: `http://localhost:${apiPort}`,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
