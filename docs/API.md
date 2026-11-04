# API (owner side)

Status: v0.1.0, pre-alpha. This is the API a ledger owner uses, plus the public witness endpoints.
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

| Method & path                       | Body                          | Response                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/csrf`                    | –                             | `200 { csrf_token }` (sets `pt_csrf` if logged out)                                                                                                                                                                                                               |
| `POST /auth/register`               | `{ email, password }`         | `201 { user, csrf_token }` + cookies. Password 10–128 chars, hashed with argon2id. Email is lowercased.                                                                                                                                                           |
| `POST /auth/login`                  | `{ email, password }`         | `200 { user, csrf_token }` + cookies                                                                                                                                                                                                                              |
| `POST /auth/logout`                 | –                             | `204`. Deletes the session server-side and clears cookies.                                                                                                                                                                                                        |
| `GET /auth/me`                      | –                             | `200 { user: { id, email, email_verified, created_at }, csrf_token }`                                                                                                                                                                                             |
| `POST /auth/verify-email/request`   | – (logged in)                 | `202 { sent }`, or `200 { already_verified }`. Mails a new link; at most one per minute.                                                                                                                                                                          |
| `POST /auth/verify-email`           | `{ token }`                   | `200 { verified }`. `400 TOKEN_INVALID` for an unknown, used or expired token. No login needed.                                                                                                                                                                   |
| `POST /auth/password-reset/request` | `{ email }`                   | Always `202 { accepted }`, whatever the address. A link is mailed only if the address belongs to an account **and is verified**.                                                                                                                                  |
| `POST /auth/password-reset`         | `{ token, password }`         | `200 { reset }`, or `400 TOKEN_INVALID`. Sets the password, signs out every session of that account and marks the email verified.                                                                                                                                 |
| `POST /ledgers/:id/erase`           | `{ confirm_title, password }` | `200 { erased_entries }`. **Irreversible.** Empties every payload (entries gain `erased_at` and lose `payload`), deletes files and witness identities, revokes unused links. Hashes, times and anchors stay. `403 PASSWORD_INVALID`, `400 CONFIRMATION_MISMATCH`. |
| `POST /account/erase`               | `{ confirm_email, password }` | `200 { erased_entries, erased_ledgers }`. **Irreversible.** Erases every ledger as above, then removes the email and password and signs everyone out.                                                                                                             |

Account links (`/konfirmasi-email#<token>`, `/atur-ulang-sandi#<token>`) carry a 256-bit one-time token in the URL fragment;
only its SHA-256 is stored. Verification links last 24 hours, reset links 1 hour; asking again invalidates the earlier link.
Mail is sent by the API itself (`MAILER=smtp`, `SMTP_URL`, `SMTP_FROM`); the default `console` mailer prints links to the log
for development and is refused when `NODE_ENV=production`. Unverified accounts work normally; only password reset needs
a verified address (a typo at sign-up must not hand the account to a stranger).

### Ledgers

