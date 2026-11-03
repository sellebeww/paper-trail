// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { ConsoleNotifier, EmailNotifier, maskEmail } from './notifier.js';
import { nextReminderAt, reminderMessage, type ReminderRule } from './reminders.js';

const weekdays17: ReminderRule = {
  daysOfWeek: [1, 2, 3, 4, 5],
  timeOfDay: '17:00',
  timezone: 'Asia/Jakarta',
};

describe('nextReminderAt', () => {
  it.each([
    // [now (UTC), expected (UTC)] — 17:00 WIB is 10:00 UTC
    ['Monday 09:00 WIB → same day 17:00', '2026-11-02T02:00:00.000Z', '2026-11-02T10:00:00.000Z'],
    ['Monday exactly 17:00 → Tuesday', '2026-11-02T10:00:00.000Z', '2026-11-03T10:00:00.000Z'],
    ['Friday 18:00 → next Monday', '2026-11-06T11:00:00.000Z', '2026-11-09T10:00:00.000Z'],
    ['Saturday → Monday', '2026-11-07T05:00:00.000Z', '2026-11-09T10:00:00.000Z'],
    [
      'Sunday 23:30 WIB (16:30 UTC) → Monday',
      '2026-11-08T16:30:00.000Z',
      '2026-11-09T10:00:00.000Z',
    ],
    [
      'UTC still Sunday but WIB already Monday 06:00',
      '2026-11-08T23:00:00.000Z',
      '2026-11-09T10:00:00.000Z',
    ],
  ])('%s', (_label, now, expected) => {
    expect(nextReminderAt(weekdays17, new Date(now)).toISOString()).toBe(expected);
  });

  it('uses the fixed offsets of WITA and WIT', () => {
    const now = new Date('2026-11-02T00:00:00.000Z');
    expect(nextReminderAt({ ...weekdays17, timezone: 'Asia/Makassar' }, now).toISOString()).toBe(
      '2026-11-02T09:00:00.000Z',
    );
    expect(nextReminderAt({ ...weekdays17, timezone: 'Asia/Jayapura' }, now).toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
  });

  it('handles a once-a-week rule a full week ahead and midnight', () => {
    const sundayMidnight: ReminderRule = {
      daysOfWeek: [7],
      timeOfDay: '00:00',
      timezone: 'Asia/Jakarta',
    };
    // Sunday 00:00 WIB = Saturday 17:00 UTC. Asked exactly then, the next one is a week later.
    expect(nextReminderAt(sundayMidnight, new Date('2026-11-07T17:00:00.000Z')).toISOString()).toBe(
      '2026-11-14T17:00:00.000Z',
    );
  });
});

describe('notifiers', () => {
  it('builds an Indonesian reminder email with the ledger title and app link', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sent: string[] = [];
    const notifier = new EmailNotifier(
      {
        sendMail: async (m: object) => sent.push((await transport.sendMail(m)).message as string),
      } as never,
      'Paper Trail <no-reply@example.test>',
    );
    await notifier.send({
      to: 'budi@example.test',
      ...reminderMessage('Sengketa lembur', 'https://app.example.test'),
    });
    const mail = JSON.parse(sent[0]!) as {
      to: { address: string }[];
      subject: string;
      text: string;
    };
    expect(mail.to[0]!.address).toBe('budi@example.test');
    expect(mail.subject).toBe('Pengingat: catat hari ini di Paper Trail');
    expect(mail.text).toContain('di "Sengketa lembur"');
    expect(mail.text).toContain('https://app.example.test');
  });

  it('console notifier never prints the full address or the body', async () => {
    const lines: string[] = [];
    await new ConsoleNotifier((l) => lines.push(l)).send({
      to: 'budi@example.test',
      subject: 'S',
      text: 'rahasia',
    });
    expect(lines[0]).toContain('b***@example.test');
    expect(lines[0]).not.toMatch(/budi@|rahasia/);
    expect(maskEmail('x@y.z')).toBe('x***@y.z');
  });
});
