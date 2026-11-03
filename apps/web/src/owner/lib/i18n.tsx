// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Two languages, one flat dictionary each. Indonesian is the default; English must define every key (the type enforces it).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError } from './api';
import { en, id, type MessageKey } from './messages';

export type Lang = 'id' | 'en';
const dictionaries = { id, en } as const;

const initialLang = (): Lang => {
  try {
    const saved = window.localStorage.getItem('pt:lang');
    if (saved === 'id' || saved === 'en') return saved;
  } catch {
    // fall through to the default
  }
  return 'id';
};

type Vars = Record<string, string | number>;
type I18n = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, vars?: Vars) => string;
  /** Human text for any thrown value. Server messages are Indonesian, so English maps known codes itself. */
  errorText: (error: unknown) => string;
};

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem('pt:lang', next);
    } catch {
      // The choice just won't survive a reload.
    }
  }, []);

  const value = useMemo<I18n>(() => {
    const t = (key: MessageKey, vars?: Vars) =>
      dictionaries[lang][key].replace(/\{(\w+)\}/g, (_, name: string) =>
        String(vars?.[name] ?? ''),
      );
    const errorText = (error: unknown) => {
      if (!(error instanceof ApiError)) return t('error.generic');
      if (error.code === 'NETWORK') return t('error.network');
      const coded = `code.${error.code}` as MessageKey;
      if (coded in dictionaries[lang]) return t(coded);
      return lang === 'id' && error.message ? error.message : t('error.generic');
    };
    return { lang, setLang, t, errorText };
  }, [lang, setLang]);

  return <I18nContext value={value}>{children}</I18nContext>;
}

export const useI18n = (): I18n => {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
};
