// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export const createDb = (connectionString: string) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

export type Db = ReturnType<typeof createDb>;
