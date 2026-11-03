# Security

Paper Trail stores evidence for people in disputes, often against someone more powerful than they are. A flaw can hurt
those people, so please report problems privately and give us a chance to fix them first.

## Reporting a vulnerability

- **Do not open a public issue** for a security problem.
- Use GitHub's **private vulnerability reporting** on this repository (_Security_ tab → _Report a vulnerability_).
- Include what you found, how to reproduce it, the affected version or commit, and what an attacker could gain.
- Please do not access other people's data, run denial-of-service tests against anyone's deployment, or publish details
  before a fix is available (or 90 days have passed, whichever is first).

Paper Trail is maintained by one person. Reports are read and answered on a best-effort basis; the aim is a first reply
within 7 days and a fix or mitigation plan within 30 days for serious issues. Credit is given in the release notes
unless you ask otherwise.

| Version | Supported                       |
| ------- | ------------------------------- |
| 0.1.x   | Yes (pre-alpha: security fixes) |
| < 0.1   | No                              |

**Especially welcome:** anything that lets a verifier accept a modified pack (the core promise), lets one user read or
change another user's ledger, lets a witness link be guessed or reused, or leaks tokens, entry text or witness names.

**Out of scope:** the mock TSA (`createMockTsa`, demo only by design), findings that need a compromised device or server
root, volumetric DoS, and missing hardening that [Hardening before production](#hardening-before-production) already
lists.

## Security review for v0.1.0

Reviewed on 2026-11-03 against the code at the v0.1.0 tag. Scope: every HTTP route in `apps/api`, the worker's outbound
calls, the verifier's handling of untrusted packs, logs, dependencies, and the production images. This is a self-review
by the author, not an independent audit.

| Area                           | What was checked                                                                                                                                                                                                                                                                                                                                                                      | Result                                                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IDOR**                       | Every owner route (`ledgers`, `entries`, `attachment`, `witness-invites`, `reminders`, `export`) loads the record with the owner in the same query (`ownLedger`, `ownEntry`, `ledger: { ownerId }`). A foreign id returns the same `404` as a missing one.                                                                                                                            | OK. `api.int.test.ts` "never lets user B see or touch user A's ledger", plus the ownership tests in `witness.int.test.ts` and `export.int.test.ts`.                                                                                                         |
| **Mass assignment**            | Every request body and query is parsed by a zod schema with `.strict()`; database writes list their fields explicitly. Ledger ids, `seq`, timestamps, `author_ref` and witness targets are always set by the server.                                                                                                                                                                  | OK. "rejects … unknown fields" tests.                                                                                                                                                                                                                       |
| **SSRF**                       | The only outbound HTTP call is worker → TSA. URLs come only from `TSA_URLS` in the environment, never from a request or the database.                                                                                                                                                                                                                                                 | **Fixed:** `TSA_URLS` now accepts `http(s)` only; before, any URL scheme (e.g. `data:`) passed validation. Already in place: `redirect: 'error'` (no redirect to an internal host), a timeout, a 64 KB response cap, credentials stripped from logged URLs. |
| **Path traversal (uploads)**   | Storage keys are `u/<random UUID>`, never derived from input. Client file names are sanitized (control, bidi and zero-width characters, path separators, leading dots, length) and only used in `Content-Disposition`, ASCII-escaped plus RFC 5987. Export zips name files `files/<sha256>.<ext>`. The verifier never writes zip entries to disk and caps entry count and total size. | OK. `uploads.test.ts`, "sanitizes file names".                                                                                                                                                                                                              |
| **Upload content**             | Type is decided from magic bytes against an allowlist; the client MIME type and extension are ignored. Files are served with `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff` and `Cache-Control: private, no-store`.                                                                                                                                                | OK. "rejects disallowed content by magic bytes".                                                                                                                                                                                                            |
| **Security headers**           | API: helmet defaults, `x-powered-by` off, CORS pinned to `WEB_ORIGIN`. Web image: nginx adds a CSP (`script-src 'self'`, no inline script, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP, Permissions-Policy and HSTS (effective behind TLS).                                                                                   | **Added** the web headers in `deploy/nginx/` (the Vite dev server sends none).                                                                                                                                                                              |
| **Body size**                  | JSON bodies 64 KB; uploads limited to `UPLOAD_MAX_BYTES` while streaming (declared `Content-Length` checked first, partial objects deleted); busboy field and part limits; nginx `client_max_body_size` 16 MB.                                                                                                                                                                        | OK. "rejects files over the size limit and leaves nothing behind".                                                                                                                                                                                          |
| **Logs**                       | API request log: method, route, status, time; witness tokens in paths become `:token`; errors log only name and code (driver messages can contain submitted values). Worker: masked emails, redacted TSA URLs. nginx: `access_log off` for `/api/`, so tokens in API paths never reach proxy logs. Witness page tokens live in the URL fragment, which browsers never send.           | OK.                                                                                                                                                                                                                                                         |
| **CSRF and sessions**          | Double-submit token compared in constant time and bound to the session; `Origin` checked; `SameSite=Lax`, `httpOnly` session cookie, `Secure` in production; argon2id; only token hashes stored.                                                                                                                                                                                      | OK. CSRF and cookie tests in `api.int.test.ts`.                                                                                                                                                                                                             |
| **Witness tokens**             | 256-bit, stored hashed, one response for unknown, expired, used and revoked tokens, per-IP and per-token rate limits, single use enforced under the ledger lock.                                                                                                                                                                                                                      | OK. `witness.int.test.ts`.                                                                                                                                                                                                                                  |
| **Verifier (untrusted input)** | Packs are untrusted: shape checked before hashing, zip size and count caps, canonical base64url decoding, RFC 3161 tokens fully validated. Property-based tests mutate valid chains at random and require every mutation to be detected.                                                                                                                                              | OK. `verify.property.test.ts`, `packages/verifier/fixtures/`.                                                                                                                                                                                               |
| **Dependencies**               | `pnpm audit` found 1 high and 3 moderate advisories, all in dev-only tools (`lodash` via Prisma Studio, `minimatch` via ESLint).                                                                                                                                                                                                                                                      | **Fixed** with `overrides` in `pnpm-workspace.yaml`; the audit is clean and CI fails on high or critical. Install scripts are now an explicit allowlist (`onlyBuiltDependencies`: Prisma engines, esbuild).                                                 |
| **Behaviour under failure**    | Chaos tests: worker killed mid-anchor, RabbitMQ restarted with a job in flight, database stalled by a table lock.                                                                                                                                                                                                                                                                     | **Fixed** a crash the chaos tests found: after the broker connection dropped, a failing job's `nack` threw on the closed channel (unhandled rejection). The broker requeues such jobs itself; the consumer now ignores that error.                          |
| **Containers**                 | Multi-stage builds; runtime images hold only production dependencies, run as non-root (`node`, nginx-unprivileged), and contain no secrets (`.dockerignore` excludes `.env`).                                                                                                                                                                                                         | OK, with the caveats below.                                                                                                                                                                                                                                 |

## Hardening before production

Known and deliberate gaps for a pre-alpha release:

- **Choose a real TSA** and set `TSA_CA_CERTS`; check its terms ([OPEN_DECISIONS D1](OPEN_DECISIONS.md)). The mock TSA
  proves nothing.
- **TLS** must terminate in front of the web container. Set `NODE_ENV=production` (secure cookies) and the right
  `TRUST_PROXY`.
- **Secrets:** generate fresh database, RabbitMQ and S3 credentials; give the API a scoped S3 user, not the MinIO root.
  Run the worker as its least-privilege role (`db:role`).
- **Rate limits are per process and in memory.** Use a shared store before running more than one API instance.
- **Pin by digest:** base images (`node:22-alpine`, `nginx-unprivileged`, Postgres, RabbitMQ) and GitHub Actions (by
  commit SHA) use floating tags today.
- **No email verification or password reset** yet; registration reveals whether an email is taken.
- **Cookies** should move to the `__Host-` prefix once the domain is fixed.
- Enable GitHub private vulnerability reporting and Dependabot alerts on the repository.

See also [THREAT_MODEL.md](THREAT_MODEL.md) for what the design protects against at all, and the known limitations in
[CHANGELOG.md](../CHANGELOG.md#known-limitations).
