// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { z } from 'zod';

const schema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  AMQP_URL: z.string().min(1),
});

export type Config = z.infer<typeof schema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);
