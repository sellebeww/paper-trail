# Architecture

Status: draft v0.1, pre-alpha. The format itself is defined in [SPEC.md](SPEC.md); what the design does and does
not protect is in [THREAT_MODEL.md](THREAT_MODEL.md). Only the health check and the infrastructure exist today;
every flow below is the **planned** design.

## 1. Components

```mermaid
flowchart LR
  subgraph Browser
    WEB["apps/web<br/>React + Vite"]
    VER_WEB["Verify page<br/>(packages/chain in browser)"]
  end
  API["apps/api<br/>Express + TypeScript"]
  WORKER["apps/worker<br/>anchoring jobs"]
  PG[("PostgreSQL<br/>append-only entries")]
  MQ{{"RabbitMQ"}}
  S3[("MinIO<br/>S3-compatible files")]
  TSA["External TSA<br/>(RFC 3161)"]
  CHAIN["packages/chain<br/>pure hash-chain core"]
  CLI["packages/verifier<br/>CLI + library"]

  WEB --> API
  VER_WEB -.uses.-> CHAIN
  API --> PG
  API --> S3
  API --> MQ
  API -.uses.-> CHAIN
  MQ --> WORKER
  WORKER --> PG
  WORKER --> TSA
  CLI -.uses.-> CHAIN
```

| Piece               | Responsibility                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/chain`    | JCS canonicalization, SHA-256, entry/anchor/pack types, chain verification. No Express, no Prisma, no I/O.   |
| `packages/verifier` | CLI and library around `chain` plus TSA token checks. Runs offline.                                          |
| `apps/api`          | Auth, validation (zod), serialized appends, upload handling, witness links, exports. Only writer of entries. |
| `apps/worker`       | Consumes anchor jobs, calls the TSA, stores tokens. Never edits entries.                                     |
| `apps/web`          | Owner UI, witness page, public verification page. Indonesian UI.                                             |
| PostgreSQL          | Source of truth. `UPDATE`/`DELETE` on entries blocked by triggers; `UNIQUE(ledger_id, seq)`.                 |
| RabbitMQ            | Decouples slow or flaky external calls from requests. Retry, backoff, dead-letter queue.                     |
| MinIO / S3          | File bytes, addressed by `content_sha256`. Not part of the chain.                                            |

## 2. Flow: add an entry

Appends to one ledger are serialized so there is never a fork or a duplicate `seq`.

```mermaid
sequenceDiagram
  autonumber
  actor O as Owner
  participant W as apps/web
  participant A as apps/api
  participant S as MinIO
  participant D as PostgreSQL

  O->>W: Write note / choose file
  W->>A: POST /ledgers/:id/entries (no timestamp)
  A->>A: Validate with zod, check size and media type
  opt photo or file
    A->>S: Store bytes
    A->>A: content_sha256 = SHA-256(bytes)
  end
  A->>D: BEGIN
  A->>D: Lock the ledger (SELECT … FOR UPDATE on head row)
  D-->>A: head (seq, entry_hash)
  A->>A: created_at = server clock<br/>seq = head.seq + 1, prev_hash = head.entry_hash<br/>payload_hash, entry_hash via packages/chain
  A->>D: INSERT entry (UNIQUE ledger_id, seq)
  A->>D: UPDATE head row
  A->>D: COMMIT
  A-->>W: receipt { seq, entry_hash, created_at }
  W-->>O: Show receipt, suggest keeping a copy
```

Implemented in `apps/api/src/services/ledger.ts` (`appendEntry`), the only code path that writes entries.
Fork prevention has three independent layers:

1. **Row lock.** `SELECT … FROM ledgers WHERE id = $1 FOR UPDATE` inside the transaction. Concurrent appends to
   the same ledger queue on it; each one reads the head only after the previous one committed, so it gets
   `seq + 1`. Appends to other ledgers lock other rows and are not blocked.
2. **Insert trigger** (`entries_check_link`). An entry with `seq > 0` is rejected unless entry `seq − 1` exists
   in the same ledger with `entry_hash = prev_hash` and an earlier-or-equal `created_at`. Gaps and dangling
   links are impossible even for code or SQL that skips `appendEntry`.
3. **`UNIQUE(ledger_id, seq)`.** Two entries can never share a position, so a fork cannot be stored.

The ledger head (`head_seq`, `head_hash`) is a cached pointer, not evidence; a trigger lets it advance only by
exactly one, to an entry that exists. Triggers reject `UPDATE`, `DELETE` and `TRUNCATE` on `entries`,
`attachments` and `witnesses`, freeze the anchored head of `anchors`, and stop re-targeting witness invites.
Integration tests (`ledger.int.test.ts`) cover 50 parallel appends, cross-ledger independence and each guard.

## 3. Flow: witness co-sign

```mermaid
sequenceDiagram
  autonumber
  actor O as Owner
  actor T as Witness (no account)
  participant A as apps/api
  participant D as PostgreSQL
  participant B as Witness browser

  O->>A: Create witness link for entry N
  A->>A: token = 32 random bytes
  A->>D: Store SHA-256(token), ledger, N, expiry, status=open
  A-->>O: Link /saksi#token (token only in the fragment, shown once)
  O->>T: Send link by chat or SMS
  T->>A: Open link
  A->>D: Look up SHA-256(token), check expiry and status
  A-->>B: Entry N content (as the owner chose to share)
  B->>B: Generate key pair (WebCrypto), private key stays here
  T->>B: Optionally type a name, press confirm
  B->>B: Sign JCS({purpose, ledger_id, target_seq,<br/>target_entry_hash, statement, witness_name, witness_pub})
  B->>A: Submit public key, name, signature
  A->>D: BEGIN, consume link (open to used), lock ledger
  A->>A: Verify signature, check target hash still matches
  A->>D: Append witness_cosign entry, COMMIT
  A-->>B: Receipt { seq, entry_hash, created_at }
  B-->>T: Offer receipt to keep
