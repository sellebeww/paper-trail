// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// The API with files held in MEMORY instead of S3/MinIO. For browser tests (apps/web/e2e) and local demos
// without object storage: uploaded files vanish when the process stops, so never use this for real data.
//   tsx --conditions=source src/dev/serve-memory.ts      (same environment variables as the real API)
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { ConsoleMailer } from '../mailer.js';
import { MemoryStore } from '../storage.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

buildApp({
  db,
  store: new MemoryStore(),
  mailer: new ConsoleMailer(),
  config,
  health: { postgres: async () => void (await db.$queryRaw`SELECT 1`), rabbitmq: async () => {} },
}).listen(config.API_PORT, () => {
  console.log(JSON.stringify({ msg: 'api (memory store) listening', port: config.API_PORT }));
});
