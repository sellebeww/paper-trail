// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
    /** Number of reverse proxies in front of the API (for correct client IPs in rate limiting). */
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    DATABASE_URL: z.string().min(1),
    AMQP_URL: z.string().min(1),

    /** Files go to this directory when set; otherwise to the S3-compatible store below. */
    STORAGE_DIR: z.string().min(1).optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_BUCKET: z.string().min(3).optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ACCESS_KEY: z.string().min(1).optional(),
    S3_SECRET_KEY: z.string().min(1).optional(),

    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .default(24 * 7),
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(15 * 1024 * 1024),
    /** Failed-or-not attempts per IP per 15 minutes on login and register. */
    AUTH_RATE_LIMIT: z.coerce.number().int().min(1).default(10),
    /** Default lifetime of a witness link. Owners may choose 1 hour to 30 days. */
    WITNESS_INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(72),
    /** Public witness endpoints: requests per IP per 15 minutes, and per token per 15 minutes. */
    WITNESS_RATE_LIMIT_IP: z.coerce.number().int().min(1).default(60),
    WITNESS_RATE_LIMIT_TOKEN: z.coerce.number().int().min(1).default(20),
    /** Evidence pack / PDF exports per IP per 10 minutes (they read the whole ledger). */
    EXPORT_RATE_LIMIT: z.coerce.number().int().min(1).default(20),
    /** Largest total size of attachments bundled into one zip. */
    EXPORT_MAX_FILES_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(100 * 1024 * 1024),
    /** Requests per IP per minute on everything else. */
    API_RATE_LIMIT: z.coerce.number().int().min(1).default(300),
  })
  .refine(
    (c) => c.STORAGE_DIR || (c.S3_ENDPOINT && c.S3_BUCKET && c.S3_ACCESS_KEY && c.S3_SECRET_KEY),
    {
      message: 'set STORAGE_DIR, or S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY',
      path: ['STORAGE_DIR'],
    },
  );

export type Config = z.infer<typeof schema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);
