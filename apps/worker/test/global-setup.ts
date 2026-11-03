// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// Worker integration tests use their own database (and the real RabbitMQ), so they can run alongside the
// API's integration tests. Same migrations as the API: the schema has one source of truth.
import { createTestDatabase } from '../../api/test/global-setup.js';

export const WORKER_TEST_DB = 'papertrail_worker_test';

export default () => createTestDatabase(WORKER_TEST_DB);
