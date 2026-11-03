// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export const createDb = (connectionString: string) =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

export type Db = ReturnType<typeof createDb>;
