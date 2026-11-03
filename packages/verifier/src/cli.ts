#!/usr/bin/env node
// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// Offline verifier for Paper Trail evidence packs. Exit codes: see EXIT in report.ts (0 = OK, 1 = chain broken,
// 2 = invalid or unreadable pack, 3 = pack_hash mismatch, 4 = witness, 5 = anchor, 6 = attachment, 64 = usage).
import { readFile } from 'node:fs/promises';
import {
  describeVerification,
  DISCLAIMER,
  EXIT,
  loadPack,
  parsePemCertificates,
  USAGE,
  verifyEvidencePack,
  warningText,
} from './index.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--roots');
const fail = (code: number, message: string): never => {
  console.error(`Error: ${message}`);
  process.exit(code);
};

if (!file || flag('--help')) {
  console.error(USAGE);
  process.exit(EXIT.USAGE);
}

const roots = option('--roots');
const trustedCerts = roots
  ? await readFile(roots, 'utf8')
      .then(parsePemCertificates)
      .catch((err: Error) => fail(EXIT.USAGE, `--roots: ${err.message}`))
  : [];

const loaded = await readFile(file)
  .then(loadPack)
  .catch((err: Error) => fail(EXIT.FORMAT_INVALID, `paket tidak dapat dibaca: ${err.message}`));
const result = await verifyEvidencePack(loaded.pack, {
  trustedCerts,
  files: loaded.files.size ? loaded.files : undefined,
});
const report = describeVerification(result, { attachmentsChecked: loaded.files.size > 0 });
const at = (seq?: number) => (seq !== undefined ? ` (entri ${seq})` : '');

if (flag('--json')) {
  console.log(
    JSON.stringify({ ...report, findings: result.findings, summary: result.summary }, null, 2),
  );
} else {
  const MARK = { pass: '✔', fail: '✘', warn: '!', skip: '–' } as const;
  console.log(`${report.status === 'OK' ? '✔' : '✘'} ${report.headline}`);
  if (report.brokenAt)
    console.log(`  Terputus di entri ${report.brokenAt.seq}: ${report.brokenAt.detail}`);
  console.log('\nPemeriksaan:');
  for (const c of report.checks) {
    console.log(`  ${MARK[c.status]} ${c.label}: ${c.note}`);
    for (const f of c.findings.filter((x) => x.severity === 'error'))
      console.log(`      ${f.code}${at(f.seq)}${f.reason ? ` ${f.reason}` : ''}: ${f.detail}`);
  }
  if (report.warnings.length) {
    console.log('\nPeringatan (tidak menggagalkan, tetapi perlu dibaca):');
    for (const f of report.warnings)
      console.log(`  [PERHATIAN] ${warningText(f)}\n      ${f.code}${at(f.seq)}: ${f.detail}`);
  }
  console.log(`\n${DISCLAIMER}`);
}
process.exit(report.exitCode);
