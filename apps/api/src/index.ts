// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import amqp from 'amqplib';
import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 });

const app = buildApp(
  {
    postgres: async () => {
      await pool.query('SELECT 1');
    },
    rabbitmq: async () => {
      const connection = await amqp.connect(config.AMQP_URL);
      await connection.close();
    },
  },
  config.WEB_ORIGIN,
);

app.listen(config.API_PORT, () => {
  console.log(JSON.stringify({ msg: 'api listening', port: config.API_PORT }));
});
