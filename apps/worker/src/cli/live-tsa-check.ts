// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// One-off compatibility check of a REAL time-stamping authority with the worker's own client and the verifier:
// sends the SHA-256 of random bytes (no user data), validates the token, and prints what the TSA returned.
//   TSA_URLS=https://tsa.example/tsr TSA_CA_CERTS=roots.pem pnpm --filter @paper-trail/worker tsa:check
// Run it before relying on a provider, and read the provider's terms first (docs/OPERATIONS.md, "Choosing a TSA").
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.js';
import { loadTrustedCerts, redactUrl, requestTimestamp } from '../tsa.js';

const config = loadConfig({
  AMQP_URL: 'unused',
  WORKER_DATABASE_URL: 'unused',
  TSA_URLS: process.env['TSA_URLS'],
  TSA_CA_CERTS: process.env['TSA_CA_CERTS'],
  TSA_TIMEOUT_MS: process.env['TSA_TIMEOUT_MS'],
});
if (config.TSA_URLS.length === 0) throw new Error('Set TSA_URLS to the TSA endpoint to check.');
const trustedCerts = await loadTrustedCerts(config.TSA_CA_CERTS);
if (trustedCerts.length === 0)
  console.warn('TSA_CA_CERTS not set: the certificate chain will NOT be checked.');

const started = Date.now();
const r = await requestTimestamp(
  { urls: config.TSA_URLS, timeoutMs: config.TSA_TIMEOUT_MS, trustedCerts },
  randomBytes(64),
);
console.log(
  JSON.stringify(
    {
      tsa: r.tsaUrl || config.TSA_URLS.map(redactUrl),
      gen_time: r.genTime.toISOString(),
      clock_skew_ms: r.genTime.getTime() - Date.now(),
      accuracy_ms: r.accuracyMs,
      chain_verified: r.chainVerified,
      token_bytes: r.token.length,
      round_trip_ms: Date.now() - started,
    },
    null,
    2,
  ),
);
