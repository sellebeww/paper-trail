// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { Component, useEffect, useRef, type ReactNode } from 'react';
import './owner.css';
import { api } from './lib/api';
import { I18nProvider, useI18n } from './lib/i18n';
import { clearQueries, setQueryData } from './lib/query';
import { Link, Router, Routes, useNavigate, usePath, type Route } from './lib/router';
import { useMe } from './lib/session';
import { AboutPage } from './pages/About';
import { AddEntryPage } from './pages/AddEntry';
import { ExportPage } from './pages/Export';
import { LedgerPage } from './pages/Ledger';
import { LedgersPage } from './pages/Ledgers';
import { LoginPage } from './pages/Login';
import { WitnessPanelPage } from './pages/WitnessPanel';
import { ErrorBox, Loading } from './ui';

/** Everything behind the login: shows nothing but a spinner until we know who the visitor is. */
function Private({ children }: { children: ReactNode }) {
  const me = useMe();
  const navigate = useNavigate();
  const anonymous = me.data === null;
  useEffect(() => {
    if (anonymous) navigate('/masuk', { replace: true });
  }, [anonymous, navigate]);
  if (me.error) return <ErrorBox error={me.error} onRetry={me.refetch} />;
  if (me.loading || anonymous) return <Loading />;
  return <>{children}</>;
}

const routes: Route[] = [
  {
    path: '/',
    render: () => (
      <Private>
        <LedgersPage />
      </Private>
    ),
  },
  { path: '/masuk', render: () => <LoginPage /> },
  { path: '/tentang', render: () => <AboutPage /> },
  {
    path: '/ledger/:id',
    render: ({ id }) => (
      <Private>
        <LedgerPage ledgerId={id!} />
      </Private>
    ),
  },
  {
    path: '/ledger/:id/tambah/:kind',
    render: ({ id, kind }) => (
      <Private>
        <AddEntryPage ledgerId={id!} kind={kind!} />
      </Private>
    ),
  },
  {
    path: '/ledger/:id/saksi/:seq',
    render: ({ id, seq }) => (
      <Private>
        <WitnessPanelPage ledgerId={id!} seq={Number(seq)} />
      </Private>
    ),
  },
  {
    path: '/ledger/:id/ekspor',
    render: ({ id }) => (
      <Private>
        <ExportPage ledgerId={id!} />
      </Private>
    ),
  },
];

function NotFound() {
  const { t } = useI18n();
  return (
    <section>
      <h1>{t('notfound.title')}</h1>
      <p>
        <Link to="/">{t('notfound.home')}</Link>
      </p>
    </section>
  );
}

function Shell() {
  const { t, lang, setLang } = useI18n();
  const me = useMe();
  const navigate = useNavigate();
  const path = usePath();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the page on navigation so keyboard and screen-reader users start at the top.
  useEffect(() => {
    if (first.current) first.current = false;
    else main.current?.focus({ preventScroll: true });
  }, [path]);

  const logout = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    clearQueries();
    setQueryData(['me'], null);
    navigate('/masuk');
  };

  return (
    <>
      <a className="skip" href="#main">
        {t('nav.skip')}
      </a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label={t('nav.home')}>
          <span className="brand__mark" aria-hidden="true">
            §
          </span>
          Paper Trail
        </Link>
        <nav className="topbar__nav" aria-label={t('nav.label')}>
          <Link to="/tentang">{t('nav.about')}</Link>
          <button
            type="button"
            className="linklike"
            lang={lang === 'id' ? 'en' : 'id'}
            onClick={() => setLang(lang === 'id' ? 'en' : 'id')}
          >
            {lang === 'id' ? 'EN' : 'ID'}
          </button>
          {me.data && (
            <button type="button" className="linklike" onClick={() => void logout()}>
              {t('nav.logout')}
            </button>
          )}
        </nav>
      </header>
      <main id="main" tabIndex={-1} ref={main} className="page">
        <Routes routes={routes} fallback={<NotFound />} />
      </main>
      <footer className="footer">
        <p>{t('legal.disclaimer')}</p>
        <p>
          <Link to="/tentang">{t('nav.about')}</Link> · <a href="/verify">{t('nav.verify')}</a> ·{' '}
          <span>© 2026 Vassel Goleyu</span>
        </p>
      </footer>
    </>
  );
}

/** A render bug must not leave a blank screen: say so, and keep the way out (reload) in reach. */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="page">
        <h1>Paper Trail</h1>
        <p role="alert">
          Terjadi kesalahan pada tampilan. Catatan Anda aman di server. Muat ulang halaman. /
          Something went wrong in the display. Your records are safe on the server. Reload the page.
        </p>
        <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
          Muat ulang / Reload
        </button>
      </main>
    );
  }
}

export default function OwnerApp() {
  return (
    <Boundary>
      <I18nProvider>
        <Router>
          <Shell />
        </Router>
      </I18nProvider>
    </Boundary>
  );
}
