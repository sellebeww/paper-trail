// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// Creates (or updates the password of) the worker's login role from WORKER_DATABASE_URL and makes it a
// member of pt_worker, the least-privilege group role created by the migrations. Runs with the admin
// connection in DATABASE_URL. `pnpm --filter @paper-trail/worker db:role`
import pg from 'pg';

const admin = process.env['DATABASE_URL'];
const target = process.env['WORKER_DATABASE_URL'];
if (!admin || !target)
  throw new Error('DATABASE_URL (admin) and WORKER_DATABASE_URL must both be set');

const url = new URL(target);
const role = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role))
  throw new Error('worker role name must match [a-z_][a-z0-9_]*');
if (password.length < 12) throw new Error('worker role password must be at least 12 characters');
if (role === decodeURIComponent(new URL(admin).username))
  throw new Error('the worker must not use the admin role');

const client = new pg.Client({ connectionString: admin });
await client.connect();
try {
  const exists =
    (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;
  // Identifiers and literals are quoted by the server (format %I / %L), never by string concatenation.
  const statements = exists
    ? [
        'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
        'GRANT pt_worker TO %I',
      ]
    : ['CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L IN ROLE pt_worker'];
  for (const template of statements) {
    const { rows } = await client.query<{ sql: string }>(
      'SELECT format($1, $2::text, $3::text) AS sql',
      [template, role, password],
    );
    await client.query(rows[0]!.sql);
  }
  console.log(`${exists ? 'Updated' : 'Created'} login role "${role}" as a member of pt_worker.`);
} finally {
  await client.end();
}
