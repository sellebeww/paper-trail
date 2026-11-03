// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Public verifier. Everything runs in this browser with the same library as the CLI: the pack is never sent
// anywhere (this page makes no network request with it).
import {
  describeVerification,
  DISCLAIMER,
  loadPack,
  parsePemCertificates,
  verifyEvidencePack,
  warningText,
  type CheckId,
  type CheckStatus,
  type VerificationReport,
} from '@paper-trail/verifier';
import { useState, type CSSProperties, type FormEvent } from 'react';

/** What each check means for a non-technical reader, and what it does not prove. */
const EXPLAIN: Record<CheckId, string> = {
  format:
    'Paket dibaca sesuai format Paper Trail 1.0. Ini hanya memastikan paket bisa diperiksa, belum berarti isinya benar.',
  chain:
    'Setiap entri memuat sidik jari (hash) entri sebelumnya. Mengubah, menghapus, atau menyisipkan satu entri memutus rantai. Batasnya: rantai utuh membuktikan catatan tidak diubah sejak dibuat, bukan bahwa isi catatan itu benar.',
  witnesses:
    'Saksi menandatangani entri tertentu dengan kunci di perangkatnya. Tanda tangan sah berarti pemegang kunci itu mengonfirmasi entri tersebut. Batasnya: ini tidak membuktikan identitas orangnya, karena nama saksi ditulis oleh saksi sendiri.',
  anchors:
    'Lembaga stempel waktu (TSA) menandatangani sidik jari rantai pada waktu tertentu, jadi entri sampai titik itu sudah ada paling lambat pada waktu tersebut. Batasnya: entri sesudah jangkar terakhir belum punya bukti waktu eksternal, dan tanpa sertifikat akar TSA, sertifikat TSA belum dicek.',
  attachments:
    'Berkas di dalam paket .zip dicocokkan dengan sidik jari yang tercatat di entri. Batasnya: hanya bisa dicek bila berkasnya ikut di dalam paket .zip.',
  pack_hash:
    'Sidik jari seluruh paket, untuk mendeteksi perubahan di bagian mana pun. Batasnya: siapa pun bisa menghitung ulang sidik jari ini, jadi yang membuktikan keaslian adalah rantai, saksi, dan jangkar waktu.',
};

const STATUS: Record<CheckStatus, { icon: string; label: string; color: string }> = {
  pass: { icon: '✔', label: 'Lulus', color: '#15803d' },
  warn: { icon: '!', label: 'Lulus, dengan catatan', color: '#b45309' },
  fail: { icon: '✘', label: 'Gagal', color: '#b91c1c' },
  skip: { icon: '–', label: 'Tidak diperiksa', color: '#555' },
};

const s: Record<string, CSSProperties> = {
  page: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: 640,
    margin: '0 auto',
    padding: 16,
    lineHeight: 1.5,
    color: '#111',
  },
  info: {
    border: '1px solid #b6d4fe',
    background: '#eef5ff',
    borderRadius: 8,
    padding: 12,
    margin: '12px 0',
  },
  label: { display: 'block', fontWeight: 600, marginTop: 12 },
  input: {
    display: 'block',
    width: '100%',
    boxSizing: 'border-box',
    fontSize: 16,
    margin: '6px 0',
  },
  button: {
    display: 'block',
    width: '100%',
    fontSize: 18,
    padding: 12,
    marginTop: 16,
    borderRadius: 8,
    border: 0,
    background: '#1d4ed8',
    color: '#fff',
  },
  card: { border: '1px solid #ccc', borderRadius: 8, padding: 12, margin: '8px 0' },
  mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12, overflowWrap: 'anywhere' },
  small: { fontSize: 13, color: '#444' },
  error: { color: '#b91c1c' },
};

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; report: VerificationReport; packHash?: string };

/** The PDF summary's QR code opens /verifikasi#<pack_hash>, so the reader can compare the two. */
const expectedHash = () => /^#([0-9a-f]{64})$/.exec(window.location.hash)?.[1];

const readBytes = async (file: File) => new Uint8Array(await file.arrayBuffer());

