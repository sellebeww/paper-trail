// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from 'react';
import { api, fetchAllEntries, type ApiEntry, type Invite } from '../lib/api';
import { formatTime, payloadAs, shorten, whatsappUrl } from '../lib/format';
import { useForm } from '../lib/form';
import { useI18n } from '../lib/i18n';
import { invalidate, useAction, useQuery } from '../lib/query';
import { inviteSchema } from '../lib/schemas';
import { BackLink, CopyButton, ErrorBox, Field, Icon, Loading } from '../ui';

const NAME_KEY = 'pt:ownerName';
const rememberedName = () => {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};

type Created = { invite: Invite; token: string; url: string };

function summaryOf(entry: ApiEntry, t: ReturnType<typeof useI18n>['t']) {
  if (entry.type === 'note') return shorten(payloadAs.note(entry).text, 140);
  if (entry.type === 'photo') return payloadAs.photo(entry).caption ?? t('type.photo');
  if (entry.type === 'file') return payloadAs.file(entry).name;
  return t('type.witness_cosign');
}

function InviteRow({
  invite,
  entries,
  onRevoked,
}: {
  invite: Invite;
  entries: ApiEntry[];
  onRevoked: () => void;
}) {
  const { t, lang, errorText } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const revoke = useAction(async () => {
    await api.del(`/witness-invites/${invite.id}`);
    onRevoked();
  });
  const cosign = invite.witness
    ? entries.find((e) => e.id === invite.witness!.cosign_entry_id)
    : undefined;

  return (
    <li className="card invite" data-status={invite.status}>
      <p className="invite__status">
        <span className={`badge badge--${invite.status}`}>{t(`invite.${invite.status}`)}</span>
        {invite.owner_display_name && (
          <span className="entry__meta"> · {invite.owner_display_name}</span>
        )}
      </p>
      {invite.status === 'used' && invite.witness && (
        <p>
          <Icon name="eye" size={16} />{' '}
          {t('invite.usedBy', {
            name: invite.witness.display_name,
            time: formatTime(invite.witness.signed_at, lang),
          })}
          {cosign ? ` ${t('invite.recordedAs', { n: cosign.seq + 1 })}` : ''}
        </p>
      )}
      {invite.status === 'open' && (
        <p className="entry__meta">
          {t('invite.expires', { time: formatTime(invite.expires_at, lang) })}
        </p>
      )}
      {invite.status === 'expired' && (
        <p className="entry__meta">
          {t('invite.expired', { time: formatTime(invite.expires_at, lang) })}
        </p>
      )}
      {invite.status === 'open' &&
        (confirming ? (
          <div className="row">
            <button
              type="button"
              className="btn btn--danger"
              disabled={revoke.pending}
              onClick={() => void revoke.run()}
            >
              {t('invite.revokeConfirm')}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn--ghost" onClick={() => setConfirming(true)}>
            {t('invite.revoke')}
          </button>
        ))}
      {revoke.error != null && (
        <p className="form__error" role="alert">
          {errorText(revoke.error)}
        </p>
      )}
    </li>
  );
}

function LinkCard({ created }: { created: Created }) {
  const { t } = useI18n();
  const message = t('witness.shareText', {
    name: created.invite.owner_display_name ?? '',
    url: created.url,
  });
  const canShare = typeof navigator.share === 'function';
  return (
    <div className="card linkcard" data-testid="invite-created">
      <h2>{t('witness.linkReady')}</h2>
      <label htmlFor="invite-url" className="visually-hidden">
        {t('witness.linkLabel')}
      </label>
      <input
        id="invite-url"
        className="linkcard__url"
        readOnly
        value={created.url}
        onFocus={(e) => e.target.select()}
      />
      <div className="row">
        <CopyButton text={created.url} label={t('witness.copyLink')} className="btn btn--primary" />
        <a className="btn btn--ghost" href={whatsappUrl(message)} target="_blank" rel="noreferrer">
          <Icon name="share" size={18} />
          {t('witness.whatsapp')}
        </a>
        {canShare && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void navigator.share({ text: message }).catch(() => undefined)}
          >
            {t('witness.shareOther')}
          </button>
        )}
      </div>
      <p className="note note--permanent">{t('witness.onlyOnce')}</p>
    </div>
  );
}

