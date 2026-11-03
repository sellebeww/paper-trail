// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Turns a PackVerification into what people read: one headline, one line per check, warnings, an exit code.
// Shared by the CLI and the browser page so both say exactly the same thing.
import type { Finding, FindingCode, PackVerification } from '@paper-trail/chain';

export type CheckId = 'format' | 'chain' | 'witnesses' | 'anchors' | 'attachments' | 'pack_hash';
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface Check {
  id: CheckId;
  label: string;
  status: CheckStatus;
  /** Short Indonesian summary of what was found (counts, or why the check did not run). */
  note: string;
  findings: Finding[];
}

export interface VerificationReport {
  status: 'OK' | 'FAILED';
  headline: string;
  exitCode: number;
  /** The first chain error: from this entry on, nothing in the pack can be trusted. */
  brokenAt: Finding | null;
  checks: Check[];
  warnings: Finding[];
}

/** CLI exit codes. When several checks fail, the first in CHECKS order decides. */
export const EXIT = {
  OK: 0,
  CHAIN_BROKEN: 1,
  FORMAT_INVALID: 2,
  PACK_HASH_MISMATCH: 3,
  WITNESS_INVALID: 4,
  ANCHOR_INVALID: 5,
  ATTACHMENT_INVALID: 6,
  USAGE: 64,
} as const;

const CHECKS: { id: CheckId; label: string; codes: FindingCode[]; exit: number }[] = [
  {
    id: 'format',
    label: 'Format dan versi paket',
    codes: ['PACK_MALFORMED', 'FORMAT_UNSUPPORTED', 'SCOPE_INVALID'],
    exit: EXIT.FORMAT_INVALID,
  },
  {
    id: 'chain',
    label: 'Rantai entri',
    codes: [
      'CHAIN_OK',
      'GENESIS_INVALID',
      'SEQ_GAP',
      'LEDGER_MISMATCH',
      'BROKEN_AT_SEQ',
      'PAYLOAD_HASH_MISMATCH',
      'TIME_REGRESSION',
      'HEAD_MISMATCH',
      'PARTIAL_PACK',
    ],
    exit: EXIT.CHAIN_BROKEN,
  },
  {
    id: 'witnesses',
    label: 'Tanda tangan saksi',
    codes: ['WITNESS_SIG_INVALID', 'WITNESS_TARGET_MISMATCH', 'WITNESS_SUMMARY_MISMATCH'],
    exit: EXIT.WITNESS_INVALID,
  },
  {
    id: 'anchors',
    label: 'Jangkar waktu (RFC 3161)',
    codes: [
      'ANCHOR_INVALID',
      'ANCHOR_TIME_CONFLICT',
      'ANCHOR_UNVERIFIED',
      'NO_ANCHOR',
      'UNANCHORED_TAIL',
    ],
    exit: EXIT.ANCHOR_INVALID,
  },
  {
    id: 'attachments',
    label: 'Lampiran',
    codes: ['FILE_HASH_MISMATCH', 'FILE_MISSING'],
    exit: EXIT.ATTACHMENT_INVALID,
  },
  {
    id: 'pack_hash',
    label: 'Sidik jari paket (pack_hash)',
    codes: ['PACK_HASH_MISMATCH'],
    exit: EXIT.PACK_HASH_MISMATCH,
  },
];

const BREAKS: FindingCode[] = [
  'GENESIS_INVALID',
  'SEQ_GAP',
  'LEDGER_MISMATCH',
  'BROKEN_AT_SEQ',
  'PAYLOAD_HASH_MISMATCH',
  'TIME_REGRESSION',
];

const entry = (f: Finding) => (f.seq === undefined ? '' : ` di entri ${f.seq}`);

/** Why a failing check failed, in simple Indonesian. */
const failureText = (id: CheckId, f: Finding): string => {
  switch (id) {
    case 'format':
      return f.code === 'FORMAT_UNSUPPORTED'
        ? 'versi format paket tidak dikenal'
        : 'format paket tidak valid';
    case 'witnesses':
      return f.code === 'WITNESS_SUMMARY_MISMATCH'
        ? 'daftar saksi tidak cocok dengan entri'
        : `tanda tangan saksi${entry(f)} tidak sah`;
    case 'anchors':
      return f.code === 'ANCHOR_TIME_CONFLICT'
        ? `entri ${f.seq} lebih baru dari jangkar waktunya`
        : `jangkar waktu untuk entri ${f.seq} tidak sah`;
    case 'attachments':
      return `lampiran${entry(f)} tidak cocok dengan sidik jarinya`;
    case 'pack_hash':
      return 'tidak cocok dengan isi paket';
    case 'chain':
      return BREAKS.includes(f.code) ? `terputus${entry(f)}` : `${f.code}${entry(f)}`;
  }
};

export interface DescribeOptions {
  /** True when files travelled with the pack (zip) and were checked. */
  attachmentsChecked?: boolean;
}

