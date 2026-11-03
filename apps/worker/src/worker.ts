// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import type { ChannelModel } from 'amqplib';
import {
  markAnchorFailed,
  processAnchor,
  scheduleAnchors,
  anchorJobSchema,
  type Timestamper,
} from './anchor.js';
import type { Config } from './config.js';
import type { Pool } from './db.js';
import { assertTopology, consumeWithRetry, publishJson, topology, type Log } from './messaging.js';
import type { Notifier } from './notifier.js';
import { processReminder, reminderJobSchema, scheduleReminders } from './reminders.js';

export interface WorkerDeps {
  config: Config;
  pool: Pool;
  connection: ChannelModel;
  timestamp: Timestamper;
  notifier: Notifier;
  log: Log;
  now?: () => Date;
}

/** Declares the topology, starts both consumers, and returns the scheduler ticks (driven by timers or tests). */
export const startWorker = async ({
  config,
  pool,
  connection,
  timestamp,
  notifier,
  log,
  now = () => new Date(),
}: WorkerDeps) => {
  const ch = await connection.createConfirmChannel();
  await ch.prefetch(config.WORKER_PREFETCH);
  const t = topology(config.QUEUE_PREFIX);
  const delays = config.RETRY_DELAYS_MS;
  await assertTopology(ch, t, delays);

  await consumeWithRetry(ch, {
    queue: t.anchor,
    schema: anchorJobSchema,
    delays,
    log,
    handler: (job) => processAnchor(pool, timestamp, job),
    onDeadLetter: (job, err) => markAnchorFailed(pool, job, err),
  });
  await consumeWithRetry(ch, {
    queue: t.reminders,
    schema: reminderJobSchema,
    delays,
    log,
    handler: (job) => processReminder(pool, notifier, job, config.WEB_ORIGIN),
  });

  return {
    channel: ch,
    topology: t,
    tickAnchors: () =>
      scheduleAnchors(pool, (job) =>
        publishJson(ch, t.exchange, t.anchor, job, `anchor:${job.ledger_id}:${job.head_seq}`),
      ),
    tickReminders: () =>
      scheduleReminders(
        pool,
        (job) =>
          publishJson(
            ch,
            t.exchange,
            t.reminders,
            job,
            `reminder:${job.schedule_id}:${job.scheduled_for}`,
          ),
        now(),
      ),
    stop: () => ch.close(),
  };
};
