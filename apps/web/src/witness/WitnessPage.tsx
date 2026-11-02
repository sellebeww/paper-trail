// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
import { useEffect, useState, type CSSProperties } from 'react';
import { createWitnessKey, normalizeName, signInvite, type InviteInfo } from './crypto';

const API = '/api';

const DISCLAIMER =
  'Paper Trail membantu membuktikan bahwa catatan tidak diubah setelah dibuat dan kapan catatan itu ada. Ini bukan nasihat hukum dan tidak menjamin penerimaan sebagai alat bukti. Konsultasikan dengan pendamping hukum.';

type Receipt = { cosign_entry: { seq: number; entry_hash: string; created_at: string } } & Record<
  string,
  unknown
>;

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'ready'; info: InviteInfo; error?: string }
  | { kind: 'signing'; info: InviteInfo }
  | { kind: 'done'; receipt: Receipt };

const UNAVAILABLE =
  'Tautan saksi ini tidak berlaku. Minta tautan baru kepada orang yang mengirimkannya.';

const s: Record<string, CSSProperties> = {
  page: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: 560,
    margin: '0 auto',
    padding: 16,
    lineHeight: 1.5,
    color: '#111',
  },
  card: {
    border: '1px solid #ccc',
    borderRadius: 8,
    padding: 12,
    margin: '12px 0',
    background: '#fafafa',
  },
  quote: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 },
  hash: { fontFamily: 'ui-monospace, monospace', fontSize: 12, overflowWrap: 'anywhere' },
  info: {
    border: '1px solid #b6d4fe',
    background: '#eef5ff',
    borderRadius: 8,
    padding: 12,
    margin: '12px 0',
  },
  input: {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    fontSize: 16,
    padding: 10,
    margin: '6px 0 12px',
  },
  button: {
    display: 'block',
    width: '100%',
    minHeight: 48,
    fontSize: 17,
    borderRadius: 8,
    border: 0,
    background: '#14532d',
    color: '#fff',
  },
  error: { color: '#b91c1c', fontWeight: 600 },
  small: { fontSize: 13, color: '#444' },
};

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' });
const TYPE_LABEL = { note: 'Catatan', photo: 'Foto', file: 'Berkas' } as const;

const readToken = () => window.location.hash.slice(1);

const errorMessage = async (res: Response) => {
  try {
    return (
      ((await res.json()) as { error?: { message?: string } }).error?.message ??
      'Terjadi kesalahan. Coba lagi.'
    );
  } catch {
    return 'Terjadi kesalahan. Coba lagi.';
  }
};

function EntryView({ info, token }: { info: InviteInfo; token: string }) {
  const { entry } = info;
  const p = entry.payload;
  const attachmentUrl = `${API}/witness/${token}/attachment`;
  return (
    <div style={s.card}>
      <p style={s.small}>
        {TYPE_LABEL[entry.type]} nomor {entry.seq + 1}, dibuat {formatTime(entry.created_at)} (waktu
        server)
      </p>
      {entry.type === 'note' && <blockquote style={s.quote}>{p.text}</blockquote>}
      {entry.type === 'photo' && (
        <>
          <img
            src={attachmentUrl}
            alt="Foto yang diminta untuk disaksikan"
            style={{ maxWidth: '100%', height: 'auto' }}
          />
          {p.caption && <p style={s.quote}>{p.caption}</p>}
        </>
      )}
      {entry.type === 'file' && (
        <p>
          <a href={attachmentUrl} rel="noreferrer" target="_blank">
            Buka berkas: {p.name}
          </a>{' '}
          ({Math.ceil((p.size ?? 0) / 1024)} KB)
        </p>
      )}
      <p style={s.small}>
        Kode catatan: <span style={s.hash}>{entry.entry_hash}</span>
      </p>
    </div>
  );
}

function Explanation() {
  return (
    <div style={s.info}>
      <strong>Apa artinya menyaksikan?</strong>
      <ul>
        <li>
          Anda menyatakan bahwa Anda sudah melihat catatan di atas, persis seperti yang tampil.
        </li>
        <li>
          Pernyataan Anda ditambahkan ke rantai catatan. Setelah itu tidak bisa diubah atau dihapus,
          juga oleh pemilik catatan.
        </li>
      </ul>
      <strong>Yang TIDAK dibuktikan:</strong>
      <ul>
        <li>Anda tidak menjamin bahwa isi catatan itu benar.</li>
        <li>
          Tanda tangan ini tidak membuktikan siapa Anda. Ia hanya menunjukkan bahwa orang yang
          memegang tautan ini menyetujui.
        </li>
      </ul>
    </div>
  );
}

