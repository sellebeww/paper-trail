# @paper-trail/chain

The pure core of the Paper Trail evidence format (SPEC 1.0): RFC 8785 canonical JSON, SHA-256
entry hashing, chain building and verification, witness signature messages and checks, evidence pack building and
verification. No I/O and no framework dependencies; runs in Node.js 22+ and modern browsers (`@paper-trail/chain/browser`).

To verify packs from the command line, use [`@paper-trail/verifier`](https://www.npmjs.com/package/@paper-trail/verifier),
which adds RFC 3161 token checks and a CLI.

```js
import { buildEntry, verifyChain } from '@paper-trail/chain';

const genesis = buildEntry(
  {
    ledger_id: '6f1c0a52-3d1e-4b0a-9f55-0c7d6a2e8b11',
    type: 'note',
    created_at: new Date().toISOString(),
    author_ref: 'owner:1',
    payload: { text: 'Hari ini…' },
  },
  null,
);
const result = await verifyChain([genesis]); // { ok: true, code: 'CHAIN_OK', … }
```

Licensed under Apache-2.0. Copyright (c) 2026 Vassel Goleyu.
