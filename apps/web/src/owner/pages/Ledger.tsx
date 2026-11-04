// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { api, fetchAllEntries, type ApiEntry, type LedgerDetail } from '../lib/api';
import {
  checkSavedHead,
  formatBytes,
  formatTime,
  isAnchored,
  loadHead,
  payloadAs,
  saveHead,
  shorten,
  witnessMarks,
  type WitnessMark,
} from '../lib/format';
import { useI18n } from '../lib/i18n';
import { setPending, type PendingKind } from '../lib/pending';
import { useQuery } from '../lib/query';
import { Link, useNavigate } from '../lib/router';
import { AnchorStamp, BackLink, Empty, ErrorBox, HashChip, Icon, Loading } from '../ui';
import { EraseLedgerPanel } from './Erase';
import { AnchorLine } from './Ledgers';

function EntryItem({
  entry,
  ledgerId,
  anchored,
  marks,
}: {
  entry: ApiEntry;
  ledgerId: string;
  anchored: boolean;
  marks: WitnessMark[];
}) {
  const { t, lang } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [showPhoto, setShowPhoto] = useState(false);

  const summary = () => {
    if (entry.erased_at)
      return (
        <p className="entry__text entry__text--erased">
          {t('entry.erased', { date: formatTime(entry.erased_at, lang) })}
        </p>
      );
    switch (entry.type) {
      case 'note': {
        const text = payloadAs.note(entry).text;
        const long = Array.from(text).length > 220;
        return (
          <>
            <p className="entry__text">{expanded || !long ? text : shorten(text, 220)}</p>
            {long && (
              <button type="button" className="linklike" onClick={() => setExpanded((x) => !x)}>
                {expanded ? t('entry.less') : t('entry.more')}
              </button>
            )}
          </>
        );
      }
      case 'photo': {
        const p = payloadAs.photo(entry);
        return (
          <>
            {p.caption && <p className="entry__text">{p.caption}</p>}
            <p className="entry__meta">{formatBytes(p.size)}</p>
            <button type="button" className="linklike" onClick={() => setShowPhoto((x) => !x)}>
              {showPhoto ? t('entry.hidePhoto') : t('entry.showPhoto')}
            </button>
            {showPhoto && (
              <img
                className="entry__photo"
                src={api.attachmentUrl(entry.id)}
                alt={t('entry.photoAlt', { n: entry.seq + 1 })}
                loading="lazy"
              />
            )}
          </>
        );
      }
      case 'file': {
        const p = payloadAs.file(entry);
        return (
          <p className="entry__text">
            <a href={api.attachmentUrl(entry.id)} download>
              {p.name}
            </a>{' '}
            <span className="entry__meta">({formatBytes(p.size)})</span>
          </p>
        );
      }
      case 'witness_cosign': {
        const p = payloadAs.cosign(entry);
        return (
          <p className="entry__text">
            {t('entry.cosign', { name: p.witness_name, n: p.target_seq + 1 })}
          </p>
        );
      }
    }
  };

  const typeIcon =
    entry.type === 'note'
      ? 'note'
      : entry.type === 'photo'
        ? 'camera'
        : entry.type === 'file'
          ? 'file'
          : 'eye';

  return (
    <li className="entry" id={`entry-${entry.seq}`} data-seq={entry.seq}>
      <span className="entry__no" aria-hidden="true">
        {entry.seq + 1}
      </span>
      <article className="entry__card card" aria-label={t('entry.aria', { n: entry.seq + 1 })}>
        <header className="entry__head">
          <span className="entry__type">
            <Icon name={typeIcon} size={16} />
            {t(`type.${entry.type}`)} <span className="visually-hidden">№ {entry.seq + 1}</span>
          </span>
          <time dateTime={entry.created_at} title={t('entry.serverTime')}>
            {formatTime(entry.created_at, lang)}
          </time>
        </header>
        {summary()}
        <footer className="entry__foot">
          <AnchorStamp anchored={anchored} />
          {marks.map((m) => (
            <span className="badge badge--witness" key={m.cosignSeq}>
              <Icon name="eye" size={14} />
              {t('witness.by', { name: m.name })}
            </span>
          ))}
          <HashChip hash={entry.entry_hash} />
          {entry.type !== 'witness_cosign' && (
            <Link to={`/ledger/${ledgerId}/saksi/${entry.seq}`} className="entry__action">
              {t('entry.invite')}
            </Link>
          )}
        </footer>
      </article>
    </li>
  );
}

function ActionBar({ ledgerId }: { ledgerId: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const pick = (kind: PendingKind) => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setPending(kind, file);
    navigate(`/ledger/${ledgerId}/tambah/${kind}`);
  };
  return (
    <nav className="actionbar" aria-label={t('add.title')}>
      <Link to={`/ledger/${ledgerId}/tambah/teks`} className="action">
        <Icon name="note" size={26} />
        <span>{t('add.text')}</span>
      </Link>
      <label className="action">
        <Icon name="camera" size={26} />
        <span>{t('add.photo')}</span>
        <input
          type="file"
          className="visually-hidden"
          data-kind="foto"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          capture="environment"
          onChange={pick('foto')}
        />
      </label>
      <label className="action">
        <Icon name="file" size={26} />
        <span>{t('add.file')}</span>
        <input
          type="file"
          className="visually-hidden"
          data-kind="berkas"
          accept=".pdf,.docx,.xlsx,.mp3,.m4a,.ogg,.opus,application/pdf"
          onChange={pick('berkas')}
        />
      </label>
    </nav>
  );
}

