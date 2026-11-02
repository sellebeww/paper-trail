// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// Integration tests run against a real Postgres (docker compose), in a dedicated database that is
// dropped and re-migrated on every run. Entries are append-only, so a fresh database is the only reset.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import pg from 'pg';

const TEST_DB = 'papertrail_test';

export const testDatabaseUrls = () => {
  try {
    process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
  } catch {
    // .env is optional when DATABASE_URL is already set.
  }
  const admin = process.env['DATABASE_URL'];
  if (!admin) throw new Error('DATABASE_URL is not set. Run `pnpm infra:up` first.');
  const url = new URL(admin);
  url.pathname = `/${TEST_DB}`;
  return { admin, test: url.toString() };
};

export default async function setup() {
  const urls = testDatabaseUrls();
  const client = new pg.Client({ connectionString: urls.admin });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await client.end();
  }
  execFileSync(resolve(import.meta.dirname, '../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: urls.test },
    stdio: 'inherit',
  });
}
