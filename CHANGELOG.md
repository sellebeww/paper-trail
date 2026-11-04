# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).
The evidence format has its own version (`docs/SPEC.md`, currently 1.0), independent of the software version.

## [0.1.0] - 2026-11-03

First public pre-alpha. The format is stable (SPEC 1.0); the software is not production-ready (see
[Known limitations](#known-limitations)).

### Added

- **Evidence format, SPEC 1.0** ([docs/SPEC.md](docs/SPEC.md)): RFC 8785 canonical JSON, SHA-256 hash chain, witness
  co-sign entries (Ed25519, ES256 fallback), RFC 3161 anchors over the head entry, evidence packs (JSON or zip) with
  selective disclosure and partial exports bridged to the next anchor, and a pinned test vector.
- **`packages/chain`**: canonicalization, entry building, chain and pack verification. Pure, no I/O.
- **`packages/verifier`**: offline verification of packs, RFC 3161 tokens and witness signatures; the
  `paper-trail-verify` CLI with stable exit codes. Publishable to npm as `@paper-trail/verifier` (with
  `@paper-trail/chain`).
- **API** (`apps/api`): accounts (argon2id, CSRF, rate limits), ledgers, append-only notes, photos and files (magic-byte
  checks, streamed to S3/MinIO), witness invites with single-use public co-sign links, reminders, and exports as JSON,
  zip and a PDF summary with a QR code. PostgreSQL triggers keep entries append-only.
- **Worker** (`apps/worker`): periodic RFC 3161 anchoring with retries, backoff and a dead-letter queue; reminder
  notifications; a least-privilege database role.
- **Web** (`apps/web`): the owner app (Indonesian and English), a mobile witness page with in-browser signing, and
  `/verify`, which checks a pack entirely in the browser.
- **Verification without our code** ([docs/VERIFY.md](docs/VERIFY.md)): a Python 3 + OpenSSL walkthrough and tampered
  fixtures for testing other verifiers.
- **Demo**: `pnpm demo` seeds a fictional unpaid-overtime ledger (15 entries, 2 witnesses, 2 anchors from a mock TSA)
  and writes a valid and a tampered pack for `/verify`.
- **Accessibility**: axe-core (WCAG 2.x A and AA) runs on the main screens in the browser tests, with no violations.
  Automated only; the screens have not been tried with a screen reader.
- **Tests**: property-based tests that random mutations of a valid chain are always detected; chaos tests (worker
  killed mid-anchor, RabbitMQ restart, stalled database); browser end-to-end tests.
- **Operations**: a multi-stage production `Dockerfile` (`api`, `worker`, `web`, `migrate` targets), nginx config with
  security headers, and GitHub Actions CI (lint, typecheck, unit, integration, chaos and e2e tests, build, audit,
  images, npm publish dry-run).
- **Docs**: README with an Indonesian summary, THREAT_MODEL, ARCHITECTURE, OPERATIONS, API, SECURITY, CONTRIBUTING.

### Changed

- Erasing a ledger's content or a whole account at the owner's request, keeping the hash chain and anchors valid
  (migration `_erasure`; password and typed confirmation required).
- Email verification and password reset (one-time links by mail; reset only for verified addresses; reset signs out every
  session). Unverified accounts keep working and see a banner.
- Verifier: tokens that carry a cross-signed copy of a trusted root (DigiCert) now verify; found by testing a real DigiCert
  token. Recommended TSA setup (FreeTSA, DigiCert failover) with a roots bundle.
- `pnpm --filter @paper-trail/worker tsa:check` tests a real time-stamping authority with the worker's own client. FreeTSA was
  checked end to end (worker, CLI, and the Python + OpenSSL steps) and a real-token example pack added.
- Uploaded files are stored on local disk by default (`STORAGE_DIR`); S3 is optional. Expired sessions are purged hourly.
  The api image is about 500 MB (the Prisma CLI is removed from it).
- Licensed under **Apache-2.0** (code and specification); previously an "all rights reserved" placeholder.

### Security

- Self-review of every endpoint; summary in [docs/SECURITY.md](docs/SECURITY.md).
- The worker accepts only `http(s)` TSA URLs.
- Fixed a crash when a job failed after the RabbitMQ connection was lost (found by the chaos tests).
- Advisories in dev tooling resolved with overrides; dependency install scripts are an explicit allowlist.

## Known limitations

Read these before relying on Paper Trail for anything real.

**What the evidence can and cannot show**

- A pack shows that entries existed in a given form by a given time and were not changed since. It does not show that
  they are true, who really wrote them, or that nothing was left out ([THREAT_MODEL](docs/THREAT_MODEL.md)).
- **Entries after the last anchor have no external time proof.** Until the next anchor, the operator could truncate or
  rewrite that tail without the chain alone revealing it; verifiers report it as `UNANCHORED_TAIL`.
- **Witness names are self-declared.** A valid signature proves that the holder of a device key confirmed an entry,
  not who that person is. Keys are discarded after signing.
- The legal weight of this kind of evidence in Indonesian courts (or anywhere) has **not** been verified. This is not
  legal advice.

**Not ready for production**

- **No time-stamping authority is enabled by default.** A tested setup is documented (FreeTSA with DigiCert as failover);
  you must enable it and accept its terms, and neither provider offers an SLA. The bundled mock TSA proves nothing.
- Not independently audited; the security review is a self-review.
- Registration reveals whether an email is already registered. Production needs an SMTP server for account mail.
- Rate limits are in memory, per process: run one API instance. No high-availability setup.
- Uploaded files live on the API host's disk (`FsStore`): single host only, back them up with the database. The S3
  client (for several hosts) is tested against an in-memory store only, not against a running S3 service.
- Photo EXIF/GPS metadata is stored as uploaded ([OPEN_DECISIONS D7](docs/OPEN_DECISIONS.md)).
- Audio and Office uploads are accepted by type detection but not covered by tests.
- Erasure removes content, not the skeleton (numbers, times, hashes), and cannot recall packs already shared. Whether it
  meets the privacy law where you host ([D11](docs/OPEN_DECISIONS.md)) has not been checked.
- Base images and GitHub Actions are pinned by tag, not by digest or SHA. The production images are built in CI and
  smoke-tested locally, but have not run in a real deployment.
- The repository has no public remote yet, so the packages carry no `repository` field, and the `@paper-trail` npm
  scope has not been reserved.
- The witness page and `/verify` are in Indonesian only.
