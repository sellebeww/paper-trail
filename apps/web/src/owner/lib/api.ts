// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import type { Entry, PayloadObject } from '@paper-trail/chain';

const BASE = '/api';

export const CATEGORIES = ['kerja', 'sewa', 'freelance', 'gig', 'lainnya'] as const;
export type Category = (typeof CATEGORIES)[number];

export type User = { id: string; email: string; email_verified: boolean; created_at: string };
/** An entry as the owner API returns it: hashed fields plus the convenience `id`, payload always present. */
export type ApiEntry = Omit<Entry, 'payload'> & { id: string; payload: PayloadObject };

export type LedgerRow = {
  id: string;
  title: string;
  category: Category;
  head_seq: number | null;
  head_hash: string | null;
  created_at: string;
};
export type Head = {
  ledger_id: string;
  head_seq: number | null;
  head_hash: string | null;
  head_created_at: string | null;
  server_time: string;
};
export type Anchor = {
  status: 'pending' | 'ok' | 'failed';
  anchored_head_seq: number;
  anchored_head_hash: string;
  gen_time: string | null;
  tsa_url: string | null;
  attempts: number;
  updated_at: string;
};
export type LedgerDetail = {
  ledger: LedgerRow;
  last_anchor: Anchor | null;
  last_confirmed_anchor: Anchor | null;
  unanchored_entries: number;
};
export type InviteStatus = 'open' | 'used' | 'revoked' | 'expired';
export type Invite = {
  id: string;
  entry_id: string;
  status: InviteStatus;
  owner_display_name: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  witness: {
    display_name: string;
    alg: string;
    signed_at: string;
    cosign_entry_id: string;
  } | null;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const readCsrf = () =>
  document.cookie
    .split('; ')
    .find((c) => c.startsWith('pt_csrf='))
    ?.slice('pt_csrf='.length);

/** Anonymous visitors get their CSRF cookie from GET /auth/csrf; it is rotated on login/register. */
const ensureCsrf = async () => {
  if (!readCsrf()) await fetch(`${BASE}/auth/csrf`, { credentials: 'same-origin' });
};

const toError = async (res: Response): Promise<ApiError> => {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(res.status, body.error?.code ?? 'UNKNOWN', body.error?.message ?? '');
  } catch {
    return new ApiError(res.status, 'UNKNOWN', '');
  }
};

const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (method !== 'GET') {
    await ensureCsrf();
    const token = readCsrf();
    if (token) headers['X-CSRF-Token'] = token;
  }
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(payload !== undefined ? { body: payload } : {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '');
  }
  if (!res.ok) throw await toError(res);
  return res;
};

const json = async <T>(res: Response) =>
  res.status === 204 ? (undefined as T) : ((await res.json()) as T);

export const api = {
  get: async <T>(path: string) => json<T>(await send('GET', path)),
  post: async <T>(path: string, body?: unknown) => json<T>(await send('POST', path, body ?? {})),
  del: async (path: string) => void (await send('DELETE', path)),
  /** For downloads: the body as a Blob plus the response headers (X-Pack-Hash, Content-Disposition). */
  download: async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await send(method, path, body);
    return { blob: await res.blob(), headers: res.headers };
  },
  attachmentUrl: (entryId: string) => `${BASE}/entries/${entryId}/attachment`,
};

/** All entries of a ledger, oldest first. The API pages by `seq`; ledgers here are small. */
export const fetchAllEntries = async (ledgerId: string): Promise<ApiEntry[]> => {
  const all: ApiEntry[] = [];
  let cursor: number | null = null;
  do {
    const query: string = cursor === null ? '' : `&cursor=${cursor}`;
    const page: { entries: ApiEntry[]; next_cursor: number | null } = await api.get(
      `/ledgers/${ledgerId}/entries?limit=100${query}`,
    );
    all.push(...page.entries);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return all;
};
