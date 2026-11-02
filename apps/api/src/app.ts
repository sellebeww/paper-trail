// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { checkHealth, type HealthDeps } from './health.js';

export const buildApp = (deps: HealthDeps, webOrigin: string) => {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: webOrigin }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

  app.get('/health', async (_req, res) => {
    const report = await checkHealth(deps);
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  });

  return app;
};
