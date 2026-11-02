// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../.env'));
} catch {
  // .env is optional: CI and tests pass DATABASE_URL directly.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL'] },
});
