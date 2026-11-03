// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// Integration tests run against a real Postgres (docker compose), in a dedicated database that is
// dropped and re-migrated on every run. Entries are append-only, so a fresh database is the only reset.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';

const TEST_DB = 'papertrail_test';

/** URLs for an admin connection and for the test database `name` (worker tests use their own name). */
export const testDatabaseUrls = (name = TEST_DB) => {
  try {
    process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
  } catch {
    // .env is optional when DATABASE_URL is already set.
  }
  const admin = process.env['DATABASE_URL'];
  if (!admin) throw new Error('DATABASE_URL is not set. Run `pnpm infra:up` first.');
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return { admin, test: url.toString() };
};

/** Drops and recreates database `name`, then applies every migration. */
export const createTestDatabase = async (name: string) => {
  if (!/^[a-z_]+$/.test(name)) throw new Error('test database name must be [a-z_]+');
  const urls = testDatabaseUrls(name);
  const client = new pg.Client({ connectionString: urls.admin });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }
  execFileSync(resolve(import.meta.dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: urls.test },
    stdio: 'inherit',
  });
};

export default () => createTestDatabase(TEST_DB);
