#!/usr/bin/env node
// Copyright (c) 2026 Vassel Goleyu. All rights reserved.
// Offline verifier for Paper Trail evidence packs. Exit code: 0 = verdict OK, 1 = FAILED, 2 = usage/input error.
import { readFile } from 'node:fs/promises';
import { headline, loadPack, parsePemCertificates, USAGE, verifyEvidencePack } from './index.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--roots');

if (!file || flag('--help')) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const roots = option('--roots');
  const trustedCerts = roots ? parsePemCertificates(await readFile(roots, 'utf8')) : [];
  const { pack, files } = loadPack(await readFile(file));
  const result = await verifyEvidencePack(pack, {
    trustedCerts,
    files: files.size ? files : undefined,
  });

  if (flag('--json')) {
    console.log(JSON.stringify({ headline: headline(result), ...result }, null, 2));
  } else {
    const s = result.summary;
    console.log(`${result.verdict === 'OK' ? '✔' : '✘'} ${headline(result)}`);
    if (s.from_seq !== null)
      console.log(
        `  Entri ${s.from_seq}–${s.to_seq} (${s.entries} entri), saksi terverifikasi: ${s.witnesses_verified}, jangkar terverifikasi: ${s.anchors_verified}`,
      );
    if (s.anchored_through_seq !== null)
      console.log(`  Jangkar waktu eksternal mencakup sampai entri ${s.anchored_through_seq}`);
    for (const f of result.findings.filter((x) => x.code !== 'CHAIN_OK')) {
      const mark =
        f.severity === 'error' ? 'GALAT' : f.severity === 'warning' ? 'PERHATIAN' : 'info';
      console.log(
        `  [${mark}] ${f.code}${f.seq !== undefined ? ` (entri ${f.seq})` : ''}${f.reason ? ` ${f.reason}` : ''}: ${f.detail}`,
      );
    }
    console.log(
      '\nPaper Trail membantu membuktikan bahwa catatan tidak diubah setelah dibuat dan kapan catatan itu ada.',
    );
    console.log(
      'Ini bukan nasihat hukum dan tidak menjamin penerimaan sebagai alat bukti. Konsultasikan dengan pendamping hukum.',
    );
  }
  process.exit(result.verdict === 'OK' ? 0 : 1);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(2);
}