export function LedgerPage({ ledgerId }: { ledgerId: string }) {
  const { t, lang } = useI18n();
  const detail = useQuery(
    ['ledger', ledgerId],
    () => api.get<LedgerDetail>(`/ledgers/${ledgerId}`),
    {
      pollMs: 15_000,
    },
  );
  const entries = useQuery(['entries', ledgerId], () => fetchAllEntries(ledgerId));

  // New entries made elsewhere (or a witness co-signing) show up through the polled head.
  const headSeq = detail.data?.ledger.head_seq ?? null;
  const loadedHead = entries.data?.at(-1)?.seq ?? null;
  const refetchEntries = entries.refetch;
  useEffect(() => {
    if (headSeq !== null && loadedHead !== null && headSeq !== loadedHead) refetchEntries();
  }, [headSeq, loadedHead, refetchEntries]);

  const newestFirst = useMemo(() => entries.data?.toReversed() ?? [], [entries.data]);
  const marks = useMemo(() => witnessMarks(entries.data ?? []), [entries.data]);

  // "Last head I saw" is kept in this browser: if the server's chain no longer contains it, say so loudly.
  const headCheck = useMemo(
    () => (entries.data ? checkSavedHead(loadHead(ledgerId), entries.data) : 'none'),
    [entries.data, ledgerId],
  );
  useEffect(() => {
    const last = entries.data?.at(-1);
    if (last && (headCheck === 'ok' || headCheck === 'none'))
      saveHead(ledgerId, { seq: last.seq, hash: last.entry_hash });
  }, [entries.data, headCheck, ledgerId]);

  if (detail.loading) return <Loading />;
  if (detail.error || !detail.data)
    return <ErrorBox error={detail.error} onRetry={detail.refetch} />;

  const { ledger, last_confirmed_anchor: confirmed } = detail.data;
  const refresh = () => {
    detail.refetch();
    entries.refetch();
  };

  return (
    <section className="ledgerpage">
      <BackLink to="/">{t('ledgers.title')}</BackLink>

      <header className="trustbar card" aria-label={t('trust.label')}>
        <div className="trustbar__title">
          <h1>{ledger.title}</h1>
          <span className="chip">{t(`category.${ledger.category}`)}</span>
        </div>
        <dl className="trustbar__facts">
          <div>
            <dt>{t('trust.head')}</dt>
            <dd data-testid="head-hash">
              <HashChip hash={ledger.head_hash} />
              {ledger.head_seq !== null && (
                <span className="trustbar__seq">
                  {' '}
                  · {t('trust.headSeq', { n: ledger.head_seq + 1 })}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>{t('trust.anchor')}</dt>
            <dd data-testid="anchor-line">
              <AnchorLine detail={detail.data} />
            </dd>
          </div>
        </dl>
        <div className="row">
          <Link to={`/ledger/${ledger.id}/ekspor`} className="btn btn--ghost">
            <Icon name="download" size={18} />
            {t('export.title')}
          </Link>
          <button type="button" className="btn btn--ghost" onClick={refresh}>
            <Icon name="refresh" size={18} />
            {t('state.refresh')}
          </button>
        </div>
      </header>

      {(headCheck === 'shorter' || headCheck === 'mismatch') && (
        <div className="state state--error" role="alert">
          <Icon name="alert" />
          <p>{t(headCheck === 'shorter' ? 'trust.headShorter' : 'trust.headMismatch')}</p>
        </div>
      )}

      <div className="pagehead pagehead--sub">
        <h2>
          {t('timeline.title')}
          {entries.data ? ` (${entries.data.length})` : ''}
        </h2>
        <span className="note">{t('timeline.order')}</span>
      </div>
      <details className="legend">
        <summary>{t('timeline.legendTitle')}</summary>
        <p>
          <strong>{t('anchor.anchored')}:</strong> {t('timeline.legendAnchored')}
        </p>
        <p>
          <strong>{t('anchor.waiting')}:</strong> {t('timeline.legendWaiting')}
        </p>
        <p>
          {t('timeline.legendTime', { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
        </p>
      </details>

      {entries.loading ? (
        <Loading />
      ) : entries.error ? (
        <ErrorBox error={entries.error} onRetry={entries.refetch} />
      ) : newestFirst.length === 0 ? (
        <Empty title={t('timeline.emptyTitle')} body={t('timeline.emptyBody')} />
      ) : (
        <ol className="timeline" lang={lang}>
          {newestFirst.map((e) => (
            <EntryItem
              key={e.id}
              entry={e}
              ledgerId={ledgerId}
              anchored={isAnchored(e.seq, confirmed)}
              marks={marks.get(e.seq) ?? []}
            />
          ))}
        </ol>
      )}

      <ActionBar ledgerId={ledgerId} />
      <EraseLedgerPanel ledgerId={ledgerId} title={ledger.title} />
    </section>
  );
}
