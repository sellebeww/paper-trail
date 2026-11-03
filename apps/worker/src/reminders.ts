// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { z } from 'zod';
import type { Pool } from './db.js';
import type { Notifier } from './notifier.js';

/** Indonesian zones have fixed offsets and no daylight saving, so no tz database is needed. */
export const TIMEZONE_OFFSET_MINUTES = {
  'Asia/Jakarta': 420,
  'Asia/Makassar': 480,
  'Asia/Jayapura': 540,
} as const;
export type ReminderTimezone = keyof typeof TIMEZONE_OFFSET_MINUTES;

export interface ReminderRule {
  daysOfWeek: number[]; // ISO: 1 = Monday … 7 = Sunday
  timeOfDay: string; // "HH:MM" local
  timezone: ReminderTimezone;
}

/** First moment strictly after `after` that matches the rule. */
export const nextReminderAt = (rule: ReminderRule, after: Date): Date => {
  const offset = TIMEZONE_OFFSET_MINUTES[rule.timezone] * 60_000;
  const [hours, minutes] = rule.timeOfDay.split(':').map(Number) as [number, number];
  const local = new Date(after.getTime() + offset); // UTC fields of `local` read as local wall time
  for (let day = 0; day <= 7; day++) {
    const wall = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + day,
      hours,
      minutes,
    );
    const isoWeekday = ((new Date(wall).getUTCDay() + 6) % 7) + 1;
    const instant = wall - offset;
    if (instant > after.getTime() && rule.daysOfWeek.includes(isoWeekday)) return new Date(instant);
  }
  throw new Error('reminder rule has no valid weekday');
};

export const reminderJobSchema = z
  .object({ schedule_id: z.uuid(), scheduled_for: z.iso.datetime() })
  .strict();
export type ReminderJob = z.infer<typeof reminderJobSchema>;

interface ScheduleRow {
  id: string;
  days_of_week: number[];
  time_of_day: string;
  timezone: ReminderTimezone;
  next_run_at: Date | null;
}
const rule = (r: ScheduleRow): ReminderRule => ({
  daysOfWeek: r.days_of_week,
  timeOfDay: r.time_of_day,
  timezone: r.timezone,
});

/**
 * Gives new schedules their first run time, then queues every due reminder and moves it to its next
 * occurrence. Publishing happens before COMMIT: a crash after publishing re-queues the reminder on the
 * next tick, and the delivery table turns that duplicate into a no-op. Missed occurrences (worker down)
 * are skipped rather than sent in a burst.
 */
export const scheduleReminders = async (
  db: Pool,
  publish: (job: ReminderJob) => Promise<void>,
  now = new Date(),
) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const fresh = await client.query<ScheduleRow>(
      `SELECT id, days_of_week, time_of_day, timezone, next_run_at FROM reminder_schedules
        WHERE enabled AND next_run_at IS NULL FOR UPDATE SKIP LOCKED LIMIT 500`,
    );
    for (const r of fresh.rows) {
      await client.query('UPDATE reminder_schedules SET next_run_at = $2 WHERE id = $1', [
        r.id,
        nextReminderAt(rule(r), now),
      ]);
    }

    const due = await client.query<ScheduleRow & { next_run_at: Date }>(
      `SELECT id, days_of_week, time_of_day, timezone, next_run_at FROM reminder_schedules
        WHERE enabled AND next_run_at <= $1 ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 500`,
      [now],
    );
    const jobs: ReminderJob[] = [];
    for (const r of due.rows) {
      const job = { schedule_id: r.id, scheduled_for: r.next_run_at.toISOString() };
      await publish(job);
      jobs.push(job);
      const from = r.next_run_at > now ? r.next_run_at : now;
      await client.query('UPDATE reminder_schedules SET next_run_at = $2 WHERE id = $1', [
        r.id,
        nextReminderAt(rule(r), from),
      ]);
    }
    await client.query('COMMIT');
    return jobs;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
};

export const reminderMessage = (ledgerTitle: string | null, webOrigin: string) => ({
  subject: 'Pengingat: catat hari ini di Paper Trail',
  text: [
    'Halo,',
    '',
    `Ini pengingat rutin untuk mencatat kejadian hari ini${ledgerTitle ? ` di "${ledgerTitle}"` : ''}.`,
    'Catatan yang dibuat pada hari yang sama lebih kuat daripada catatan yang ditulis belakangan.',
    '',
    `Buka Paper Trail: ${webOrigin}`,
    '',
    'Anda menerima email ini karena mengatur pengingat. Ubah atau hapus pengingat di aplikasi.',
  ].join('\n'),
});

/** Sends one reminder unless it was already delivered or the schedule was removed or disabled. */
export const processReminder = async (
  db: Pool,
  notifier: Notifier,
  job: ReminderJob,
  webOrigin: string,
) => {
  const { rows } = await db.query<{ enabled: boolean; email: string; title: string | null }>(
    `SELECT s.enabled, u.email, l.title
       FROM reminder_schedules s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN ledgers l ON l.id = s.ledger_id
      WHERE s.id = $1`,
    [job.schedule_id],
  );
  const s = rows[0];
  if (!s || !s.enabled) return 'skipped';
  const sent = await db.query(
    'SELECT 1 FROM reminder_deliveries WHERE schedule_id = $1 AND scheduled_for = $2',
    [job.schedule_id, job.scheduled_for],
  );
  if (sent.rowCount) return 'duplicate';

  // Send first, record second: a crash in between can repeat one reminder, but never lose it.
  await notifier.send({ to: s.email, ...reminderMessage(s.title, webOrigin) });
  await db.query(
    `INSERT INTO reminder_deliveries (id, schedule_id, scheduled_for, channel) VALUES (gen_random_uuid(), $1, $2, $3)
     ON CONFLICT (schedule_id, scheduled_for) DO NOTHING`,
    [job.schedule_id, job.scheduled_for, notifier.channel],
  );
  return 'sent';
};
