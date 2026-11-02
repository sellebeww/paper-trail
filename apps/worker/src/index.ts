// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import amqp from 'amqplib';
import { loadConfig } from './config.js';

const log = (msg: string) => console.log(JSON.stringify({ msg }));

const connection = await amqp.connect(loadConfig().AMQP_URL);
// Exit on loss so the process supervisor restarts us; reconnect logic comes with the first real consumer.
connection.on('error', (err: Error) => {
  console.error(JSON.stringify({ msg: 'rabbitmq error', error: err.message }));
});
connection.on('close', () => process.exit(1));

log('worker ready');

const shutdown = async () => {
  connection.removeAllListeners('close');
  await connection.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