export const describeVerification = (
  r: PackVerification,
  opts: DescribeOptions = {},
): VerificationReport => {
  const s = r.summary;
  const has = (code: FindingCode) => r.findings.some((f) => f.code === code);
  // Which stages verifyPack reached (it returns early on a bad shape, scope or chain).
  const hashChecked = s.entries > 0 && (s.from_seq !== null || has('SCOPE_INVALID'));

  const checks = CHECKS.map(({ id, label, codes }): Check => {
    const findings = r.findings.filter((f) => codes.includes(f.code));
    const error = findings.find((f) => f.severity === 'error');
    const warned = findings.some((f) => f.severity === 'warning');
    const check = (status: CheckStatus, note: string): Check => ({
      id,
      label,
      status,
      note,
      findings,
    });
    if (error) return check('fail', failureText(id, error));
    const notChecked = check('skip', 'tidak diperiksa karena rantai tidak utuh');

    switch (id) {
      case 'format':
        return check('pass', 'format 1.0 dikenali, bagian-bagian paket lengkap');
      case 'pack_hash':
        return hashChecked
          ? check('pass', 'cocok dengan isi paket')
          : check('skip', 'tidak diperiksa karena format paket tidak valid');
      case 'chain':
        if (s.chain_intact)
          return check(
            warned ? 'warn' : 'pass',
            `${s.entries} entri utuh (entri ${s.from_seq}–${s.to_seq})`,
          );
        return check(
          'skip',
          s.from_seq === null
            ? 'tidak diperiksa karena format paket tidak valid'
            : 'pemeriksaan berhenti karena tanda tangan saksi tidak sah',
        );
      case 'witnesses':
        if (!s.chain_intact) return notChecked;
        return s.witnesses_verified
          ? check('pass', `${s.witnesses_verified} tanda tangan saksi sah`)
          : check('skip', 'tidak ada tanda tangan saksi yang diungkap di paket ini');
      case 'anchors':
        if (!s.chain_intact) return notChecked;
        return check(
          warned ? 'warn' : 'pass',
          s.anchored_through_seq === null
            ? 'tidak ada jangkar waktu yang bisa dipakai'
            : `${s.anchors_verified || 'semua'} jangkar sah, mencakup sampai entri ${s.anchored_through_seq}`,
        );
      case 'attachments':
        if (!s.chain_intact) return notChecked;
        if (!opts.attachmentsChecked)
          return check('skip', 'berkas lampiran tidak disertakan (hanya ada di paket .zip)');
        return check(warned ? 'warn' : 'pass', warned ? 'ada lampiran yang hilang' : 'cocok');
    }
  });

  const failed = CHECKS.find((c) => checks.find((x) => x.id === c.id)!.status === 'fail');
  const brokenAt = r.findings.find((f) => f.severity === 'error' && BREAKS.includes(f.code));
  let headline: string;
  if (!failed) headline = s.from_genesis ? 'Rantai utuh' : 'Rantai utuh pada rentang yang diekspor';
  else if (brokenAt) headline = `Terputus di entri ${brokenAt.seq ?? '?'}`;
  else if (failed.id === 'pack_hash')
    headline = 'Isi paket berbeda dari sidik jarinya (paket diubah)';
  else headline = `Paket tidak lolos pemeriksaan: ${checks.find((x) => x.id === failed.id)!.note}`;

  return {
    status: r.verdict,
    headline,
    exitCode: failed?.exit ?? EXIT.OK,
    brokenAt: brokenAt ?? null,
    checks,
    warnings: r.findings.filter((f) => f.severity === 'warning'),
  };
};

/** A warning in simple Indonesian. Warnings never fail a pack but limit what it proves (SPEC §7). */
export const warningText = (f: Finding): string => {
  switch (f.code) {
    case 'UNANCHORED_TAIL':
      return `Entri ${f.seq} dan sesudahnya belum memiliki bukti waktu eksternal: jangkar terakhir lebih lama dari entri terakhir.`;
    case 'NO_ANCHOR':
      return 'Tidak ada jangkar waktu yang bisa dipakai: paket ini tidak membuktikan kapan catatan dibuat.';
    case 'ANCHOR_UNVERIFIED':
      return 'Stempel waktu sah, tetapi sertifikat lembaga stempel waktu (TSA) belum dicek terhadap sertifikat akar tepercaya.';
    case 'PARTIAL_PACK':
      return 'Paket hanya memuat sebagian catatan; entri di luar rentang ini tidak ikut diperiksa.';
    case 'FILE_MISSING':
      return `Lampiran untuk entri ${f.seq} tercantum tetapi tidak disertakan.`;
    default:
      return f.detail;
  }
};

/** One-line verdict in simple Indonesian, as shown to non-technical readers (SPEC §7). */
export const headline = (r: PackVerification): string => describeVerification(r).headline;
