// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import type { Control, Values } from './lib/form';
import { useI18n } from './lib/i18n';
import { Link } from './lib/router';

const ICONS = {
  note: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 13h7 M9 17h7',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4z M12 17a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
  file: 'M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L14 7',
  seal: 'M12 21a9 9 0 100-18 9 9 0 000 18z M8 12.5l3 3 5-6',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 7v5l3 2',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 100-6 3 3 0 000 6z',
  copy: 'M9 9h11v11H9z M5 15V4h11',
  share: 'M12 3v12 M7 8l5-5 5 5 M5 14v7h14v-7',
  plus: 'M12 5v14 M5 12h14',
  download: 'M12 3v12 M7 10l5 5 5-5 M5 21h14',
  alert: 'M12 3l10 18H2z M12 10v5 M12 18v.5',
  back: 'M15 5l-7 7 7 7',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1 M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  refresh: 'M20 11a8 8 0 10-2.3 5.7 M20 4v7h-7',
} as const;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label ?? t('state.loading')}</span>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, errorText } = useI18n();
  return (
    <div className="state state--error" role="alert">
      <Icon name="alert" />
      <p>{errorText(error)}</p>
      {onRetry && (
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          {t('state.retry')}
        </button>
      )}
    </div>
  );
}

export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="state state--empty">
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="back">
      <Icon name="back" size={18} />
      {children}
    </Link>
  );
}

/** Copies text; falls back to a hidden textarea where the async clipboard API is unavailable (plain http, old WebViews). */
export const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
};

export function CopyButton({
  text,
  label,
  className = 'btn btn--ghost',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2200);
  };
  return (
    <button type="button" className={className} onClick={() => void onClick()}>
      <Icon name="copy" size={18} />
      <span aria-live="polite">{copied ? t('copy.done') : (label ?? t('copy.label'))}</span>
    </button>
  );
}

/** The short hash people read aloud or screenshot, with the full value one tap away. */
export function HashChip({ hash, label }: { hash: string | null; label?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!hash) return <span className="hash hash--none">{t('hash.none')}</span>;
  return (
    <span className="hashchip">
      {label && <span className="hashchip__label">{label}</span>}
      <button
        type="button"
        className="hash"
        aria-expanded={open}
        title={t('hash.toggle')}
        onClick={() => setOpen((o) => !o)}
      >
        {hash.slice(0, 8)}
      </button>
      {open && <code className="hash hash--full">{hash}</code>}
    </span>
  );
}

export function AnchorStamp({ anchored }: { anchored: boolean }) {
  const { t } = useI18n();
  return anchored ? (
    <span className="stamp stamp--ok" data-testid="stamp-anchored">
      <Icon name="seal" size={16} />
      {t('anchor.anchored')}
    </span>
  ) : (
    <span className="stamp stamp--wait" data-testid="stamp-waiting">
      <Icon name="clock" size={16} />
      {t('anchor.waiting')}
    </span>
  );
}

type FormLike = {
  register: (name: string) => {
    id: string;
    name: string;
    value: string;
    onChange: (e: ChangeEvent<Control>) => void;
    'aria-invalid': true | undefined;
    'aria-describedby': string | undefined;
  };
  errors: Values;
};

type FieldProps = {
  form: FormLike;
  name: string;
  label: string;
  hint?: string;
  as?: 'input' | 'textarea' | 'select';
  type?: string;
  rows?: number;
  autoComplete?: string;
  maxLength?: number;
  inputMode?: 'numeric' | 'email' | 'text';
  children?: ReactNode;
};

export function Field({
  form,
  name,
  label,
  hint,
  as = 'input',
  type = 'text',
  rows,
  children,
  ...rest
}: FieldProps) {
  const reg = form.register(name);
  const error = form.errors[name];
  const describedBy = [hint ? `${name}-hint` : null, error ? `${name}-error` : null]
    .filter(Boolean)
    .join(' ');
  const common = { ...reg, 'aria-describedby': describedBy || undefined, ...rest };
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      {as === 'textarea' ? (
        <textarea {...common} rows={rows ?? 5} />
      ) : as === 'select' ? (
        <select {...common}>{children}</select>
      ) : (
        <input {...common} type={type} />
      )}
      {hint && (
        <p className="field__hint" id={`${name}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={`${name}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
