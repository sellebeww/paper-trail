// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import type {
  FilePayload,
  NotePayload,
  PhotoPayload,
  WitnessCosignPayload,
} from '@paper-trail/chain';
import type { Anchor, ApiEntry } from './api';

export const hash8 = (hash: string | null | undefined) => (hash ? hash.slice(0, 8) : '--------');

/** An entry is "anchored" once a confirmed RFC 3161 anchor covers its seq (the anchor commits to the head at that time). */
export const isAnchored = (seq: number, confirmed: Anchor | null) =>
  confirmed !== null && seq <= confirmed.anchored_head_seq;

export const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 * 1024
      ? `${Math.ceil(n / 1024)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

export const formatTime = (iso: string, lang: string) =>
  // Explicit fields: dateStyle/timeStyle cannot be combined with timeZoneName, and the zone matters here.
  new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));

export const shorten = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
};

export const payloadAs = {
  note: (e: ApiEntry) => e.payload as unknown as NotePayload,
  photo: (e: ApiEntry) => e.payload as unknown as PhotoPayload,
  file: (e: ApiEntry) => e.payload as unknown as FilePayload,
  cosign: (e: ApiEntry) => e.payload as unknown as WitnessCosignPayload,
};

export type WitnessMark = { name: string; cosignSeq: number; signedAt: string };

/** Witness badges per target seq, read from the `witness_cosign` entries already in the chain. */
export const witnessMarks = (entries: ApiEntry[]): Map<number, WitnessMark[]> => {
  const marks = new Map<number, WitnessMark[]>();
  for (const e of entries) {
    if (e.type !== 'witness_cosign') continue;
    const p = payloadAs.cosign(e);
    const list = marks.get(p.target_seq) ?? [];
    list.push({ name: p.witness_name, cosignSeq: e.seq, signedAt: e.created_at });
    marks.set(p.target_seq, list);
  }
  return marks;
};

// "Last head I saw", kept outside the server (API.md: Keep the head). localStorage may be unavailable.
type SavedHead = { seq: number; hash: string };
const headKey = (ledgerId: string) => `pt:head:${ledgerId}`;
export const loadHead = (ledgerId: string): SavedHead | null => {
  try {
    const raw = window.localStorage.getItem(headKey(ledgerId));
    return raw ? (JSON.parse(raw) as SavedHead) : null;
  } catch {
    return null;
  }
};
export const saveHead = (ledgerId: string, head: SavedHead) => {
  try {
    window.localStorage.setItem(headKey(ledgerId), JSON.stringify(head));
  } catch {
    // Not fatal: the receipt can still be copied by hand.
  }
};

/** Does the server's chain still contain the head we saw last? */
export const checkSavedHead = (
  saved: SavedHead | null,
  entries: ApiEntry[],
): 'ok' | 'none' | 'shorter' | 'mismatch' => {
  if (!saved) return 'none';
  const at = entries.find((e) => e.seq === saved.seq);
  if (!at) return 'shorter';
  return at.entry_hash === saved.hash ? 'ok' : 'mismatch';
};

export const saveBlob = (blob: Blob, name: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
};

export const fileNameFrom = (disposition: string | null, fallback: string) =>
  /filename="([^"]+)"/.exec(disposition ?? '')?.[1] ?? fallback;

export const whatsappUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;
