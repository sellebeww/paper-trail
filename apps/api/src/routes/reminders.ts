// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import type { ReminderSchedule } from '../generated/prisma/client.js';

const TIMEZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'] as const;

const createBody = z
  .object({
    ledger_id: z.uuid().optional(),
    /** ISO weekdays: 1 = Senin … 7 = Minggu. */
    days_of_week: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, 'Hari tidak boleh berulang.'),
    time: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Format jam HH:MM, contoh 17:00.'),
    timezone: z.enum(TIMEZONES).default('Asia/Jakarta'),
  })
  .strict();

const json = (r: ReminderSchedule) => ({
  id: r.id,
  ledger_id: r.ledgerId,
  days_of_week: r.daysOfWeek,
  time: r.timeOfDay,
  timezone: r.timezone,
  enabled: r.enabled,
  next_run_at: r.nextRunAt?.toISOString() ?? null, // set by the worker shortly after creation
  created_at: r.createdAt.toISOString(),
});

export const reminderRoutes = ({ db }: AppContext): Router => {
  const router = Router();

  router.post('/reminders', async (req, res) => {
    const auth = requireAuth(res);
    const body = createBody.parse(req.body);
    if (body.ledger_id) {
      const ledger = await db.ledger.findFirst({
        where: { id: body.ledger_id, ownerId: auth.user.id },
      });
      if (!ledger) throw notFound('Ledger');
    }
    const reminder = await db.reminderSchedule.create({
      data: {
        userId: auth.user.id,
        ledgerId: body.ledger_id ?? null,
        daysOfWeek: [...body.days_of_week].sort(),
        timeOfDay: body.time,
        timezone: body.timezone,
      },
    });
    res.status(201).json({ reminder: json(reminder) });
  });

  router.get('/reminders', async (_req, res) => {
    const auth = requireAuth(res);
    const reminders = await db.reminderSchedule.findMany({
      where: { userId: auth.user.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ reminders: reminders.map(json) });
  });

  // Reminders are a convenience, not evidence, so they can be deleted.
  router.delete('/reminders/:id', async (req, res) => {
    const auth = requireAuth(res);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { count } = await db.reminderSchedule.deleteMany({ where: { id, userId: auth.user.id } });
    if (count === 0) throw notFound('Pengingat');
    res.status(204).end();
  });

  return router;
};
