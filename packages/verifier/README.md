# @paper-trail/verifier

Offline verifier for Paper Trail evidence packs (format: SPEC 1.0). It checks the hash chain,
witness signatures (Ed25519, ES256), the pack checksum, attached files (zip) and every RFC 3161 time-stamp token
against the entry it covers. No network, no account, no Paper Trail server.

```bash
npx -p @paper-trail/verifier paper-trail-verify pack.json --roots tsa-roots.pem
# or install it: npm install -g @paper-trail/verifier && paper-trail-verify pack.zip --roots tsa-roots.pem
```

```
Usage: paper-trail-verify <evidence-pack.json|.zip> [--roots tsa-roots.pem] [--json]
```

`--roots` is a PEM bundle with the root certificate(s) of the time-stamping authority that issued the pack's anchors;
get it from the TSA itself, not from whoever gave you the pack. Without it the tokens are still checked but their
certificate chain is not. `--json` prints a machine-readable report.

| Exit code | Meaning                                                   |
| --------- | --------------------------------------------------------- |
| 0         | Everything checked passed                                 |
| 1         | Chain broken (an entry was changed, removed or reordered) |
| 2         | Not a valid pack / unknown format version                 |
| 3         | Pack checksum (`pack_hash`) mismatch                      |
| 4         | Invalid witness signature                                 |
| 5         | Invalid time-stamp anchor                                 |
| 6         | Attached file missing or altered                          |
| 64        | Usage error                                               |

## Library

```js
import { readFileSync } from 'node:fs';
import {
  loadPack,
  parsePemCertificates,
  verifyEvidencePack,
  describeVerification,
} from '@paper-trail/verifier';

const { pack, files } = loadPack(readFileSync('pack.zip'));
const trustedCerts = parsePemCertificates(readFileSync('tsa-roots.pem', 'utf8'));
const result = await verifyEvidencePack(pack, { trustedCerts, files });
console.log(result.verdict, describeVerification(result).headline); // "OK" | "FAILED"
```

`@paper-trail/verifier/testing` exports a **mock TSA for tests only**; its tokens prove nothing.

## What a result means

A passing pack shows that its entries existed in this form no later than the last anchor's time and have not been
altered since. It does not show that they are true, who wrote them, or that nothing was left out; entries after the
last anchor have no external time proof. Read the threat model before relying on it.

> Paper Trail membantu membuktikan bahwa catatan tidak diubah setelah dibuat dan kapan catatan itu ada. Ini bukan
> nasihat hukum dan tidak menjamin penerimaan sebagai alat bukti. Konsultasikan dengan pendamping hukum.

Requires Node.js 22+. Licensed under Apache-2.0. Copyright (c) 2026 Vassel Goleyu.
