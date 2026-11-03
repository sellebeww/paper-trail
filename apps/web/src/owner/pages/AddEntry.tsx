// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiEntry, type Head, type LedgerDetail } from '../lib/api';
import { formatBytes, formatTime, hash8, saveHead } from '../lib/format';
import { useForm } from '../lib/form';
import { useI18n } from '../lib/i18n';
import { clearPending, peekPending, setPending, type PendingKind } from '../lib/pending';
import { invalidate, useAction, useQuery } from '../lib/query';
import { Link } from '../lib/router';
import { captionSchema, noteSchema } from '../lib/schemas';
import { BackLink, CopyButton, Field, Icon } from '../ui';

const MAX_UPLOAD = 15 * 1024 * 1024; // the API's default UPLOAD_MAX_BYTES; the server remains the authority

type Appended = { entry: ApiEntry; head: Head };

function Receipt({
  ledgerId,
  title,
  result,
  onAnother,
}: {
  ledgerId: string;
  title: string | undefined;
  result: Appended;
  onAnother: () => void;
}) {
  const { t, lang } = useI18n();
  const { entry, head } = result;
  const text = [
    t('receipt.heading'),
    title ? `${t('receipt.ledger')}: ${title}` : null,
    `${t('receipt.entry')}: № ${entry.seq + 1} (${t(`type.${entry.type}`)})`,
    `${t('receipt.time')}: ${formatTime(entry.created_at, lang)}`,
    `${t('receipt.entryCode')}: ${entry.entry_hash}`,
    `${t('receipt.head')}: ${head.head_hash ?? ''} (№ ${(head.head_seq ?? 0) + 1})`,
    t('receipt.footer'),
  ]
    .filter(Boolean)
    .join('\n');
  const canShare = typeof navigator.share === 'function';

  return (
    <section className="receipt" data-testid="receipt">
      <div className="receipt__stamp" aria-hidden="true">
        <Icon name="seal" size={28} />
      </div>
      <h1>{t('receipt.title')}</h1>
      <p className="lede">{t('receipt.lede', { n: entry.seq + 1 })}</p>

      <dl className="card receipt__card">
        <div>
          <dt>{t('receipt.entryCode')}</dt>
          <dd>
            <strong
              className="receipt__code"
              data-testid="receipt-entry-hash"
              data-hash={entry.entry_hash}
            >
              {hash8(entry.entry_hash)}
            </strong>
          </dd>
        </div>
        <div>
          <dt>{t('receipt.head')}</dt>
          <dd>
            <strong
              className="receipt__code"
              data-testid="receipt-head-hash"
              data-hash={head.head_hash ?? ''}
            >
              {hash8(head.head_hash)}
            </strong>
          </dd>
        </div>
        <div>
          <dt>{t('receipt.time')}</dt>
          <dd>{formatTime(entry.created_at, lang)}</dd>
        </div>
        <div className="receipt__full">
          <dt>{t('receipt.full')}</dt>
          <dd>
            <code>{entry.entry_hash}</code>
            <code>{head.head_hash}</code>
          </dd>
        </div>
      </dl>

      <p className="note">{t('receipt.keep')}</p>
      <div className="row">
        <CopyButton text={text} label={t('receipt.copy')} className="btn btn--primary" />
        {canShare && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() =>
              void navigator.share({ title: t('receipt.heading'), text }).catch(() => undefined)
            }
          >
            <Icon name="share" size={18} />
            {t('receipt.share')}
          </button>
        )}
      </div>
      <p className="note">{t('receipt.screenshot')}</p>

      <div className="row row--end">
        <Link to={`/ledger/${ledgerId}`} className="btn btn--ghost">
          {t('receipt.back')}
        </Link>
        <button type="button" className="btn btn--ghost" onClick={onAnother}>
          {t('receipt.another')}
        </button>
      </div>
    </section>
  );
}

