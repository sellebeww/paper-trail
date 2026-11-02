// Copyright (c) 2026 Vassel Goleyu. All rights reserved.

export type HealthReport = {
  status: 'ok' | 'degraded';
  checks: { postgres: 'up' | 'down'; rabbitmq: 'up' | 'down' };
};

export type HealthView = { tone: 'ok' | 'warn' | 'error'; label: string };

const SERVICE_NAMES = { postgres: 'Basis data', rabbitmq: 'Antrean tugas' } as const;

/** Turns the API report (or null when the API is unreachable) into Indonesian UI text. */
export const describeHealth = (report: HealthReport | null): HealthView[] => {
  if (!report) return [{ tone: 'error', label: 'Server tidak dapat dihubungi' }];
  return (Object.keys(SERVICE_NAMES) as (keyof typeof SERVICE_NAMES)[]).map((key) =>
    report.checks[key] === 'up'
      ? { tone: 'ok', label: `${SERVICE_NAMES[key]}: berjalan` }
      : { tone: 'warn', label: `${SERVICE_NAMES[key]}: bermasalah` },
  );
};
