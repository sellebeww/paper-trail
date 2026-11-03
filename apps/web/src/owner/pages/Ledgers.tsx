// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from 'react';
import { api, CATEGORIES, type LedgerDetail, type LedgerRow } from '../lib/api';
import { formatTime } from '../lib/format';
import { useForm } from '../lib/form';
import { useI18n } from '../lib/i18n';
import { invalidate, useAction, useQuery } from '../lib/query';
import { Link, useNavigate } from '../lib/router';
import { ledgerSchema } from '../lib/schemas';
import { Empty, ErrorBox, Field, Icon, Loading } from '../ui';

/** One line that answers "is this ledger's latest state backed by an external time proof?" */
export function AnchorLine({ detail }: { detail: LedgerDetail }) {
  const { t, lang } = useI18n();
  const { last_anchor: last, last_confirmed_anchor: ok, unanchored_entries: tail } = detail;
  if (ok) {
    return (
      <span className="anchorline">
        {t('anchor.lastAt', { time: formatTime(ok.gen_time ?? ok.updated_at, lang) })}
        {tail > 0 && <span className="anchorline__tail"> · {t('anchor.tail', { n: tail })}</span>}
      </span>
    );
  }
  if (detail.ledger.head_seq === null)
    return <span className="anchorline">{t('anchor.empty')}</span>;
  if (last?.status === 'pending')
    return <span className="anchorline">{t('anchor.inProgress')}</span>;
  if (last?.status === 'failed') return <span className="anchorline">{t('anchor.failed')}</span>;
  return <span className="anchorline">{t('anchor.never')}</span>;
}

function LedgerCard({ ledger }: { ledger: LedgerRow }) {
  const { t } = useI18n();
  // Same key as the ledger page, so opening a card is instant.
  const detail = useQuery(['ledger', ledger.id], () =>
    api.get<LedgerDetail>(`/ledgers/${ledger.id}`),
  );
  const count = ledger.head_seq === null ? 0 : ledger.head_seq + 1;
  return (
    <li className="card ledgercard">
      <Link to={`/ledger/${ledger.id}`} className="ledgercard__link">
        <h2>{ledger.title}</h2>
        <p className="ledgercard__meta">
          <span className="chip">{t(`category.${ledger.category}`)}</span>
          <span>{t('ledgers.entries', { n: count })}</span>
        </p>
        <p className="ledgercard__anchor">
          <Icon name={detail.data?.last_confirmed_anchor ? 'seal' : 'clock'} size={16} />
          {detail.data ? (
            <AnchorLine detail={detail.data} />
          ) : detail.error ? (
            <span>{t('ledgers.anchorUnknown')}</span>
          ) : (
            <span className="skeleton" aria-label={t('state.loading')} />
          )}
        </p>
      </Link>
    </li>
  );
}

function NewLedger({ onDone }: { onDone: () => void }) {
  const { t, errorText } = useI18n();
  const navigate = useNavigate();
  const schema = useMemo(() => ledgerSchema(t), [t]);
  const form = useForm(schema, { title: '', category: 'kerja' });
  const create = useAction(async (body: { title: string; category: string }) => {
    const res = await api.post<{ ledger: LedgerRow }>('/ledgers', body);
    invalidate(['ledgers']);
    navigate(`/ledger/${res.ledger.id}`);
  });
  return (
    <form className="card form" onSubmit={form.handleSubmit((v) => void create.run(v))} noValidate>
      <Field form={form} name="title" label={t('ledgers.titleLabel')} maxLength={120} />
      <Field form={form} name="category" label={t('ledgers.categoryLabel')} as="select">
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {t(`category.${c}`)}
          </option>
        ))}
      </Field>
      {create.error != null && (
        <p className="form__error" role="alert">
          {errorText(create.error)}
        </p>
      )}
      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={create.pending}>
          {create.pending ? t('state.sending') : t('ledgers.create')}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

export function LedgersPage() {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const list = useQuery(
    ['ledgers'],
    async () => (await api.get<{ ledgers: LedgerRow[] }>('/ledgers')).ledgers,
  );

  return (
    <section>
      <div className="pagehead">
        <h1>{t('ledgers.title')}</h1>
        {!creating && (
          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={18} />
            {t('ledgers.new')}
          </button>
        )}
      </div>

      {creating && <NewLedger onDone={() => setCreating(false)} />}

      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={list.refetch} />
      ) : list.data && list.data.length === 0 ? (
        !creating && (
          <Empty
            title={t('ledgers.emptyTitle')}
            body={t('ledgers.emptyBody')}
            action={
              <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
                {t('ledgers.new')}
              </button>
            }
          />
        )
      ) : (
        <ul className="stack" aria-label={t('ledgers.title')}>
          {list.data?.map((l) => (
            <LedgerCard key={l.id} ledger={l} />
          ))}
        </ul>
      )}
    </section>
  );
}
