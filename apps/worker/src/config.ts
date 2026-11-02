// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { z } from 'zod';

const schema = z.object({ AMQP_URL: z.string().min(1) });

export type Config = z.infer<typeof schema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);