export function AddEntryPage({ ledgerId, kind }: { ledgerId: string; kind: string }) {
  const { t, errorText } = useI18n();
  const valid = kind === 'teks' || kind === 'foto' || kind === 'berkas';
  const detail = useQuery(['ledger', ledgerId], () =>
    api.get<LedgerDetail>(`/ledgers/${ledgerId}`),
  );
  const [result, setResult] = useState<Appended | null>(null);
  const [file, setFile] = useState<File | null>(() =>
    kind === 'foto' || kind === 'berkas' ? peekPending(kind) : null,
  );
  const [fileError, setFileError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const noteForm = useForm(
    useMemo(() => noteSchema(t), [t]),
    { text: '' },
  );
  const captionForm = useForm(
    useMemo(() => captionSchema(t), [t]),
    { caption: '' },
  );

  const preview = useMemo(
    () => (kind === 'foto' && file ? URL.createObjectURL(file) : null),
    [kind, file],
  );
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  useEffect(() => clearPending, []);

  const done = (res: Appended) => {
    clearPending();
    saveHead(ledgerId, { seq: res.entry.seq, hash: res.entry.entry_hash });
    invalidate(['ledger', ledgerId]);
    invalidate(['entries', ledgerId]);
    invalidate(['ledgers']);
    setResult(res);
  };

  const submit = useAction(async (body: { text: string } | { caption: string }) => {
    if ('text' in body) {
      done(
        await api.post<Appended>(`/ledgers/${ledgerId}/entries`, { type: 'note', text: body.text }),
      );
      return;
    }
    if (!file) return;
    const data = new FormData();
    data.append('type', kind === 'foto' ? 'photo' : 'file'); // must precede the file part
    if (kind === 'foto' && body.caption.trim()) data.append('caption', body.caption);
    data.append('file', file, file.name);
    done(await api.post<Appended>(`/ledgers/${ledgerId}/entries/upload`, data));
  });

  const reset = () => {
    setResult(null);
    setFile(null);
    noteForm.set('text', '');
    captionForm.set('caption', '');
    submit.reset();
  };

  if (!valid)
    return (
      <section>
        <BackLink to={`/ledger/${ledgerId}`}>{t('common.back')}</BackLink>
        <p>{t('notfound.title')}</p>
      </section>
    );

  if (result)
    return (
      <Receipt
        ledgerId={ledgerId}
        title={detail.data?.ledger.title}
        result={result}
        onAnother={reset}
      />
    );

  const choose = (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > MAX_UPLOAD) {
      setFileError(t('add.tooLarge', { max: formatBytes(MAX_UPLOAD) }));
      return;
    }
    setFileError(null);
    setPending(kind as PendingKind, picked);
    setFile(picked);
  };

  return (
    <section>
      <BackLink to={`/ledger/${ledgerId}`}>
        {detail.data?.ledger.title ?? t('common.back')}
      </BackLink>
      <h1>
        {t(
          kind === 'teks' ? 'add.titleText' : kind === 'foto' ? 'add.titlePhoto' : 'add.titleFile',
        )}
      </h1>

      {kind === 'teks' ? (
        <form
          className="card form"
          onSubmit={noteForm.handleSubmit((v) => void submit.run(v))}
          noValidate
        >
          <Field
            form={noteForm}
            name="text"
            label={t('add.textLabel')}
            as="textarea"
            rows={8}
            hint={t('add.textHint')}
          />
          <p className="note note--permanent">{t('add.permanent')}</p>
          {submit.error != null && (
            <p className="form__error" role="alert">
              {errorText(submit.error)}
            </p>
          )}
          <button type="submit" className="btn btn--primary btn--block" disabled={submit.pending}>
            {submit.pending ? t('state.sending') : t('add.submit')}
          </button>
        </form>
      ) : (
        <form
          className="card form"
          onSubmit={captionForm.handleSubmit((v) => void submit.run(v))}
          noValidate
        >
          <input
            ref={picker}
            type="file"
            className="visually-hidden"
            data-kind={kind}
            aria-label={t(kind === 'foto' ? 'add.pickPhoto' : 'add.pickFile')}
            {...(kind === 'foto'
              ? {
                  accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif',
                  capture: 'environment' as const,
                }
              : { accept: '.pdf,.docx,.xlsx,.mp3,.m4a,.ogg,.opus,application/pdf' })}
            onChange={(e) => {
              choose(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {file ? (
            <>
              {preview ? (
                <img className="preview" src={preview} alt={t('add.previewAlt')} />
              ) : (
                <p className="filecard">
                  <Icon name="file" size={24} />
                  <span>
                    {file.name} <span className="entry__meta">({formatBytes(file.size)})</span>
                  </span>
                </p>
              )}
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => picker.current?.click()}
              >
                {t('add.change')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--block btn--tall"
              onClick={() => picker.current?.click()}
            >
              <Icon name={kind === 'foto' ? 'camera' : 'file'} size={24} />
              {t(kind === 'foto' ? 'add.pickPhoto' : 'add.pickFile')}
            </button>
          )}
          {fileError && (
            <p className="form__error" role="alert">
              {fileError}
            </p>
          )}
          {kind === 'foto' && file && (
            <Field
              form={captionForm}
              name="caption"
              label={t('add.caption')}
              as="textarea"
              rows={3}
              hint={t('add.captionHint')}
            />
          )}
          {kind === 'foto' && <p className="note">{t('add.exif')}</p>}
          <p className="note note--permanent">{t('add.permanent')}</p>
          {submit.error != null && (
            <p className="form__error" role="alert">
              {errorText(submit.error)}
            </p>
          )}
          <button
            type="submit"
            className="btn btn--primary btn--block"
            disabled={submit.pending || !file}
          >
            {submit.pending ? t('state.uploading') : t('add.submit')}
          </button>
        </form>
      )}
    </section>
  );
}