| Method & path           | Body / query                                                        | Response                                                                 |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /ledgers`         | `{ title (1–120), category: kerja\|sewa\|freelance\|gig\|lainnya }` | `201 { ledger }`                                                         |
| `GET /ledgers`          | –                                                                   | `200 { ledgers: [...] }` newest first (max 200)                          |
| `GET /ledgers/:id`      | –                                                                   | `200 { ledger, last_anchor, last_confirmed_anchor, unanchored_entries }` |
| `GET /ledgers/:id/head` | –                                                                   | `200 { ledger_id, head_seq, head_hash, head_created_at, server_time }`   |

`ledger` = `{ id, title, category, head_seq, head_hash, created_at }`. `head_seq`/`head_hash` are `null` until the
first entry. `last_anchor` is the most recent anchor of any status (`pending|ok|failed`) and `last_confirmed_anchor`
the most recent with `status = ok`; each is `null` or `{ status, anchored_head_seq, anchored_head_hash, gen_time,
tsa_url, attempts, updated_at }`, where `gen_time` is the TSA's time. Anchors are created by the worker
([OPERATIONS.md](OPERATIONS.md)). `unanchored_entries` counts entries after `last_confirmed_anchor.anchored_head_seq`:
they have no external time proof yet ([SPEC §8](SPEC.md#8-verification-algorithm), `UNANCHORED_TAIL`).

### Reminders

| Method & path           | Body                                                                                                                         | Response            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `POST /reminders`       | `{ ledger_id?, days_of_week: [1..7] (1 = Senin), time: "HH:MM", timezone?: Asia/Jakarta \| Asia/Makassar \| Asia/Jayapura }` | `201 { reminder }`  |
| `GET /reminders`        | –                                                                                                                            | `200 { reminders }` |
| `DELETE /reminders/:id` | –                                                                                                                            | `204`               |

Example: every working day at 17:00 WIB is `{ "days_of_week": [1,2,3,4,5], "time": "17:00" }`. `next_run_at` is `null`
until the worker schedules it (within `REMINDER_TICK_SECONDS`). Reminders are not evidence, so they can be deleted.

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

### Witness invites (owner)

| Method & path                       | Body                                                                           | Response                                                |
| ----------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `POST /entries/:id/witness-invites` | `{ expires_in_hours?: 1..720 (default 72), owner_display_name?: 1..80 chars }` | `201 { invite, token, url }`                            |
| `GET /entries/:id/witness-invites`  | –                                                                              | `200 { invites: [...] }` newest first                   |
| `DELETE /witness-invites/:id`       | –                                                                              | `204` (idempotent); `409 INVITE_USED` if already signed |

`url` is `<WEB_ORIGIN>/saksi#<token>`. The token is shown **once** and only its SHA-256 is stored; send the URL to
the witness yourself. `owner_display_name` is the only owner identity the witness will see (the ledger title and
your email are never shown). `invite` = `{ id, entry_id, status: open|used|revoked|expired, owner_display_name,
created_at, expires_at, used_at, revoked_at, witness }`, where `witness` is `null` or
`{ display_name, alg, signed_at, cosign_entry_id }`. Entries of type `witness_cosign` cannot be witnessed (`400`).

### Witness (public, no login)

| Method & path                    | Response                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /witness/:token`            | `200 { invite: { id, expires_at, owner_display_name }, entry: { ledger_id, seq, type, created_at, entry_hash, payload, has_attachment } }` |
| `GET /witness/:token/attachment` | The photo or file, `inline`, sandboxed                                                                                                     |
| `POST /witness/:token/sign`      | `201 { receipt }` (SPEC §4.3)                                                                                                              |

Sign body: `{ alg: "Ed25519"|"ES256", witness_pub, signature, witness_name, signed_client_time }`, produced by the
witness page as described in [SPEC §4.1](SPEC.md#41-what-is-signed). The server fills in the invite and target
itself, verifies, and appends the `witness_cosign` entry in the same transaction that marks the invite used.

- Any unusable token (unknown, malformed, expired, revoked or already used) gets the same `404 INVITE_UNAVAILABLE`.
- A bad signature is `400 SIGNATURE_INVALID`; a name that is not 1–80 NFC characters is `400 INVALID_NAME`. Neither
  uses up the invite.
- Rate limits: `WITNESS_RATE_LIMIT_IP` per IP and `WITNESS_RATE_LIMIT_TOKEN` per token, each per 15 minutes
  (defaults 60 and 20).
- Responses carry `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; request logs show `/witness/:token`.
- The POST needs the CSRF header like every other POST (the page gets it from `GET /auth/csrf`).

### Export (evidence pack and PDF)

| Method & path                 | Body / query                                            | Response                                     |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `POST /ledgers/:id/export`    | JSON body, all fields optional (below)                  | `200` the pack (`application/json`) or a zip |
| `GET /ledgers/:id/export.pdf` | Same selection as query parameters, plus `generated_at` | `200 application/pdf`                        |

Body of `POST … /export` (unknown fields are rejected):

| Field                  | Meaning                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `from_seq`, `to_seq`   | Inclusive range of entry numbers. Default: the whole ledger. Cannot be combined with the date form of the same bound.                   |
| `from_date`, `to_date` | ISO 8601 instants; resolved on the server to the first entry at/after and the last entry at/before them.                                |
| `payloads`             | `"all"` (default), `"none"`, or a list of seqs whose content to include. Withheld entries keep their hashes.                            |
| `include_title`        | Default `true`. `false` omits the ledger title from the pack.                                                                           |
| `anchor_bridge`        | Default `true`. Extend a range that ends before the ledger head with envelope-only entries up to the next confirmed anchor (SPEC §6.2). |
| `include_files`        | Default `false`. `true` returns a `.zip` with `pack.json`, `README.txt` and `files/<sha256>.<ext>` (disclosed files only).              |
| `format`               | `json` or `zip`. Defaults from `include_files`; `json` with `include_files` is rejected.                                                |

