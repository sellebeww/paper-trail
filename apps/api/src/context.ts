// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { HealthDeps } from './health.js';
import type { ObjectStore } from './storage.js';

export interface AppContext {
  db: Db;
  store: ObjectStore;
  config: Config;
  health: HealthDeps;
}
