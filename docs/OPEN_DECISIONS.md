# Open decisions

Each item has a recommendation and a short reason. Nothing is decided until the project owner says so.
Items marked **VERIFY** depend on external facts that have **not** been checked; do not treat them as confirmed.

## Needs your action before the anchoring step

### D1. Which public TSA to use — VERIFY

- **Where it lives:** `TSA_URLS` in `.env`, a comma-separated fallback list tried in order (empty on purpose), plus
  optional `TSA_CA_CERTS` (PEM roots for chain verification). No TSA URL is hard-coded anywhere.
- **Options to evaluate:** a free public TSA run by a certificate authority or non-profit; a paid commercial TSA with an SLA;
  a TSA from a trust-service provider in Indonesia, if one offers RFC 3161.
- **Recommendation:** start with one free public TSA for development, and design the config to hold a **list** of
  TSAs so a second, independent one can be added without a format change (anchor records already carry `tsa_label`).
  For anything beyond a demo, prefer a TSA with published terms and a stable certificate chain.
- **Why:** a single free TSA is fine for a demo, but it is a single point of failure and its terms may change.
- **You need to verify:** the provider's terms of service (rate limits, commercial use, retention), availability,
  the TSA certificate chain and its expiry, and whether an Indonesian provider exists and what it requires.
  I have not checked any of these.

### D2. Anchor interval

- **Current setting:** 6 hours (`ANCHOR_INTERVAL_HOURS`, as requested in Step 5), only for ledgers whose head changed.
  The owner can trigger an immediate anchor for demos (`anchor:now`). Shorter intervals narrow the unanchored window.
- **Why:** it is the width of the "unanchored tail" window (THREAT_MODEL §4.2). Shorter costs more TSA calls;
  one request per active ledger per hour is cheap at demo scale. Batching many ledgers into a Merkle tree per TSA
  call would cut calls further but adds proof structure; defer until scale demands it.

### D3. Open-source license — decided

- **Decision (v0.1.0):** Apache-2.0 for code and specification, whole repository; copyright Vassel Goleyu (`NOTICE`).
  Reasons in the [README](../README.md#license).
- **Earlier recommendation:** Apache-2.0 for `packages/chain` and `packages/verifier` (so anyone can embed the verifier and
  check evidence without friction), and AGPL-3.0 or Apache-2.0 for the apps depending on whether you want to
  discourage closed hosted forks.
- **Why:** the value of the format grows with independent verifiers; permissive core, your call on the apps.
  I can only apply a standard license text; I am not a lawyer.

## Needs a decision at Step 2–4

### D4. Witness signature scheme (Step 4) — decided

- **Decision:** Ed25519 when the browser supports it, ECDSA P-256 (`ES256`) as automatic fallback (SPEC §4.1).
- **Why:** Ed25519 is simpler and not malleable; the fallback keeps witnesses on older phones from being silently excluded.
  Both paths are tested, including in Chrome with Ed25519 disabled.
- **Still open:** whether to offer the witness an exportable key (so they could later prove "that signature was mine"),
  at the cost of a secret they must protect. Current choice: no, the key is non-extractable and discarded.

### D5. Witness identity binding

- **Recommendation:** none in v0.1 (self-declared name only).
- **Why:** verifying a phone number or email means collecting personal data and building another service. The limit
  is stated honestly in THREAT_MODEL §5.3. Revisit if legal aides say they need it.

### D6. Server-signed receipts

- **Recommendation:** add in a later version, with a server signing key separate from everything else.
- **Why:** it lets owners prove what the server promised, strengthening THREAT_MODEL §4.2/4.3, but it introduces
  key custody and rotation work that should not block the core chain.

### D7. File storage and metadata

- **Recommendation:** MinIO locally, any S3-compatible store in production; objects named by `content_sha256`;
  strict allow-list of media types and a size cap; strip EXIF/GPS from photos **by default, with a visible
  explanation** that the stored hash is of the stripped file.
- **Why:** location metadata can endanger a gig worker or tenant; hash mismatches only matter if users are surprised.
- **Open:** whether packs may bundle file bytes (zip next to the JSON). Recommendation: yes, as a separate optional export.

### D8. Authentication

- **Recommendation:** email + password with argon2id for v0.1; leave phone/WhatsApp OTP as a later option.
- **Why:** meets the stated security baseline with no third-party messaging dependency. Many target users are on
  phones, so the sign-in flow must be light. Account recovery policy (it must not weaken ledger integrity) still
  needs design.

### D9. TSA trust roots for the verifier

- **Recommendation:** the verifier takes TSA roots as an explicit input (file or flag); the web verify page ships
  a small, documented bundle and shows which root verified the anchor. Without roots it reports `ANCHOR_UNVERIFIED`.
- **Why:** an implicit trust store would hide the most important assumption. Depends on D1.

### D10. Primary-key and ledger id format

- **Recommendation:** UUIDv4 for `ledger_id` (as in SPEC); bigint identity for internal row ids.
- **Why:** the ledger id is hashed into every entry, so it should be opaque and unguessable.

## Already decided in Step 1 (tell me if you disagree)

| Decision                                                       | Reason                                                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Prisma is **not** installed yet; `/health` uses `pg` directly. | No schema exists yet. Prisma arrives with the first migration (Step 2).                                   |
| No MinIO bucket is created yet.                                | The API will create or verify it when uploads exist.                                                      |
| No `app` service in Docker Compose yet.                        | Apps run on the host in development. Add containers when there is something to deploy.                    |
| TypeScript is pinned to 6.x.                                   | The latest `typescript-eslint` does not support TypeScript 7.0 yet, so lint failed on 7.0. Revisit later. |
| Node target is `>=22` (`.nvmrc` = 22).                         | Node 22 is LTS. This machine's default Node is 25 (not LTS); `pnpm`/scripts should be run under 22.       |
| Genesis `prev_hash` is 64 zeros; sequence starts at 0.         | See SPEC §2.3.                                                                                            |
