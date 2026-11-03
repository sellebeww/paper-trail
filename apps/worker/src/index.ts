// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import amqp from 'amqplib';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import type { Log } from './messaging.js';
import { ConsoleNotifier, EmailNotifier } from './notifier.js';
import { loadTrustedCerts, redactUrl, requestTimestamp } from './tsa.js';
import { startWorker } from './worker.js';

const log: Log = (fields) => console.log(JSON.stringify(fields));

const config = loadConfig();
const pool = createPool(config.WORKER_DATABASE_URL);
const connection = await amqp.connect(config.AMQP_URL);
// Exit on connection loss so the supervisor restarts us; unacked messages are redelivered.
connection.on('error', (err: Error) =>
  log({ msg: 'rabbitmq error', level: 'error', error: err.message }),
);
connection.on('close', () => process.exit(1));

const trustedCerts = await loadTrustedCerts(config.TSA_CA_CERTS);
if (config.TSA_URLS.length === 0) {
  log({ msg: 'anchoring disabled: TSA_URLS is empty', level: 'warn' });
} else if (trustedCerts.length === 0) {
  log({
    msg: 'TSA_CA_CERTS not set: token signatures are checked, the TSA certificate chain is not',
    level: 'warn',
  });
}

const worker = await startWorker({
  config,
  pool,
  connection,
  log,
  timestamp: (data) =>
    requestTimestamp(
      { urls: config.TSA_URLS, timeoutMs: config.TSA_TIMEOUT_MS, trustedCerts },
      data,
    ),
  notifier:
    config.NOTIFIER === 'email'
      ? EmailNotifier.fromUrl(config.SMTP_URL!, config.SMTP_FROM)
      : new ConsoleNotifier(),
});

const tick = (name: string, fn: () => Promise<unknown[]>) => () =>
  fn().then(
    (jobs) => jobs.length && log({ msg: `${name} queued`, count: jobs.length }),
    (err: Error) => log({ msg: `${name} failed`, level: 'error', error: err.message }),
  );

const anchorTick = tick('anchor jobs', worker.tickAnchors);
const reminderTick = tick('reminder jobs', worker.tickReminders);
const timers = [
  ...(config.TSA_URLS.length
    ? [setInterval(anchorTick, config.ANCHOR_INTERVAL_HOURS * 3_600_000)]
    : []),
  setInterval(reminderTick, config.REMINDER_TICK_SECONDS * 1000),
];
if (config.TSA_URLS.length) void anchorTick(); // also scan once at start-up
void reminderTick();

log({
  msg: 'worker ready',
  tsa: config.TSA_URLS.map(redactUrl),
  anchor_interval_hours: config.ANCHOR_INTERVAL_HOURS,
  prefetch: config.WORKER_PREFETCH,
  notifier: config.NOTIFIER,
});

const shutdown = async () => {
  timers.forEach(clearInterval);
  connection.removeAllListeners('close');
  await worker.stop().catch(() => undefined);
  await connection.close().catch(() => undefined);
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
