// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
export const USAGE =
  'Usage: paper-trail-verify <evidence-pack.json|.zip> [--roots tsa-roots.pem] [--json]';

/** Neutral legal disclaimer, shown wherever a verification result is shown. */
export const DISCLAIMER =
  'Paper Trail membantu membuktikan bahwa catatan tidak diubah setelah dibuat dan kapan catatan itu ada. Ini bukan nasihat hukum dan tidak menjamin penerimaan sebagai alat bukti. Konsultasikan dengan pendamping hukum.';

export * from './pack.js';
export * from './report.js';
export * from './timestamp.js';