The response carries `X-Pack-Hash` (the `pack_hash`) and `Content-Disposition: attachment`. Errors: `400 INVALID_RANGE`,
`400 EMPTY_LEDGER`, `400 VALIDATION_ERROR`, `413 EXPORT_TOO_LARGE` (attachments over `EXPORT_MAX_FILES_BYTES`, default
100 MB), `429 RATE_LIMITED` (`EXPORT_RATE_LIMIT` per 10 minutes). Exporting only reads; it changes nothing in the ledger.

The PDF takes `from_seq`, `to_seq`, `from_date`, `to_date`, `payloads` (`all`, `none` or `0,3,5`), `include_title`,
`anchor_bridge`. Its pack hash equals a JSON pack's **only if both are built from the same selection and
`generated_at`**: pass the JSON pack's `generated_at` (within the last 30 days) as `generated_at` to rebuild an
identical pack, and compare `X-Pack-Hash`. Characters outside Latin-1 (emoji, other scripts) are drawn as `?` in the PDF;
the JSON keeps the original text.

```bash
# the pack, then its PDF with the same hash
curl -s -b cookies.txt -H "X-CSRF-Token: $CSRF" -H "Content-Type: application/json" -d '{"from_seq":0}' \
  -D headers.txt -o pack.json "$BASE/ledgers/$LEDGER/export"
GEN=$(sed -n 's/.*"generated_at": "\([^"]*\)".*/\1/p' pack.json | head -n1)
curl -s -b cookies.txt -G --data-urlencode "generated_at=$GEN" -o ringkasan.pdf "$BASE/ledgers/$LEDGER/export.pdf"
npx paper-trail-verify pack.json --roots tsa-roots.pem
```

Checking a pack needs no account: `paper-trail-verify` (packages/verifier) and the `/verify` page run offline, and
[VERIFY.md](VERIFY.md) shows how to check one with only Python and OpenSSL; see also
[SPEC §8](SPEC.md#8-verification-algorithm).

### There is deliberately no edit or delete

There is no `PUT`, `PATCH` or `DELETE` for entries, and none for ledgers. This is the point of the product: a record
that its owner can rewrite is not evidence. Such requests return `404`. The database enforces the same rule below the
API (triggers reject `UPDATE`/`DELETE`/`TRUNCATE` on entries, attachments and witnesses). To correct a mistake,
append a new entry that says so. (Ledger and account deletion for privacy reasons is an open question, see
[OPEN_DECISIONS.md](OPEN_DECISIONS.md).)

## Security notes

The full v0.1.0 review is in [SECURITY.md](SECURITY.md).

- Passwords: argon2id (19 MiB, 2 passes). Unknown emails cost the same time as wrong passwords.
- Session and CSRF tokens: 256-bit random; only the session token's hash is stored.
- Helmet defaults, CORS limited to `WEB_ORIGIN` (credentials allowed), JSON bodies limited to 64 KB, strict zod schemas
  (unknown fields are rejected).
- Ownership is checked on every ledger and attachment route, and a foreign id returns the same `404` as a missing one.
- Request logs hold method, path, status and timing only: no query strings, headers, cookies or bodies.

## Known gaps (roadmap)

- Registration reveals whether an email is taken (`EMAIL_TAKEN`), so it can be used to test whether someone has an
  account. Password reset and verification do not leak this.
- **Rate limiting is per process and in memory.** Several API instances would each keep their own counters; use a shared
  store before scaling out.
- Files are stored on the API host's disk by default; the S3 client has been exercised only against an in-memory fake.
- EXIF/GPS metadata in photos is stored as uploaded ([OPEN_DECISIONS D7](OPEN_DECISIONS.md)).
- Production cookies should move to the `__Host-` prefix once the deployment domain is fixed.
- Witness API paths contain the token. Our logger redacts it; a reverse proxy or CDN in front of the API must be
  configured to do the same before production.
- A witness name is permanent (append-only chain). There is no way to remove a cosign made by someone who got hold of a
  leaked link; see [THREAT_MODEL §5.2](THREAT_MODEL.md).
