// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// RabbitMQ topology and an at-least-once consumer with backoff retries and a dead-letter queue.
//
//   exchange <prefix>papertrail (direct, durable)
//     └─ <q>                main queue (durable), bound with routing key <q>
//   <q>.retry.<i>           one queue per backoff level: x-message-ttl = delay i, dead-letters back to <q>
//   <q>.dlq                 failed for good; inspected and replayed by a human (docs/OPERATIONS.md)
//
// One queue per delay (instead of per-message TTL) avoids head-of-line blocking: RabbitMQ only expires
// messages at the head of a queue, so mixed delays in one queue would wait on each other.
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { z } from 'zod';

export const topology = (prefix = '') => ({
  exchange: `${prefix}papertrail`,
  anchor: `${prefix}anchor.requests`,
  reminders: `${prefix}reminders`,
});
export type Topology = ReturnType<typeof topology>;

export const retryQueue = (queue: string, level: number) => `${queue}.retry.${level}`;
export const deadLetterQueue = (queue: string) => `${queue}.dlq`;

/** Every queue name the topology declares (used by tests and tooling to clean up). */
export const allQueues = (t: Topology, delays: number[]) =>
  [t.anchor, t.reminders].flatMap((q) => [
    q,
    ...delays.map((_, i) => retryQueue(q, i)),
    deadLetterQueue(q),
  ]);

export const assertTopology = async (ch: ConfirmChannel, t: Topology, delays: number[]) => {
  await ch.assertExchange(t.exchange, 'direct', { durable: true });
  for (const q of [t.anchor, t.reminders]) {
    await ch.assertQueue(q, { durable: true });
    await ch.bindQueue(q, t.exchange, q);
    for (const [i, ttl] of delays.entries()) {
      await ch.assertQueue(retryQueue(q, i), {
        durable: true,
        arguments: {
          'x-message-ttl': ttl,
          'x-dead-letter-exchange': t.exchange,
          'x-dead-letter-routing-key': q,
        },
      });
    }
    await ch.assertQueue(deadLetterQueue(q), { durable: true });
  }
};

/** Persistent publish that resolves only after the broker has confirmed it. */
export const publishJson = async (
  ch: ConfirmChannel,
  exchange: string,
  routingKey: string,
  body: unknown,
  messageId: string,
) => {
  ch.publish(exchange, routingKey, Buffer.from(JSON.stringify(body)), {
    persistent: true,
    contentType: 'application/json',
    messageId,
    timestamp: Math.floor(Date.now() / 1000),
  });
  await ch.waitForConfirms();
};

/** Thrown by a handler when retrying cannot help (bad data, invalid TSA answer): goes straight to the DLQ. */
export class PermanentError extends Error {
  override name = 'PermanentError';
}

export type Log = (fields: Record<string, unknown>) => void;

export interface ConsumeOptions<T> {
  queue: string;
  schema: z.ZodType<T>;
  /** Backoff delays; a job is tried delays.length + 1 times before it is dead-lettered. */
  delays: number[];
  handler: (job: T, ctx: { attempt: number }) => Promise<unknown>;
  /** Runs after the message is safely in the DLQ (e.g. mark the anchor failed). Best effort. */
  onDeadLetter?: (job: T, err: Error) => Promise<void>;
  log: Log;
}

/**
 * Manual-ack consumer. Success → ack. Failure → republish to the next retry level (or the DLQ when
 * retries are exhausted or the error is permanent) with publisher confirms, then ack the original.
 * If republishing fails, the original is nacked and redelivered, so a job is never silently lost.
 */
export const consumeWithRetry = async <T>(ch: ConfirmChannel, o: ConsumeOptions<T>) => {
  const forward = async (m: ConsumeMessage, queue: string, headers: Record<string, unknown>) => {
    ch.sendToQueue(queue, m.content, {
      persistent: true,
      contentType: m.properties.contentType as string | undefined,
      messageId: m.properties.messageId as string | undefined,
      headers: { ...(m.properties.headers ?? {}), ...headers },
    });
    await ch.waitForConfirms();
  };

  const handle = async (m: ConsumeMessage) => {
    const attempt = Number(m.properties.headers?.['x-attempt'] ?? 0);
    const messageId = m.properties.messageId as string | undefined;
    let job: T;
    try {
      job = o.schema.parse(JSON.parse(m.content.toString('utf8')));
    } catch {
      try {
        await forward(m, deadLetterQueue(o.queue), { 'x-error': 'malformed message' });
        ch.ack(m);
        o.log({
          msg: 'job dead-lettered',
          queue: o.queue,
          message_id: messageId,
          reason: 'malformed message',
        });
      } catch {
        ch.nack(m, false, true);
      }
      return;
    }

    try {
      const outcome = await o.handler(job, { attempt });
      ch.ack(m);
      o.log({ msg: 'job done', queue: o.queue, message_id: messageId, attempt, outcome });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const permanent = e instanceof PermanentError;
      try {
        if (!permanent && attempt < o.delays.length) {
          await forward(m, retryQueue(o.queue, attempt), {
            'x-attempt': attempt + 1,
            'x-last-error': e.message.slice(0, 500),
          });
          ch.ack(m);
          o.log({
            msg: 'job retry scheduled',
            queue: o.queue,
            message_id: messageId,
            attempt,
            retry_in_ms: o.delays[attempt],
            error: e.message,
          });
        } else {
          await forward(m, deadLetterQueue(o.queue), {
            'x-attempt': attempt + 1,
            'x-error': e.message.slice(0, 500),
          });
          ch.ack(m);
          o.log({
            msg: 'job dead-lettered',
            level: 'error',
            queue: o.queue,
            message_id: messageId,
            attempts: attempt + 1,
            permanent,
            error: e.message,
            action: `fix the cause, then replay from ${deadLetterQueue(o.queue)} (docs/OPERATIONS.md)`,
          });
          await o.onDeadLetter?.(job, e).catch((hookErr: Error) =>
            o.log({
              msg: 'dead-letter hook failed',
              level: 'error',
              queue: o.queue,
              error: hookErr.message,
            }),
          );
        }
      } catch {
        ch.nack(m, false, true);
      }
    }
  };

  const { consumerTag } = await ch.consume(o.queue, (m) => m && void handle(m), { noAck: false });
  return consumerTag;
};
