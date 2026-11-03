// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Minimal form state validated by a zod schema (same shapes as the API's). Replaces react-hook-form here.
import { useCallback, useState, type ChangeEvent, type FormEvent } from 'react';
import type { z } from 'zod';

export type Values = Record<string, string>;
export type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export function useForm<T>(schema: z.ZodType<T>, initial: Values) {
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<Values>({});

  const set = useCallback((name: string, value: string) => {
    setValues((v) => ({ ...v, [name]: value }));
    setErrors((e) => {
      if (!e[name]) return e;
      const rest = { ...e };
      delete rest[name];
      return rest;
    });
  }, []);

  const register = (name: string) => ({
    id: name,
    name,
    value: values[name] ?? '',
    onChange: (e: ChangeEvent<Control>) => set(name, e.target.value),
    'aria-invalid': errors[name] ? (true as const) : undefined,
    'aria-describedby': errors[name] ? `${name}-error` : undefined,
  });

  /** Parsed data, or null after showing the errors and focusing the first invalid field. */
  const validate = (): T | null => {
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const next: Values = {};
      for (const issue of parsed.error.issues) {
        const name = String(issue.path[0] ?? '_');
        next[name] ??= issue.message;
      }
      setErrors(next);
      const first = Object.keys(next)[0];
      if (first) document.getElementById(first)?.focus();
      return null;
    }
    setErrors({});
    return parsed.data;
  };

  const handleSubmit = (fn: (data: T) => Promise<void> | void) => async (e: FormEvent) => {
    e.preventDefault();
    const data = validate();
    if (data) await fn(data);
  };

  return { values, errors, register, set, validate, handleSubmit };
}

export type FormApi = ReturnType<typeof useForm>;
