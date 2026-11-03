// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { csrfProtection, loadSession } from './auth.js';
import type { AppContext } from './context.js';
import { AppError, errorHandler, notFoundHandler, requestId } from './errors.js';
import { checkHealth, type HealthDeps } from './health.js';
import { authRoutes } from './routes/auth.js';
import { ledgerRoutes } from './routes/ledgers.js';
import { exportRoutes } from './routes/export.js';
import { reminderRoutes } from './routes/reminders.js';
import { witnessRoutes } from './routes/witness.js';

export const healthRoutes = (deps: HealthDeps): Router => {
  const router = Router();
  router.get('/health', async (_req, res) => {
    const report = await checkHealth(deps);
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  });
  return router;
};

export const buildApp = (ctx: AppContext) => {
  const { db, config } = ctx;
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY > 0) app.set('trust proxy', config.TRUST_PROXY);

  app.use(requestId);
  app.use(helmet());
  app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
  if (config.NODE_ENV !== 'test') {
    // Method, route and status only: no query string, headers, cookies or bodies.
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () =>
        console.log(
          JSON.stringify({
            msg: 'request',
            request_id: res.locals['requestId'],
            method: req.method,
            // Witness tokens are bearer secrets in the path; never write them to logs.
            path: req.path.replace(/^\/witness\/[^/]+/, '/witness/:token'),
            status: res.statusCode,
            ms: Date.now() - start,
          }),
        ),
      );
      next();
    });
  }

  app.use(healthRoutes(ctx.health));

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: config.API_RATE_LIMIT,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, _res, next) =>
        next(
          new AppError(429, 'RATE_LIMITED', 'Terlalu banyak permintaan. Coba lagi sebentar lagi.'),
        ),
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '64kb' })); // multipart uploads are handled by busboy, not here
  app.use(loadSession(db));
  app.use(csrfProtection(config));

  app.use(authRoutes(ctx));
  app.use(ledgerRoutes(ctx));
  app.use(witnessRoutes(ctx));
  app.use(reminderRoutes(ctx));
  app.use(exportRoutes(ctx));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};
