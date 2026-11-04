// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// The two irreversible actions: erase a ledger's content, erase the whole account. Both ask for the password again
// and for the thing being destroyed to be typed out, so a stolen session or a stray tap cannot do it.
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { api } from '../lib/api';
import { useForm } from '../lib/form';
import { useI18n } from '../lib/i18n';
import { clearQueries, invalidate, setQueryData, useAction } from '../lib/query';
import { useNavigate } from '../lib/router';
import { useMe } from '../lib/session';
import { Field, Loading } from '../ui';

const erasureSchema = (
  t: ReturnType<typeof useI18n>['t'],
  key: 'confirm_title' | 'confirm_email',
) =>
  z.object({
    [key]: z.string().trim().min(1, t('form.required')),
    password: z.string().min(1, t('form.required')),
  });

/** A collapsed section at the bottom of a ledger: nothing destructive is one tap away. */
export function EraseLedgerPanel({ ledgerId, title }: { ledgerId: string; title: string }) {
  const { t, errorText } = useI18n();
  const schema = useMemo(() => erasureSchema(t, 'confirm_title'), [t]);
  const form = useForm(schema, { confirm_title: '', password: '' });
  const [done, setDone] = useState<number | null>(null);
  const erase = useAction(async (body: Record<string, string>) => {
    const res = await api.post<{ erased_entries: number }>(`/ledgers/${ledgerId}/erase`, body);
    setDone(res.erased_entries);
    invalidate(['ledger', ledgerId]);
    invalidate(['entries', ledgerId]);
    invalidate(['ledgers']);
  });

  return (
    <details className="danger">
      <summary>{t('erase.summary')}</summary>
      {done !== null ? (
        <p role="status">{t('erase.done', { n: done })}</p>
      ) : (
        <form
          className="form"
          onSubmit={form.handleSubmit((v) => void erase.run(v as Record<string, string>))}
          noValidate
        >
          <p className="note note--permanent">{t('erase.warning')}</p>
          <Field
            form={form}
            name="confirm_title"
            label={t('erase.typeTitle', { title })}
            autoComplete="off"
          />
          <Field
            form={form}
            name="password"
            label={t('auth.password')}
            type="password"
            autoComplete="current-password"
          />
          {erase.error != null && (
            <p className="form__error" role="alert">
              {errorText(erase.error)}
            </p>
          )}
          <button type="submit" className="btn btn--danger" disabled={erase.pending}>
            {erase.pending ? t('state.sending') : t('erase.submit')}
          </button>
        </form>
      )}
    </details>
  );
}

export function AccountPage() {
  const { t, errorText } = useI18n();
  const me = useMe();
  const navigate = useNavigate();
  const schema = useMemo(() => erasureSchema(t, 'confirm_email'), [t]);
  const form = useForm(schema, { confirm_email: '', password: '' });
  const [done, setDone] = useState(false);
  const erase = useAction(async (body: Record<string, string>) => {
    await api.post('/account/erase', body);
    clearQueries();
    setQueryData(['me'], null);
    setDone(true);
  });

  if (me.loading) return <Loading />;
  if (!me.data && !done) {
    navigate('/masuk', { replace: true });
    return null;
  }
  return (
    <section className="auth">
      <h1>{t('account.title')}</h1>
      {done ? (
        <div className="card" role="status">
          <p>{t('account.erased')}</p>
        </div>
      ) : (
        <>
          <dl className="card">
            <dt>{t('auth.email')}</dt>
            <dd>
              {me.data!.email}{' '}
              <span className="chip">
                {t(me.data!.email_verified ? 'account.verified' : 'account.unverified')}
              </span>
            </dd>
          </dl>
          <form
            className="card form"
            onSubmit={form.handleSubmit((v) => void erase.run(v as Record<string, string>))}
            noValidate
          >
            <h2>{t('account.eraseTitle')}</h2>
            <p className="note note--permanent">{t('account.eraseWarning')}</p>
            <Field
              form={form}
              name="confirm_email"
              label={t('account.typeEmail')}
              type="email"
              autoComplete="off"
            />
            <Field
              form={form}
              name="password"
              label={t('auth.password')}
              type="password"
              autoComplete="current-password"
            />
            {erase.error != null && (
              <p className="form__error" role="alert">
                {errorText(erase.error)}
              </p>
            )}
            <button type="submit" className="btn btn--danger" disabled={erase.pending}>
              {erase.pending ? t('state.sending') : t('account.eraseSubmit')}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
