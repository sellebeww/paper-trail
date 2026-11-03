// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Pages reached from an emailed link or from the login page: forgot password, choose a new password, verify email.
// The one-time token travels in the URL fragment, which browsers never send to a server; it is read once and then
// removed from the address bar so it does not linger in history or screenshots.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useForm } from '../lib/form';
import { useI18n } from '../lib/i18n';
import { clearQueries, invalidate, setQueryData, useAction } from '../lib/query';
import { Link } from '../lib/router';
import { emailSchema, newPasswordSchema } from '../lib/schemas';
import { Field } from '../ui';

// Kept in memory once taken: React StrictMode (development) runs state initializers twice, and the second run
// would otherwise find the fragment already gone.
let taken = '';
const takeFragmentToken = (): string => {
  const fromUrl = window.location.hash.slice(1);
  if (fromUrl) {
    taken = fromUrl;
    window.history.replaceState(null, '', window.location.pathname);
  }
  return taken;
};
/** Called once a token has been spent, so a later visit to the page does not reuse it. */
const forgetToken = () => {
  taken = '';
};

export function ForgotPasswordPage() {
  const { t, errorText } = useI18n();
  const schema = useMemo(() => emailSchema(t), [t]);
  const form = useForm(schema, { email: '' });
  const [sent, setSent] = useState(false);
  const submit = useAction(async (body: { email: string }) => {
    await api.post('/auth/password-reset/request', body);
    setSent(true);
  });

  return (
    <section className="auth">
      <h1>{t('recover.forgotTitle')}</h1>
      {sent ? (
        <div className="card" role="status">
          <p>{t('recover.forgotSent')}</p>
        </div>
      ) : (
        <>
          <p className="lede">{t('recover.forgotLede')}</p>
          <form
            className="card form"
            onSubmit={form.handleSubmit((v) => void submit.run(v))}
            noValidate
          >
            <Field
              form={form}
              name="email"
              label={t('auth.email')}
              type="email"
              autoComplete="email"
              inputMode="email"
            />
            {submit.error != null && (
              <p className="form__error" role="alert">
                {errorText(submit.error)}
              </p>
            )}
            <button type="submit" className="btn btn--primary btn--block" disabled={submit.pending}>
              {submit.pending ? t('state.sending') : t('recover.forgotSubmit')}
            </button>
          </form>
        </>
      )}
      <p className="note">
        <Link to="/masuk">{t('recover.backToLogin')}</Link>
      </p>
    </section>
  );
}

export function ResetPasswordPage() {
  const { t, errorText } = useI18n();
  const [token] = useState(takeFragmentToken);
  const schema = useMemo(() => newPasswordSchema(t), [t]);
  const form = useForm(schema, { password: '' });
  const [done, setDone] = useState(false);
  const submit = useAction(async (body: { password: string }) => {
    await api.post('/auth/password-reset', { token, password: body.password });
    forgetToken();
    clearQueries();
    setQueryData(['me'], null); // every session was signed out
    setDone(true);
  });

  return (
    <section className="auth">
      <h1>{t('recover.resetTitle')}</h1>
      {done ? (
        <div className="card" role="status">
          <p>{t('recover.resetDone')}</p>
          <p>
            <Link to="/masuk" className="btn btn--primary">
              {t('recover.toLogin')}
            </Link>
          </p>
        </div>
      ) : !token ? (
        <div className="card" role="alert">
          <p>{t('recover.noToken')}</p>
          <p>
            <Link to="/lupa-sandi">{t('recover.askAgain')}</Link>
          </p>
        </div>
      ) : (
        <form
          className="card form"
          onSubmit={form.handleSubmit((v) => void submit.run(v))}
          noValidate
        >
          <p className="lede">{t('recover.resetLede')}</p>
          <Field
            form={form}
            name="password"
            label={t('recover.newPassword')}
            type="password"
            autoComplete="new-password"
            hint={t('auth.passwordHint')}
          />
          {submit.error != null && (
            <>
              <p className="form__error" role="alert">
                {errorText(submit.error)}
              </p>
              <p>
                <Link to="/lupa-sandi">{t('recover.askAgain')}</Link>
              </p>
            </>
          )}
          <button type="submit" className="btn btn--primary btn--block" disabled={submit.pending}>
            {submit.pending ? t('state.sending') : t('recover.resetSubmit')}
          </button>
        </form>
      )}
    </section>
  );
}

export function VerifyEmailPage() {
  const { t, errorText } = useI18n();
  const [token] = useState(takeFragmentToken);
  const [status, setStatus] = useState<'working' | 'ok' | 'failed'>(token ? 'working' : 'failed');
  const [error, setError] = useState<unknown>();
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return; // StrictMode runs effects twice; the token works once
    started.current = true;
    api.post('/auth/verify-email', { token }).then(
      () => {
        forgetToken();
        invalidate(['me']); // the "verify your email" banner should go away
        setStatus('ok');
      },
      (e: unknown) => {
        setError(e);
        setStatus('failed');
      },
    );
  }, [token]);

  return (
    <section className="auth">
      <h1>{t('recover.verifyTitle')}</h1>
      <div className="card" role={status === 'failed' ? 'alert' : 'status'}>
        {status === 'working' && <p>{t('state.loading')}</p>}
        {status === 'ok' && <p>{t('recover.verifyDone')}</p>}
        {status === 'failed' && <p>{error ? errorText(error) : t('recover.noToken')}</p>}
        <p>
          <Link to="/">{t('recover.toApp')}</Link>
        </p>
      </div>
    </section>
  );
}
