// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp } from '../test/client.js';

let app: Awaited<ReturnType<typeof startTestApp>>;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('reminder schedules', () => {
  it('creates, lists and deletes a weekday 17:00 WIB reminder', async () => {
    const c = app.client();
    await c.register();
    const ledger = (await c.json('POST', '/ledgers', { json: { title: 'x', category: 'kerja' } }))
      .body.ledger;
    const created = await c.json('POST', '/reminders', {
      json: { ledger_id: ledger.id, days_of_week: [5, 1, 2, 3, 4], time: '17:00' },
    });
    expect(created.status).toBe(201);
    expect(created.body.reminder).toMatchObject({
      ledger_id: ledger.id,
      days_of_week: [1, 2, 3, 4, 5],
      time: '17:00',
      timezone: 'Asia/Jakarta',
      enabled: true,
      next_run_at: null,
    });
    expect((await c.json('GET', '/reminders')).body.reminders).toHaveLength(1);
    expect((await c.json('DELETE', `/reminders/${created.body.reminder.id}`)).status).toBe(204);
    expect((await c.json('GET', '/reminders')).body.reminders).toEqual([]);
  });

  it('validates input and keeps reminders private', async () => {
    const a = app.client();
    const b = app.client();
    await a.register();
    await b.register();
    for (const body of [
      { days_of_week: [], time: '17:00' },
      { days_of_week: [0], time: '17:00' },
      { days_of_week: [1, 1], time: '17:00' },
      { days_of_week: [1], time: '24:00' },
      { days_of_week: [1], time: '7:00' },
      { days_of_week: [1], time: '07:00', timezone: 'Europe/Berlin' },
    ]) {
      expect([body, (await a.json('POST', '/reminders', { json: body })).status]).toEqual([
        body,
        400,
      ]);
    }
    const ledgerOfB = (await b.json('POST', '/ledgers', { json: { title: 'x', category: 'gig' } }))
      .body.ledger;
    expect(
      (
        await a.json('POST', '/reminders', {
          json: { ledger_id: ledgerOfB.id, days_of_week: [1], time: '08:00' },
        })
      ).status,
    ).toBe(404);
    const own = (
      await a.json('POST', '/reminders', {
        json: { days_of_week: [6], time: '09:30', timezone: 'Asia/Makassar' },
      })
    ).body.reminder;
    expect((await b.json('DELETE', `/reminders/${own.id}`)).status).toBe(404);
    expect((await b.json('GET', '/reminders')).body.reminders).toEqual([]);
  });
});