export function VerifyPage() {
  const [pasted, setPasted] = useState('');
  const [packFile, setPackFile] = useState<File | null>(null);
  const [rootsFile, setRootsFile] = useState<File | null>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setState({ kind: 'running' });
    try {
      const bytes = packFile ? await readBytes(packFile) : new TextEncoder().encode(pasted.trim());
      if (bytes.length === 0) throw new Error('Pilih berkas paket atau tempel isinya dulu.');
      let loaded;
      try {
        loaded = loadPack(bytes);
      } catch (err) {
        throw new Error(`Paket tidak dapat dibaca: ${(err as Error).message}`);
      }
      let trustedCerts;
      try {
        trustedCerts = rootsFile ? parsePemCertificates(await rootsFile.text()) : [];
      } catch {
        throw new Error('Berkas sertifikat akar TSA tidak berisi sertifikat PEM.');
      }
      const result = await verifyEvidencePack(loaded.pack, {
        trustedCerts,
        files: loaded.files.size ? loaded.files : undefined,
      });
      setState({
        kind: 'done',
        report: describeVerification(result, { attachmentsChecked: loaded.files.size > 0 }),
        packHash: (loaded.pack as { pack_hash?: unknown }).pack_hash as string | undefined,
      });
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <main style={s.page}>
      <h1>Verifikasi paket bukti</h1>
      <p style={s.info}>
        Pemeriksaan berjalan sepenuhnya di browser ini. Isi paket <strong>tidak dikirim</strong> ke
        server Paper Trail atau ke mana pun. Kamu juga bisa memeriksanya tanpa produk kami sama
        sekali (lihat docs/VERIFY.md).
      </p>
      {expectedHash() && (
        <p style={s.card}>
          Kamu membuka halaman ini dari ringkasan PDF. Hash paket yang tertulis di PDF:{' '}
          <span style={s.mono}>{expectedHash()}</span>
        </p>
      )}

      <form onSubmit={(e) => void verify(e)}>
        <label style={s.label} htmlFor="pack-file">
          Berkas paket (.json atau .zip)
        </label>
        <input
          id="pack-file"
          type="file"
          accept=".json,.zip,application/json,application/zip"
          style={s.input}
          onChange={(e) => setPackFile(e.target.files?.[0] ?? null)}
        />
        <label style={s.label} htmlFor="pack-text">
          …atau tempel isi paket JSON
        </label>
        <textarea
          id="pack-text"
          rows={6}
          style={{ ...s.input, ...s.mono }}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          disabled={packFile !== null}
        />
        <label style={s.label} htmlFor="roots-file">
          Sertifikat akar TSA (PEM, tidak wajib)
        </label>
        <input
          id="roots-file"
          type="file"
          accept=".pem,.crt,.cer"
          style={s.input}
          onChange={(e) => setRootsFile(e.target.files?.[0] ?? null)}
        />
        <span style={s.small}>
          Unduh dari situs lembaga stempel waktu itu sendiri, bukan dari pengirim paket. Tanpanya
          stempel waktu tetap dicek, tetapi sertifikat TSA belum dicek terhadap akar tepercaya.
        </span>
        <button type="submit" style={s.button} disabled={state.kind === 'running'}>
          {state.kind === 'running' ? 'Memeriksa…' : 'Verifikasi'}
        </button>
      </form>

      <div aria-live="polite">
        {state.kind === 'error' && (
          <p role="alert" style={s.error}>
            {state.message}
          </p>
        )}
        {state.kind === 'done' && (
          <Result report={state.report} packHash={state.packHash} expected={expectedHash()} />
        )}
      </div>

      <p style={{ ...s.small, marginTop: 24 }}>{DISCLAIMER}</p>
      <p style={s.small}>© 2026 Vassel Goleyu</p>
    </main>
  );
}

function Result({
  report,
  packHash,
  expected,
}: {
  report: VerificationReport;
  packHash?: string;
  expected?: string;
}) {
  const ok = report.status === 'OK';
  return (
    <section aria-label="Hasil verifikasi">
      <h2
        data-testid="headline"
        style={{
          fontSize: 28,
          margin: '24px 0 8px',
          padding: 16,
          borderRadius: 8,
          color: '#fff',
          background: ok ? '#15803d' : '#b91c1c',
        }}
      >
        {ok ? '✔' : '✘'} {report.headline}
      </h2>
      {report.brokenAt && (
        <p style={s.card}>
          Rantai terputus di <strong>entri {report.brokenAt.seq}</strong>. Entri ini dan semua entri
          sesudahnya tidak dapat dipercaya.
          <br />
          <span style={s.mono}>
            {report.brokenAt.code}: {report.brokenAt.detail}
          </span>
        </p>
      )}

      {typeof packHash === 'string' && (
        <p style={s.card} data-testid="pack-hash">
          Hash paket: <span style={s.mono}>{packHash}</span>
          {expected &&
            (expected === packHash ? (
              <strong style={{ display: 'block', color: '#15803d' }}>
                ✔ Sama dengan hash di ringkasan PDF.
              </strong>
            ) : (
              <strong style={{ display: 'block', color: '#b91c1c' }}>
                ✘ Berbeda dari hash di ringkasan PDF: ini bukan paket yang diringkas PDF itu.
              </strong>
            ))}
        </p>
      )}

      {report.warnings.length > 0 && (
        <>
          <h3>Peringatan</h3>
          <p style={s.small}>
            Peringatan tidak menggagalkan paket, tetapi membatasi apa yang dibuktikannya.
          </p>
          <ul data-testid="warnings">
            {report.warnings.map((f, i) => (
              <li key={i}>
                {warningText(f)} <span style={s.mono}>({f.code})</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Rincian pemeriksaan</h3>
      {report.checks.map((c) => {
        const st = STATUS[c.status];
        return (
          <div key={c.id} style={s.card} data-testid={`check-${c.id}`} data-status={c.status}>
            <strong style={{ color: st.color }}>
              {st.icon} {c.label}: {st.label}
            </strong>
            <div>{c.note}</div>
            <p style={s.small}>{EXPLAIN[c.id]}</p>
            {c.findings.some((f) => f.severity === 'error') && (
              <details>
                <summary>Rincian teknis</summary>
                <ul>
                  {c.findings
                    .filter((f) => f.severity === 'error')
                    .map((f, i) => (
                      <li key={i} style={s.mono}>
                        {f.code}
                        {f.seq !== undefined ? ` (entri ${f.seq})` : ''}
                        {f.reason ? ` ${f.reason}` : ''}: {f.detail}
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </div>
        );
      })}
    </section>
  );
}
