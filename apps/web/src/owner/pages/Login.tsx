// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState } from 'react';
import { api, type User } from '../lib/api';
import { useForm } from '../lib/form';
import { useI18n } from '../lib/i18n';
import { clearQueries, setQueryData, useAction } from '../lib/query';
import { Link, useNavigate } from '../lib/router';
import { credentialsSchema } from '../lib/schemas';
import { useMe } from '../lib/session';
import { Field, Loading } from '../ui';

export function LoginPage() {
  const { t, errorText } = useI18n();
  const navigate = useNavigate();
  const me = useMe();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const schema = useMemo(() => credentialsSchema(t, mode), [t, mode]);
  const form = useForm(schema, { email: '', password: '' });

  const loggedIn = !!me.data;
  useEffect(() => {
    if (loggedIn) navigate('/', { replace: true });
  }, [loggedIn, navigate]);

  const submit = useAction(async (body: { email: string; password: string }) => {
    const res = await api.post<{ user: User }>(`/auth/${mode}`, body);
    clearQueries();
    setQueryData(['me'], res.user);
    navigate('/');
  });

  if (me.loading || loggedIn) return <Loading />;

  return (
    <section className="auth">
      <h1>{t('auth.title')}</h1>
      <p className="lede">{t('auth.lede')}</p>

      <div className="segmented" role="group" aria-label={t('auth.modeLabel')}>
        {(['login', 'register'] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => {
              setMode(m);
              submit.reset();
            }}
          >
            {t(m === 'login' ? 'auth.tabLogin' : 'auth.tabRegister')}
          </button>
        ))}
      </div>

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
        <Field
          form={form}
          name="password"
          label={t('auth.password')}
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          {...(mode === 'register' ? { hint: t('auth.passwordHint') } : {})}
        />
        {submit.error != null && (
          <p className="form__error" role="alert">
            {errorText(submit.error)}
          </p>
        )}
        <button type="submit" className="btn btn--primary btn--block" disabled={submit.pending}>
          {submit.pending
            ? t('state.sending')
            : t(mode === 'login' ? 'auth.submitLogin' : 'auth.submitRegister')}
        </button>
      </form>

      {mode === 'login' && (
        <p className="note">
          <Link to="/lupa-sandi">{t('recover.forgot')}</Link>
        </p>
      )}
      <p className="note">{t('auth.honest')}</p>
    </section>
  );
}
