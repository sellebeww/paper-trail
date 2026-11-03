// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// The worker talks to Postgres as a least-privilege role (member of pt_worker): it can read the chain
// but has no INSERT/UPDATE/DELETE on entries, attachments, witnesses or users (docs/OPERATIONS.md).
import pg from 'pg';

export const createPool = (connectionString: string) => new pg.Pool({ connectionString, max: 5 });

export type Pool = pg.Pool;
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;
