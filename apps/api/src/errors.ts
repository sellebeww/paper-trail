// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/** An error whose message is safe to show to the user (Indonesian, no internals). */
export class AppError extends Error {
  override name = 'AppError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Data') =>
  new AppError(404, 'NOT_FOUND', `${what} tidak ditemukan.`);

export const requestId: RequestHandler = (_req, res, next) => {
  const id = randomUUID();
  res.locals['requestId'] = id;
  res.setHeader('X-Request-Id', id);
  next();
};

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('Halaman'));

const body = (
  res: Parameters<ErrorRequestHandler>[2],
  status: number,
  code: string,
  message: string,
  details?: unknown,
) =>
  res.status(status).json({
    error: {
      code,
      message,
      request_id: res.locals['requestId'],
      ...(details === undefined ? {} : { details }),
    },
  });

/**
 * Last middleware. Anything that is not an AppError, a validation error or a body-parser error becomes a
 * generic 500. Only the error name and code are logged: Prisma/driver messages can contain submitted values.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, _next) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof AppError)
    return void body(res, err.status, err.code, err.message, err.details);
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return void body(res, 400, 'VALIDATION_ERROR', 'Data yang dikirim tidak valid.', issues);
  }
  const type = (err as { type?: string } | null)?.type;
  if (type === 'entity.too.large')
    return void body(res, 413, 'PAYLOAD_TOO_LARGE', 'Data terlalu besar.');
  if (type === 'entity.parse.failed')
    return void body(res, 400, 'INVALID_JSON', 'Format JSON tidak valid.');

  const e = err as { name?: string; code?: string };
  console.error(
    JSON.stringify({
      msg: 'unhandled error',
      request_id: res.locals['requestId'],
      name: e?.name,
      code: e?.code,
    }),
  );
  body(res, 500, 'INTERNAL_ERROR', 'Terjadi kesalahan di server. Coba lagi nanti.');
};
