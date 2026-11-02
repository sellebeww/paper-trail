# API (owner side)

Status: pre-alpha, v0. This is the API a ledger owner uses. Witness links, anchoring and export are later steps.
Request and response bodies are JSON with `snake_case` fields, matching [SPEC.md](SPEC.md). User-facing
`message` strings are Indonesian; `code` values are stable identifiers.

> Paper Trail membantu membuktikan bahwa catatan tidak diubah setelah dibuat dan kapan catatan itu ada. Ini bukan
> nasihat hukum dan tidak menjamin penerimaan sebagai alat bukti. Konsultasikan dengan pendamping hukum.

## Try it

`docs/examples/quickstart.sh` runs the whole flow with `curl` (register → ledger → note → file → head → entries):

```bash
pnpm infra:up && pnpm --filter @paper-trail/api db:migrate && pnpm dev
BASE=http://localhost:3000 ./docs/examples/quickstart.sh
```

The essential calls, by hand (`-b/-c` keep the cookie jar; every POST echoes the CSRF cookie in a header):

```bash
JAR=$(mktemp); BASE=http://localhost:3000
curl -s -b $JAR -c $JAR $BASE/auth/csrf                                   # sets the pt_csrf cookie
CSRF=$(awk '$6=="pt_csrf"{print $7}' $JAR)
curl -s -b $JAR -c $JAR -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
  -d '{"email":"budi@example.test","password":"kata-sandi-panjang-1"}' $BASE/auth/register
CSRF=$(awk '$6=="pt_csrf"{print $7}' $JAR)                                  # the token is rotated on login/register
curl -s -b $JAR -c $JAR -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
  -d '{"title":"Sengketa lembur","category":"kerja"}' $BASE/ledgers         # note the ledger "id"
curl -s -b $JAR -c $JAR -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF" \
  -d '{"type":"note","text":"Atasan menolak membayar lembur."}' $BASE/ledgers/<LEDGER_ID>/entries
curl -s -b $JAR $BASE/ledgers/<LEDGER_ID>/head
```

## Conventions

**Authentication.** Cookie session. `POST /auth/register` and `POST /auth/login` set two cookies:

| Cookie       | Flags                                              | Purpose                                                       |
| ------------ | -------------------------------------------------- | ------------------------------------------------------------- |
| `pt_session` | `HttpOnly`, `SameSite=Lax`, `Secure` in production | Random 256-bit token. Only its SHA-256 is stored server-side. |
| `pt_csrf`    | `SameSite=Lax`, readable by JS                     | CSRF token. Send it back in the `X-CSRF-Token` header.        |

**CSRF.** Every request that is not `GET`/`HEAD`/`OPTIONS` (including login and register) needs an
`X-CSRF-Token` header equal to the `pt_csrf` cookie and, when logged in, to the session's token. If an `Origin`
header is present it must be the configured `WEB_ORIGIN`. Otherwise: `403 CSRF_INVALID`. Anonymous clients get a
token from `GET /auth/csrf`. Sessions last `SESSION_TTL_HOURS` (default 7 days).

**Errors.** Always `{ "error": { "code", "message", "request_id", "details"? } }`. Unexpected failures are a generic
`500 INTERNAL_ERROR`; internals are never returned (they are not logged with request data either).