export function WitnessPage() {
  const [token] = useState(readToken);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [name, setName] = useState('');
  const [understood, setUnderstood] = useState(false);

  useEffect(() => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      return setState({ kind: 'unavailable', message: UNAVAILABLE });
    fetch(`${API}/witness/${token}`)
      .then(async (res) =>
        res.ok
          ? setState({ kind: 'ready', info: (await res.json()) as InviteInfo })
          : setState({ kind: 'unavailable', message: await errorMessage(res) }),
      )
      .catch(() =>
        setState({
          kind: 'unavailable',
          message: 'Tidak dapat terhubung. Periksa internet Anda lalu muat ulang halaman.',
        }),
      );
  }, [token]);

  const sign = async (info: InviteInfo) => {
    setState({ kind: 'signing', info });
    try {
      let key;
      try {
        key = await createWitnessKey();
      } catch {
        return setState({
          kind: 'ready',
          info,
          error:
            'Browser ini tidak mendukung tanda tangan digital. Coba Chrome atau Firefox versi terbaru.',
        });
      }
      const csrf = (await (await fetch(`${API}/auth/csrf`)).json()) as { csrf_token: string };
      const body = await signInvite(info, name, key);
      const res = await fetch(`${API}/witness/${token}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrf_token },
        body: JSON.stringify(body),
      });
      if (res.status === 201)
        return setState({
          kind: 'done',
          receipt: ((await res.json()) as { receipt: Receipt }).receipt,
        });
      if (res.status === 404)
        return setState({ kind: 'unavailable', message: await errorMessage(res) });
      setState({ kind: 'ready', info, error: await errorMessage(res) });
    } catch {
      setState({
        kind: 'ready',
        info,
        error: 'Tidak dapat terhubung. Periksa internet Anda lalu coba lagi.',
      });
    }
  };

  const download = (receipt: Receipt) => {
    const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bukti-saksi-${receipt.cosign_entry.seq}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const nameLength = Array.from(normalizeName(name)).length;
  const canSign = nameLength >= 1 && nameLength <= 80 && understood;

  return (
    <main style={s.page}>
      <h1>Permintaan menjadi saksi</h1>

      {state.kind === 'loading' && <p>Memuat…</p>}

      {state.kind === 'unavailable' && <p style={s.error}>{state.message}</p>}

      {(state.kind === 'ready' || state.kind === 'signing') && (
        <>
          <p>
            <strong>{state.info.invite.owner_display_name ?? 'Seseorang'}</strong> meminta Anda
            menyatakan bahwa Anda telah melihat catatan berikut.
          </p>
          <EntryView info={state.info} token={token} />
          <Explanation />
          <label htmlFor="witness-name">
            Nama Anda{' '}
            <span style={s.small}>(tersimpan permanen dan dapat dilihat pemilik catatan)</span>
          </label>
          <input
            id="witness-name"
            style={s.input}
            value={name}
            maxLength={80}
            autoComplete="name"
            onChange={(e) => setName(e.target.value)}
          />
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            <span>Saya sudah membaca catatan di atas dan memahami penjelasannya.</span>
          </label>
          {state.kind === 'ready' && state.error && (
            <p role="alert" style={s.error}>
              {state.error}
            </p>
          )}
          <button
            type="button"
            style={{ ...s.button, opacity: canSign && state.kind === 'ready' ? 1 : 0.5 }}
            disabled={!canSign || state.kind === 'signing'}
            onClick={() => void sign(state.info)}
          >
            {state.kind === 'signing' ? 'Menyimpan…' : 'Saya menyaksikan ini'}
          </button>
          <p style={s.small}>
            Berlaku sampai {formatTime(state.info.invite.expires_at)}. Tautan hanya bisa dipakai
            satu kali.
          </p>
        </>
      )}

      {state.kind === 'done' && (
        <>
          <p>
            <strong>Terima kasih. Kesaksian Anda sudah tercatat</strong> sebagai catatan nomor{' '}
            {state.receipt.cosign_entry.seq + 1} pada{' '}
            {formatTime(state.receipt.cosign_entry.created_at)}.
          </p>
          <p>
            Simpan bukti di bawah ini. Ini salinan milik Anda sendiri: berisi tanda tangan Anda dan
            kode rantai catatan, sehingga bisa dipakai untuk memeriksa bahwa catatan itu tidak
            diubah kemudian.
          </p>
          <button type="button" style={s.button} onClick={() => download(state.receipt)}>
            Unduh bukti saya
          </button>
          <p style={s.small}>
            Kode kesaksian: <span style={s.hash}>{state.receipt.cosign_entry.entry_hash}</span>
          </p>
        </>
      )}

      <p style={{ ...s.small, marginTop: 24 }}>{DISCLAIMER}</p>
    </main>
  );
}
