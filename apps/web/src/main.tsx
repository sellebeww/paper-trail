// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { WitnessPage } from './witness/WitnessPage';

// /saksi#<token> is the public witness page, /verify the public verifier (/verifikasi#<pack_hash> is the same
// page, as linked from the PDF summary's QR code). Everything else is the owner app, which routes itself.
// The verifier (pkijs and friends) loads only on /verify, not on the witness page people open on their phones.
const VerifyPage = lazy(() =>
  import('./verify/VerifyPage').then((m) => ({ default: m.VerifyPage })),
);
// The owner app (router, forms, i18n) is its own chunk so witness and verify pages stay light.
const OwnerApp = lazy(() => import('./owner/OwnerApp'));
const path = window.location.pathname;
const page = path.startsWith('/saksi') ? (
  <WitnessPage />
) : path.startsWith('/verify') || path.startsWith('/verifikasi') ? (
  <Suspense fallback={<p>Memuat pemeriksa…</p>}>
    <VerifyPage />
  </Suspense>
) : (
  <Suspense fallback={<p>Memuat…</p>}>
    <OwnerApp />
  </Suspense>
);

createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>);