| Status | `code`                                               | When                                                            |
| ------ | ---------------------------------------------------- | --------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`, `INVALID_JSON`, `INVALID_UPLOAD` | Bad input. `details` lists `{path, message}` for validation.    |
| 401    | `UNAUTHENTICATED`, `INVALID_CREDENTIALS`             | Not logged in, or wrong email/password (same message for both). |
| 403    | `CSRF_INVALID`                                       | Missing/mismatched CSRF token or foreign `Origin`.              |
| 404    | `NOT_FOUND`                                          | Missing **or not yours** (the two are indistinguishable).       |
| 409    | `EMAIL_TAKEN`                                        | Email already registered.                                       |
| 413    | `FILE_TOO_LARGE`, `PAYLOAD_TOO_LARGE`                | Over `UPLOAD_MAX_BYTES` (default 15 MB) or JSON over 64 KB.     |
| 415    | `UNSUPPORTED_FILE_TYPE`, `UNSUPPORTED_MEDIA_TYPE`    | Content type not allowed.                                       |
| 429    | `RATE_LIMITED`                                       | See below. `Retry-After` is set.                                |
| 503    | `STORAGE_UNAVAILABLE`                                | Object storage is down.                                         |

**Rate limits** (per client IP, in memory): login and register share `AUTH_RATE_LIMIT` per 15 minutes
(default 10); everything else `API_RATE_LIMIT` per minute (default 300). `/health` is exempt. Behind a proxy set
`TRUST_PROXY` to the number of proxies, otherwise all clients look like one IP.

**IDs** are UUIDs. **Hashes** are 64-character lowercase hex. **Times** are `YYYY-MM-DDTHH:mm:ss.sssZ`, always
taken from the server clock; no endpoint accepts a client timestamp.

## Endpoints

### Auth

| Method & path         | Body                  | Response                                                                                                |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /auth/csrf`      | –                     | `200 { csrf_token }` (sets `pt_csrf` if logged out)                                                     |
| `POST /auth/register` | `{ email, password }` | `201 { user, csrf_token }` + cookies. Password 10–128 chars, hashed with argon2id. Email is lowercased. |
| `POST /auth/login`    | `{ email, password }` | `200 { user, csrf_token }` + cookies                                                                    |
| `POST /auth/logout`   | –                     | `204`. Deletes the session server-side and clears cookies.                                              |
| `GET /auth/me`        | –                     | `200 { user: { id, email, created_at }, csrf_token }`                                                   |

### Ledgers

| Method & path           | Body / query                                                        | Response                                                               |
| ----------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `POST /ledgers`         | `{ title (1–120), category: kerja\|sewa\|freelance\|gig\|lainnya }` | `201 { ledger }`                                                       |
| `GET /ledgers`          | –                                                                   | `200 { ledgers: [...] }` newest first (max 200)                        |
| `GET /ledgers/:id`      | –                                                                   | `200 { ledger, last_anchor, last_confirmed_anchor }`                   |
| `GET /ledgers/:id/head` | –                                                                   | `200 { ledger_id, head_seq, head_hash, head_created_at, server_time }` |

