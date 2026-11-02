// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { useEffect, useState } from 'react';
import { describeHealth, type HealthReport } from './health';

const DISCLAIMER =
  'Paper Trail membantu membuktikan bahwa catatan tidak diubah setelah dibuat dan kapan catatan itu ada. Ini bukan nasihat hukum dan tidak menjamin penerimaan sebagai alat bukti. Konsultasikan dengan pendamping hukum.';

const COLORS = { ok: '#15803d', warn: '#b45309', error: '#b91c1c' } as const;

export function App() {
  const [report, setReport] = useState<HealthReport | null>(null);

  useEffect(() => {
    const load = () =>
      // The API answers 503 with a JSON body when a dependency is down, so parse regardless of status.
      fetch('/api/health')
        .then((res) => res.json() as Promise<HealthReport>)
        .then(setReport)
        .catch(() => setReport(null));
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <main
      style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 480, margin: '0 auto', padding: 16 }}
    >
      <h1>Paper Trail</h1>
      <p>Bukti yang tidak bisa kamu edit sendiri, bahkan kalau kamu mau.</p>
      <h2>Status layanan</h2>
      <ul>
        {describeHealth(report).map((item) => (
          <li key={item.label} style={{ color: COLORS[item.tone] }}>
            {item.label}
          </li>
        ))}
      </ul>
      <small>{DISCLAIMER}</small>
      <p>
        <small>© 2026 Vassel Goleyu</small>
      </p>
    </main>
  );
}
