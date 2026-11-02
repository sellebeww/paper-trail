// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), '');
  const apiPort = env['API_PORT'] ?? '3000';
  const chain = resolve(import.meta.dirname, '../../packages/chain/src');
  return {
    plugins: [react()],
    resolve: {
      // Bundle the chain source directly. The page only imports the browser entry; the Node entry is
      // aliased for tests, which verify browser signatures with the server-side verifier.
      alias: [
        { find: /^@paper-trail\/chain\/browser$/, replacement: `${chain}/browser.ts` },
        { find: /^@paper-trail\/chain$/, replacement: `${chain}/index.ts` },
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
