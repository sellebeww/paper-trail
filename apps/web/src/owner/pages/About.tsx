// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { describeHealth, type HealthReport } from '../../health';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/messages';

const PROVES: MessageKey[] = ['about.p1', 'about.p2', 'about.p3', 'about.p4'];
const NOT_PROVES: MessageKey[] = ['about.n1', 'about.n2', 'about.n3', 'about.n4', 'about.n5'];

export function AboutPage() {
  const { t } = useI18n();
  const [report, setReport] = useState<HealthReport | null | undefined>(undefined);
  useEffect(() => {
    // The API answers 503 with a JSON body when a dependency is down, so parse regardless of status.
    fetch('/api/health')
      .then((res) => res.json() as Promise<HealthReport>)
      .then(setReport)
      .catch(() => setReport(null));
  }, []);

  return (
    <article className="about">
      <h1>{t('about.title')}</h1>
      <p className="lede">{t('about.lede')}</p>

      <section className="card">
        <h2>{t('about.provesTitle')}</h2>
        <ul className="ticks">
          {PROVES.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      </section>

      <section className="card card--limits">
        <h2>{t('about.notTitle')}</h2>
        <ul className="crosses">
          {NOT_PROVES.map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2>{t('about.anchorTitle')}</h2>
        <p>{t('about.anchorBody')}</p>
        <h2>{t('about.witnessTitle')}</h2>
        <p>{t('about.witnessBody')}</p>
        <h2>{t('about.mistakeTitle')}</h2>
        <p>{t('about.mistakeBody')}</p>
        <h2>{t('about.verifyTitle')}</h2>
        <p>
          {t('about.verifyBody')} <a href="/verify">/verify</a>
        </p>
      </section>

      <section className="card card--legal">
        <h2>{t('about.legalTitle')}</h2>
        <p>{t('legal.disclaimer')}</p>
        <p>{t('about.legalMore')}</p>
      </section>

      <section>
        <h2>{t('about.statusTitle')}</h2>
        {report === undefined ? (
          <p>{t('state.loading')}</p>
        ) : (
          <ul>
            {describeHealth(report).map((item) => (
              <li key={item.label}>{item.label}</li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
