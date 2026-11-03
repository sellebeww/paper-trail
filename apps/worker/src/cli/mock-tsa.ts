// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// Runs the local mock TSA for offline demos. Its tokens are signed by a throwaway CA and prove nothing
// about real time: never point a real deployment at it. `pnpm --filter @paper-trail/worker mock-tsa`
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createMockTsa } from '@paper-trail/verifier/testing';

const port = Number(process.env['MOCK_TSA_PORT'] ?? 3318);
const caOut = resolve(
  process.env['MOCK_TSA_CA_OUT'] ?? resolve(import.meta.dirname, '../../../../.mock-tsa-ca.pem'),
);

const tsa = await createMockTsa(port);
await writeFile(caOut, tsa.caPem);
console.log(`Mock TSA (DEMO ONLY, untrusted) listening on ${tsa.url}`);
console.log(`Its CA certificate was written to ${caOut}. For a local demo set in .env:`);
console.log(`  TSA_URLS=${tsa.url}`);
console.log(`  TSA_CA_CERTS=${caOut}`);
console.log('The CA is regenerated on every start; restart the worker after restarting this.');

const stop = () => void tsa.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
