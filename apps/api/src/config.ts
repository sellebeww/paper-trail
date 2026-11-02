// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  /** Number of reverse proxies in front of the API (for correct client IPs in rate limiting). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  DATABASE_URL: z.string().min(1),
  AMQP_URL: z.string().min(1),

  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(3),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),

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
  /** Requests per IP per minute on everything else. */
  API_RATE_LIMIT: z.coerce.number().int().min(1).default(300),
});

export type Config = z.infer<typeof schema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);
