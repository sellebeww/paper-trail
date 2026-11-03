// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0

export type HealthDeps = {
  postgres: () => Promise<void>;
  rabbitmq: () => Promise<void>;
};

export type HealthReport = {
  status: 'ok' | 'degraded';
  checks: { postgres: 'up' | 'down'; rabbitmq: 'up' | 'down' };
};

const probe = async (check: () => Promise<void>, timeoutMs: number): Promise<'up' | 'down'> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
};

export const checkHealth = async (deps: HealthDeps, timeoutMs = 2000): Promise<HealthReport> => {
  const [postgres, rabbitmq] = await Promise.all([
    probe(deps.postgres, timeoutMs),
    probe(deps.rabbitmq, timeoutMs),
  ]);
  return {
    status: postgres === 'up' && rabbitmq === 'up' ? 'ok' : 'degraded',
    checks: { postgres, rabbitmq },
  };
};
