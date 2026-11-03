// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const schema = z
  .object({
    AMQP_URL: z.string().min(1),
    /** Login role that is a member of pt_worker (least privilege). Never the migration/owner role. */
    WORKER_DATABASE_URL: z.string().min(1),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),

    /** Comma-separated RFC 3161 endpoints, tried in order. You must check each provider's terms. */
    // http(s) only: the worker must never fetch data:, file: or other schemes from config (SSRF surface).
    TSA_URLS: z
      .string()
      .default('')
      .transform(list)
      .pipe(z.array(z.url({ protocol: /^https?$/ }))),
    /** Optional PEM bundle of TSA root/intermediate certificates to verify the TSA chain against. */
    TSA_CA_CERTS: z.string().optional(),
    TSA_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
    /** How often to look for ledgers whose head changed since their last anchor. */
    ANCHOR_INTERVAL_HOURS: z.coerce.number().positive().default(6),

    /** Backoff before retries 1, 2, … (milliseconds). After the last one the job goes to the DLQ. */
    RETRY_DELAYS_MS: z
      .string()
      .default('10000,60000,300000,1800000')
      .transform((s) => list(s).map(Number))
      .pipe(z.array(z.number().int().positive()).min(1)),
    WORKER_PREFETCH: z.coerce.number().int().min(1).max(100).default(4),
    /** Namespaces exchange and queues (tests use a random prefix). */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z0-9_.-]*$/)
      .default(''),

    NOTIFIER: z.enum(['console', 'email']).default('console'),
    SMTP_URL: z.string().optional(),
    SMTP_FROM: z.string().default('Paper Trail <no-reply@localhost>'),
    REMINDER_TICK_SECONDS: z.coerce.number().int().min(5).default(60),
  })
  .refine((c) => c.NOTIFIER !== 'email' || !!c.SMTP_URL, {
    message: 'NOTIFIER=email needs SMTP_URL',
    path: ['SMTP_URL'],
  });

export type Config = z.infer<typeof schema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);
