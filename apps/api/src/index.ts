// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import amqp from 'amqplib';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { S3Store } from './storage.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const store = new S3Store({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  bucket: config.S3_BUCKET,
  accessKey: config.S3_ACCESS_KEY,
  secretKey: config.S3_SECRET_KEY,
});

// The API must start without object storage; uploads then fail with 503 until it is reachable.
store
  .ensureBucket()
  .catch(() => console.error(JSON.stringify({ msg: 'object storage unavailable at startup' })));

const app = buildApp({
  db,
  store,
  config,
  health: {
    postgres: async () => {
      await db.$queryRaw`SELECT 1`;
    },
    rabbitmq: async () => {
      const connection = await amqp.connect(config.AMQP_URL);
      await connection.close();
    },
  },
});

app.listen(config.API_PORT, () => {
  console.log(JSON.stringify({ msg: 'api listening', port: config.API_PORT }));
});