```

A second use of the same link finds status `used` and fails. The plaintext token is never stored or logged.

## 4. Flow: periodic anchoring

```mermaid
sequenceDiagram
  autonumber
  participant C as Scheduler (worker)
  participant D as PostgreSQL
  participant Q as RabbitMQ
  participant W as Anchor consumer (worker)
  participant T as External TSA

  loop every ANCHOR_INTERVAL_MINUTES
    C->>D: Ledgers whose head is newer than their last anchor
    C->>Q: Publish anchor job { ledger_id, head_seq, head_hash }
  end
  Q->>W: Deliver job
  W->>D: Re-read entry head_seq, confirm head_hash
  W->>W: anchor_digest = SHA-256(JCS({v, ledger_id, head_seq, head_hash}))
  W->>T: TimeStampReq (messageImprint = anchor_digest), URL from TSA_URL
  alt success
    T-->>W: TimeStampToken
    W->>W: Check imprint and basic token structure
    W->>D: Store anchor record (idempotent on ledger, head_seq)
    W->>Q: ack
  else failure
    W->>Q: nack to retry queue (delay grows each attempt)
    Note over Q: After max attempts the message goes to the dead-letter queue for a human to inspect
  end
```

Retries are safe because the job is idempotent: the anchor row is unique per `(ledger_id, head_seq)`. Entries
are never blocked on the TSA.

### Queue topology (proposed)

| Name                        | Role                                                       |
| --------------------------- | ---------------------------------------------------------- |
| `papertrail.anchor`         | Work queue for anchor jobs; dead-letters to the DLQ.       |
| `papertrail.anchor.retry.*` | TTL queues giving 1x, 2x, 4x… delays, dead-lettering back. |
| `papertrail.anchor.dlq`     | Parked jobs after max attempts; alert and manual replay.   |

## 5. Flow: export and verify

```mermaid
sequenceDiagram
  autonumber
  actor O as Owner
  participant A as apps/api
  participant D as PostgreSQL
  actor V as Verifier (legal aide, union)
  participant P as Verify page or CLI

  O->>A: Export ledger, choose which payloads to disclose
  A->>D: Read all entries 0…head and anchors
  A->>A: Build pack (format_version 0.1), omit undisclosed payloads
  A-->>O: JSON pack, plus a short Indonesian PDF with the disclaimer
  O->>V: Hand over pack (any channel)
  V->>P: Paste pack (or run papertrail-verify)
  P->>P: Run SPEC §8 locally, no upload
  P-->>V: "Rantai utuh" or "Terputus di entri X", plus warnings (for example UNANCHORED_TAIL)
```

The verification page and the CLI share `packages/chain`, so there is one definition of "valid". Neither calls
our server. Trusting an anchor additionally needs TSA roots supplied to the verifier.

## 6. Runtime and local infrastructure

`docker-compose.yml` runs PostgreSQL, RabbitMQ (with the management UI) and MinIO, each with a healthcheck.
The apps run on the host with `pnpm dev`. `GET /health` on the API checks PostgreSQL and RabbitMQ and returns
`200 {status: "ok"}` or `503 {status: "degraded"}` with a per-dependency `up`/`down`, without error details.

## 7. Design decisions worth remembering

- **Chain logic lives only in `packages/chain`.** API, worker, CLI and verify page cannot disagree.
- **Server is the only clock.** Clients never send timestamps for hashed fields.
- **Integrity is enforced twice:** at the application and by Postgres triggers.
- **External calls are asynchronous.** The TSA going down must not stop people from recording evidence.
- **Verification is local.** A verifier should not need to trust, or even reach, our server.
