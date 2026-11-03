// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { useMemo, useState } from 'react';
import { api, type LedgerDetail } from '../lib/api';
import { fileNameFrom, hash8, saveBlob } from '../lib/format';
import { useForm, type Values } from '../lib/form';
import { useI18n } from '../lib/i18n';
import { useAction, useQuery } from '../lib/query';
import { exportSchema } from '../lib/schemas';
import { BackLink, CopyButton, Empty, ErrorBox, Field, Icon, Loading } from '../ui';

type Selection = {
  range: 'all' | 'seq';
  from: string;
  to: string;
  include_title: 'yes' | 'no';
  payloads: 'all' | 'none';
  include_files: 'yes' | 'no';
};

/** Zero-based seq range for the API from the 1-based numbers people see. */
const range = (s: Selection) => ({
  ...(s.range === 'seq' && s.from ? { from_seq: Number(s.from) - 1 } : {}),
  ...(s.range === 'seq' && s.to ? { to_seq: Number(s.to) - 1 } : {}),
});

type Made = {
  kind: 'pack' | 'pdf';
  name: string;
  packHash: string;
  key: string;
  generatedAt?: string;
};

export function ExportPage({ ledgerId }: { ledgerId: string }) {
  const { t, errorText } = useI18n();
  const detail = useQuery(['ledger', ledgerId], () =>
    api.get<LedgerDetail>(`/ledgers/${ledgerId}`),
  );
  const form = useForm(
    useMemo(() => exportSchema(t), [t]),
    {
      range: 'all',
      from: '',
      to: '',
      include_title: 'yes',
      payloads: 'all',
      include_files: 'no',
    },
  );
  const [pack, setPack] = useState<Made | null>(null);
  const [pdf, setPdf] = useState<Made | null>(null);

  const validate = (): Selection | null => form.validate() as Selection | null;
  const keyOf = (s: Selection) => JSON.stringify(s);

  const makePack = useAction(async () => {
    const s = validate();
    if (!s) return;
    const zip = s.include_files === 'yes';
    const { blob, headers } = await api.download('POST', `/ledgers/${ledgerId}/export`, {
      ...range(s),
      payloads: s.payloads,
      include_title: s.include_title === 'yes',
      include_files: zip,
      format: zip ? 'zip' : 'json',
    });
    const name = fileNameFrom(headers.get('Content-Disposition'), zip ? 'paket.zip' : 'paket.json');
    // The PDF can only reproduce this pack's hash if it reuses the pack's generated_at (API.md, Export).
    const generatedAt = zip
      ? undefined
      : (JSON.parse(await blob.text()) as { generated_at?: string }).generated_at;
    saveBlob(blob, name);
    setPack({
      kind: 'pack',
      name,
      packHash: headers.get('X-Pack-Hash') ?? '',
      key: keyOf(s),
      ...(generatedAt ? { generatedAt } : {}),
    });
  });

  const makePdf = useAction(async () => {
    const s = validate();
    if (!s) return;
    const q = new URLSearchParams({
      ...Object.fromEntries(Object.entries(range(s)).map(([k, v]) => [k, String(v)])),
      payloads: s.payloads,
      include_title: String(s.include_title === 'yes'),
    });
    const sameAsPack = pack && pack.key === keyOf(s) && pack.generatedAt;
    if (sameAsPack) q.set('generated_at', pack.generatedAt!);
    const { blob, headers } = await api.download('GET', `/ledgers/${ledgerId}/export.pdf?${q}`);
    const name = fileNameFrom(headers.get('Content-Disposition'), 'ringkasan.pdf');
    saveBlob(blob, name);
    setPdf({ kind: 'pdf', name, packHash: headers.get('X-Pack-Hash') ?? '', key: keyOf(s) });
  });

  const back = <BackLink to={`/ledger/${ledgerId}`}>{t('common.back')}</BackLink>;
  if (detail.loading) return <Loading />;
  if (detail.error || !detail.data)
    return <ErrorBox error={detail.error} onRetry={detail.refetch} />;
  const { ledger } = detail.data;
  const count = ledger.head_seq === null ? 0 : ledger.head_seq + 1;
  if (count === 0)
    return (
      <section>
        {back}
        <h1>{t('export.title')}</h1>
        <Empty title={t('export.emptyTitle')} body={t('export.emptyBody')} />
      </section>
    );

  const v = form.values as Values;
  const sameHash = pack && pdf && pack.packHash === pdf.packHash;

  return (
    <section>
      {back}
      <h1>{t('export.title')}</h1>
      <p className="lede">{t('export.lede', { n: count })}</p>

      <form className="card form" noValidate onSubmit={(e) => e.preventDefault()}>
        <Field form={form} name="range" label={t('export.range')} as="select">
          <option value="all">{t('export.rangeAll', { n: count })}</option>
          <option value="seq">{t('export.rangeSeq')}</option>
        </Field>
        {v['range'] === 'seq' && (
          <div className="row row--fields">
            <Field form={form} name="from" label={t('export.from')} inputMode="numeric" />
            <Field form={form} name="to" label={t('export.to')} inputMode="numeric" />
          </div>
        )}
        <Field form={form} name="payloads" label={t('export.payloads')} as="select">
          <option value="all">{t('export.payloadsAll')}</option>
          <option value="none">{t('export.payloadsNone')}</option>
        </Field>
        <Field form={form} name="include_title" label={t('export.title_')} as="select">
          <option value="yes">{t('export.yes')}</option>
          <option value="no">{t('export.no')}</option>
        </Field>
        <Field
          form={form}
          name="include_files"
          label={t('export.files')}
          hint={t('export.filesHint')}
          as="select"
        >
          <option value="no">{t('export.no')}</option>
          <option value="yes">{t('export.yes')}</option>
        </Field>

        {(makePack.error != null || makePdf.error != null) && (
          <p className="form__error" role="alert">
            {errorText(makePack.error ?? makePdf.error)}
          </p>
        )}
        <div className="row">
          <button
            type="button"
            className="btn btn--primary"
            disabled={makePack.pending}
            onClick={() => void makePack.run()}
          >
            <Icon name="download" size={18} />
            {makePack.pending
              ? t('state.preparing')
              : t(v['include_files'] === 'yes' ? 'export.getZip' : 'export.getJson')}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={makePdf.pending}
            onClick={() => void makePdf.run()}
          >
            <Icon name="download" size={18} />
            {makePdf.pending ? t('state.preparing') : t('export.getPdf')}
          </button>
        </div>
      </form>

      {(pack || pdf) && (
        <div className="card exported" data-testid="exported" aria-live="polite">
          <h2>{t('export.done')}</h2>
          <ul className="exported__files">
            {[pack, pdf].filter(Boolean).map((m) => (
              <li key={m!.kind}>
                <Icon name="file" size={16} /> {m!.name}
              </li>
            ))}
          </ul>
          {pack && (
            <p>
              {t('export.packHash')}:{' '}
              <strong className="receipt__code" data-testid="pack-hash" data-hash={pack.packHash}>
                {hash8(pack.packHash)}
              </strong>{' '}
              <CopyButton text={pack.packHash} label={t('export.copyHash')} />
            </p>
          )}
          {sameHash && <p className="note">{t('export.sameHash')}</p>}
          {pack && pdf && !sameHash && <p className="note">{t('export.diffHash')}</p>}
          <p>
            <a className="btn btn--primary" href="/verify" target="_blank" rel="noreferrer">
              <Icon name="seal" size={18} />
              {t('export.verify')}
            </a>
          </p>
          <p className="note">{t('export.verifyHint')}</p>
        </div>
      )}
    </section>
  );
}