export function WitnessPanelPage({ ledgerId, seq }: { ledgerId: string; seq: number }) {
  const { t, errorText } = useI18n();
  const entries = useQuery(['entries', ledgerId], () => fetchAllEntries(ledgerId));
  const entry = entries.data?.find((e) => e.seq === seq);
  const invites = useQuery(
    ['invites', entry?.id],
    async () =>
      (await api.get<{ invites: Invite[] }>(`/entries/${entry!.id}/witness-invites`)).invites,
    { enabled: !!entry, pollMs: 6_000 },
  );
  const [created, setCreated] = useState<Created | null>(null);

  const form = useForm(
    useMemo(() => inviteSchema(t), [t]),
    {
      owner_display_name: rememberedName(),
      expires_in_hours: '72',
    },
  );
  const create = useAction(async (v: { owner_display_name: string; expires_in_hours: number }) => {
    const res = await api.post<Created>(`/entries/${entry!.id}/witness-invites`, v);
    try {
      window.localStorage.setItem(NAME_KEY, v.owner_display_name);
    } catch {
      // convenience only
    }
    setCreated(res);
    invalidate(['invites', entry!.id]);
  });

  const back = <BackLink to={`/ledger/${ledgerId}`}>{t('common.back')}</BackLink>;
  if (entries.loading) return <Loading />;
  if (entries.error) return <ErrorBox error={entries.error} onRetry={entries.refetch} />;
  if (!entry || entry.type === 'witness_cosign')
    return (
      <section>
        {back}
        <p>{t('notfound.title')}</p>
      </section>
    );

  return (
    <section>
      {back}
      <h1>{t('witness.title')}</h1>
      <p className="lede">{t('witness.lede')}</p>

      <blockquote className="card quote">
        <span className="entry__meta">
          {t(`type.${entry.type}`)} № {entry.seq + 1}
        </span>
        <p>{summaryOf(entry, t)}</p>
      </blockquote>

      {created ? (
        <>
          <LinkCard created={created} />
          <button type="button" className="btn btn--ghost" onClick={() => setCreated(null)}>
            {t('witness.createAnother')}
          </button>
        </>
      ) : (
        <form
          className="card form"
          onSubmit={form.handleSubmit((v) => void create.run(v))}
          noValidate
        >
          <Field
            form={form}
            name="owner_display_name"
            label={t('witness.ownerName')}
            hint={t('witness.ownerNameHint')}
            maxLength={80}
            autoComplete="name"
          />
          <Field form={form} name="expires_in_hours" label={t('witness.validFor')} as="select">
            <option value="24">{t('witness.d1')}</option>
            <option value="72">{t('witness.d3')}</option>
            <option value="168">{t('witness.d7')}</option>
            <option value="720">{t('witness.d30')}</option>
          </Field>
          {create.error != null && (
            <p className="form__error" role="alert">
              {errorText(create.error)}
            </p>
          )}
          <button type="submit" className="btn btn--primary btn--block" disabled={create.pending}>
            {create.pending ? t('state.sending') : t('witness.create')}
          </button>
          <p className="note">{t('witness.meaning')}</p>
        </form>
      )}

      <h2>{t('witness.listTitle')}</h2>
      {invites.loading ? (
        <Loading />
      ) : invites.error ? (
        <ErrorBox error={invites.error} onRetry={invites.refetch} />
      ) : invites.data && invites.data.length === 0 ? (
        <p className="note">{t('witness.listEmpty')}</p>
      ) : (
        <ul className="stack">
          {invites.data?.map((i) => (
            <InviteRow
              key={i.id}
              invite={i}
              entries={entries.data ?? []}
              onRevoked={() => invalidate(['invites', entry.id])}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