`ledger` = `{ id, title, category, head_seq, head_hash, created_at }`. `head_seq`/`head_hash` are `null` until the
first entry. `last_anchor` is the most recent anchor of any status (`pending|ok|failed`, with `anchored_head_seq`,
`anchored_head_hash`, `gen_time`, `attempts`), `last_confirmed_anchor` the most recent with `status = ok`; both are
`null` until anchoring exists (a later step). Entries after `last_confirmed_anchor.anchored_head_seq` have no external
time proof yet ([SPEC §8](SPEC.md#8-verification-algorithm), `UNANCHORED_TAIL`).

**Keep the head.** `GET /ledgers/:id/head` and every append response return `head_seq` + `head_hash`. Clients should
store the latest one outside the server ("last proof I saw"): if the server ever shows a chain that lacks that hash at
that `seq`, it was rewritten ([THREAT_MODEL §4.2](THREAT_MODEL.md)).

### Entries

| Method & path                      | Body / query                                | Response                       |
| ---------------------------------- | ------------------------------------------- | ------------------------------ |
| `POST /ledgers/:id/entries`        | `{ "type": "note", "text": 1–10000 chars }` | `201 { entry, head }`          |
| `POST /ledgers/:id/entries/upload` | multipart, see below                        | `201 { entry, head }`          |
| `GET /ledgers/:id/entries`         | `?cursor=<seq>&limit=1..100` (default 50)   | `200 { entries, next_cursor }` |
| `GET /entries/:id/attachment`      | –                                           | `200` file bytes               |

**Append response.** `entry` is the complete entry exactly as hashed
(`id, v, ledger_id, seq, type, created_at, author_ref, payload_hash, prev_hash, entry_hash, payload`; `id` is a
convenience and is not part of the hash) and `head` has the same shape as `GET …/head`. The response also carries
`X-Ledger-Head-Seq` and `X-Ledger-Head-Hash` headers. Text is normalized to Unicode NFC before hashing; `\u0000` and
unpaired surrogates are rejected.

**Pagination.** `cursor` is the last `seq` you have seen; `next_cursor` is the last `seq` of this page, or `null` when
you have reached the end. Because `seq` is immutable and only grows, appends during paging add entries at the end and
never shift, skip or repeat earlier ones.

**Upload** (`multipart/form-data`, one file):

| Field     | Notes                                                  |
| --------- | ------------------------------------------------------ |
| `type`    | `photo` or `file`. **Must come before the file part.** |
| `caption` | Optional, `photo` only, up to 500 chars.               |
| `file`    | The bytes. Size ≤ `UPLOAD_MAX_BYTES`.                  |

The server decides the type from the **magic bytes**, never from the filename or the client's `Content-Type`.
Allowed: JPEG, PNG, WebP, HEIC/HEIF (these are the only ones accepted for `photo`), PDF, DOCX, XLSX, MP3, M4A, OGG/Opus
(DOCX and audio are accepted by detection but are not covered by automated tests yet). Everything else, including
GIF, SVG, HTML, text and executables, is `415`. The file is hashed (SHA-256) while it streams to object storage under
a random key (`u/<uuid>`), its name is sanitized (path parts, control and bidi characters removed, ≤ 120 characters),
and the entry's payload is, per [SPEC §3](SPEC.md):

- `file`: `{ content_sha256, size, media_type, name }`
- `photo`: `{ content_sha256, size, media_type, caption? }`

so `payload_hash` commits to the file's content hash and its metadata. If the entry cannot be written, the stored
object is deleted. Download is streamed through the API after the ownership check, as `attachment` with
`X-Content-Type-Options: nosniff` and a sandboxing CSP, so an uploaded file can never run as a page.

### There is deliberately no edit or delete

There is no `PUT`, `PATCH` or `DELETE` for entries, and none for ledgers. This is the point of the product: a record
that its owner can rewrite is not evidence. Such requests return `404`. The database enforces the same rule below the
API (triggers reject `UPDATE`/`DELETE`/`TRUNCATE` on entries, attachments and witnesses). To correct a mistake,
append a new entry that says so. (Ledger and account deletion for privacy reasons is an open question, see
[OPEN_DECISIONS.md](OPEN_DECISIONS.md).)

## Security notes

- Passwords: argon2id (19 MiB, 2 passes). Unknown emails cost the same time as wrong passwords.
- Session and CSRF tokens: 256-bit random; only the session token's hash is stored.
- Helmet defaults, CORS limited to `WEB_ORIGIN` (credentials allowed), JSON bodies limited to 64 KB, strict zod schemas
  (unknown fields are rejected).
- Ownership is checked on every ledger and attachment route, and a foreign id returns the same `404` as a missing one.
- Request logs hold method, path, status and timing only: no query strings, headers, cookies or bodies.

## Known gaps (roadmap)

- **Email verification and password reset** are not implemented. Registration therefore reveals whether an email is
  taken (`EMAIL_TAKEN`) and accounts are not tied to a verified address.
- **Rate limiting is per process and in memory.** Several API instances would each keep their own counters; use a shared
  store before scaling out.
- Expired sessions are only removed when they are used; there is no cleanup job yet.
- The S3 client has been exercised only against an in-memory fake in tests, not yet against a running MinIO.
- EXIF/GPS metadata in photos is stored as uploaded ([OPEN_DECISIONS D7](OPEN_DECISIONS.md)).
- Production cookies should move to the `__Host-` prefix once the deployment domain is fixed.
- Witness links (Step 4) will carry a secret in the URL path; the request logger must be revisited to redact it.
