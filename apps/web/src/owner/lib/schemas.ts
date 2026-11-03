// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Client-side mirrors of the API's body schemas (apps/api/src/routes/*.ts), so mistakes show up before a round trip.
// The server stays the authority. They live here, not in packages/chain, because the API's versions carry
// server-only transforms (NFC normalisation, unpaired-surrogate checks) that do not belong in the browser bundle.
import { z } from 'zod';
import type { MessageKey } from './messages';
import { CATEGORIES } from './api';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

const text = (t: T, max: number) =>
  z
    .string()
    .refine((s) => s.trim().length > 0, t('form.required'))
    .refine((s) => Array.from(s).length <= max, t('form.tooLong', { max }));

export const credentialsSchema = (t: T, mode: 'login' | 'register') =>
  z.object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.email(t('form.emailInvalid'))),
    password:
      mode === 'register'
        ? z
            .string()
            .min(10, t('form.passwordShort'))
            .max(128, t('form.tooLong', { max: 128 }))
        : z.string().min(1, t('form.required')),
  });

export const ledgerSchema = (t: T) =>
  z.object({ title: text(t, 120), category: z.enum(CATEGORIES) });

export const noteSchema = (t: T) => z.object({ text: text(t, 10_000) });

export const captionSchema = (t: T) =>
  z.object({
    caption: z.string().refine((s) => Array.from(s).length <= 500, t('form.tooLong', { max: 500 })),
  });

export const inviteSchema = (t: T) =>
  z.object({
    owner_display_name: z
      .string()
      .trim()
      .refine((s) => s.length > 0, t('form.required'))
      .refine((s) => Array.from(s).length <= 80, t('form.tooLong', { max: 80 })),
    expires_in_hours: z.coerce.number().int().min(1).max(720),
  });

const seqInput = z
  .string()
  .trim()
  .refine((s) => s === '' || /^\d+$/.test(s));

export const exportSchema = (t: T) =>
  z
    .object({
      range: z.enum(['all', 'seq']),
      from: seqInput,
      to: seqInput,
      include_title: z.enum(['yes', 'no']),
      payloads: z.enum(['all', 'none']),
      include_files: z.enum(['yes', 'no']),
    })
    .superRefine((v, ctx) => {
      if (v.range !== 'seq') return;
      const from = v.from === '' ? null : Number(v.from);
      const to = v.to === '' ? null : Number(v.to);
      if (from === null && to === null)
        ctx.addIssue({ code: 'custom', path: ['from'], message: t('form.rangeEmpty') });
      if (from !== null && from < 1)
        ctx.addIssue({ code: 'custom', path: ['from'], message: t('form.rangeFrom') });
      if (from !== null && to !== null && from > to)
        ctx.addIssue({ code: 'custom', path: ['to'], message: t('form.rangeOrder') });
    });
