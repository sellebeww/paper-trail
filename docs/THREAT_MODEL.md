# Threat model

Status: draft v0.1, pre-alpha. Read together with [SPEC.md](SPEC.md). Section numbers like "SPEC §8" refer to it.

## 0. What this system does, in one honest paragraph

Paper Trail lets a person keep dated records so that **later changes to old records are detectable**, and so
that an **external clock** (an RFC 3161 Time-Stamping Authority) and, optionally, **other people** (witnesses)
vouch that those records existed in that form by a certain time. It does **not** prove that what a record says
is true, who really wrote it, or that nothing was left out.

> **Legal status: not verified.** The legal weight of electronic evidence in Indonesian courts has **not** been
> verified by the project owner. Nothing in this repository, UI or export should be read as a statement that
> any court, mediator or agency will accept it. Users should consult a legal aide (pendamping hukum).

Neutral disclaimer shown in the UI and PDF:

> Paper Trail membantu membuktikan bahwa catatan tidak diubah setelah dibuat dan kapan catatan itu ada. Ini
> bukan nasihat hukum dan tidak menjamin penerimaan sebagai alat bukti. Konsultasikan dengan pendamping hukum.

## 1. Assets and actors

**Assets:** the integrity of past entries; the claim "existed no later than T"; witness confirmations; the
privacy of entry contents and of the people in them.

**Actors:**

| Actor            | Capabilities assumed                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Owner            | Authenticated user who writes entries and exports packs. Possibly adversarial toward the other party.   |
| Counterparty     | The person the owner is in dispute with. Can challenge the evidence. May have no access to our systems. |
| Operator (us)    | Runs the server and database. Full DB/admin access. May be compelled, compromised, or simply wrong.     |
| Witness          | Anyone holding a one-time link. No account.                                                             |
| TSA              | External third party that signs timestamps.                                                             |
| Network attacker | Can observe/modify traffic; can obtain leaked links.                                                    |
| Verifier         | Anyone checking a pack (legal aide, union, mediator). Needs no trust in us beyond the pack.             |

## 2. Summary table

| #   | Threat                                                      | Outcome                                                                    |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| 3.1 | Owner edits or deletes an old entry                         | **Detected** (hash chain)                                                  |
| 3.2 | Owner fabricates entries from the start                     | **Not preventable.** Only "existed at T, unchanged" is proven              |
| 3.3 | Owner hides unfavourable ledgers or entries                 | **Not preventable.** Completeness is not proven                            |
| 3.4 | Owner's account is taken over                               | Attacker can append; authentic-looking but false entries possible          |
| 4.1 | Operator rewrites history after an anchor exists            | **Detected** (anchor + head hash mismatch)                                 |
| 4.2 | Operator rewrites history _not yet_ anchored                | **Not prevented** unless someone holds a later head hash (owner, witness)  |
| 4.3 | Operator forks (shows different chains to different people) | Limited by anchors and by receipts held outside our systems                |
| 4.4 | Operator refuses to store, deletes ledger, or goes offline  | **Not prevented** (availability). Mitigation: exports                      |
| 4.5 | Operator backdates `created_at`                             | Bounded above by anchor; below only by predecessor timestamp and witnesses |
| 5.x | Witness link leaked / witness collusion / sybil witnesses   | Partly mitigated; identity and independence **not** proven                 |
| 6.x | TSA misbehaviour or key compromise; our own key compromise  | Timestamp trust degrades; multiple TSAs (open) reduce the impact           |
| 7.x | Privacy leaks through packs, verify page, files, logs       | Mitigated by design; residual metadata leakage                             |

## 3. The owner

### 3.1 Owner edits or deletes an old entry — detected

Every entry commits to its predecessor (`prev_hash`) and to its own content (`payload_hash`). Changing or removing
entry `k` changes its hash, which breaks the link in entry `k+1`. A verifier reports `BROKEN_AT_SEQ` or `SEQ_GAP`
at that entry (SPEC §7, §8). The database also rejects `UPDATE` and `DELETE` on the entries table through
triggers, so this is enforced below the application as well; an operator with superuser access can still bypass
triggers, which is why external anchors and held head hashes exist (§4).

Rewriting the _whole tail_ consistently (recomputing every later hash) defeats the chain alone. It is stopped
only by an anchor covering the old head, or by a head/receipt kept outside the system.

### 3.2 Owner fabricates entries from the start — NOT preventable

If the owner invents an event on day 1 and records it, the system will faithfully show "this text existed at
time T and has not changed since". That is **all** it proves. It cannot establish that the event happened.

Partial help: a **witness** who confirms an entry shows that another person saw that content at the time (§5), and
**files** with consistent hashes make later swapping harder. Neither proves truth. Evidence that stands
on its own (payslips, messages, contracts) matters far more than the notebook.

### 3.3 Owner hides unfavourable material — NOT preventable

An owner can start a second ledger, delete a whole ledger from the server, or export only some payloads. The
pack proves what is in it; it cannot prove that nothing else exists. A verifier should treat a pack as "what the
owner chose to show".

Selective disclosure inside one ledger is intentional (SPEC §6): hidden payloads keep their hashes, so the chain
still verifies, but the verifier sees that entries exist and when.

### 3.4 Account takeover

An attacker who controls the owner's session can append entries that look authentic and are timestamped. They
cannot alter past entries. Mitigations: argon2id password hashing, rate limiting, and (planned, not in this step)
re-authentication for exports and witness-link creation. Account recovery design is **[OPEN]**.

### 3.5 Exports: partial packs and `pack_hash`

- **Partial export.** The owner may export a range. The pack then carries `first_prev_hash`, an unproven claim about
  the entry before it (SPEC §6.2). The verifier shows `PARTIAL_PACK` and, without an anchor inside the pack,
  `NO_ANCHOR`. An anchor bridge lets the owner time-prove a range by revealing the type and time of the entries between
  the range and the next anchor (never their content).
- **Cherry-picking.** A partial or payload-selective pack proves what it contains, not what was left out (§3.3). The
  PDF says so in plain language.
- **`pack_hash` is not a signature.** Anyone can edit a pack and recompute it. It identifies a pack and exposes a swap
  when the PDF or another channel carries the original hash; tamper-evidence comes from the chain and anchors.
- **Fabricated segments.** An owner can invent entries, claim they start at entry N with an arbitrary
  `first_prev_hash`, and obtain a valid-looking segment. Only an anchor or an independently kept head ties a segment to
  the real ledger, and even an anchor from a public TSA only proves that a hash existed at a time (anyone can timestamp
  any hash). Paper Trail proves "existed at T and unchanged", not "this came from the real ledger".
- **Metadata in bridge entries.** Their type, time and number reveal activity patterns even without content.

## 4. The operator (us)

We assume the operator can read and write the database and can restart services. The design goal is that the
operator **cannot silently rewrite what has already been anchored or witnessed**, not that the operator is
unable to do harm.

### 4.1 Rewrite after an anchor — detected

An anchor binds `head_hash` of `head_seq` to a TSA signature with `genTime` (SPEC §5). If the operator changes
any entry `≤ head_seq` and recomputes the chain, the new head hash differs from the anchored one and the verifier
reports `ANCHOR_INVALID` (`HEAD_MISMATCH`). The TSA is a third party, so the operator cannot forge its signature
(unless §6 applies).

### 4.2 Rewrite before the next anchor — what STILL CAN happen

Between anchors the operator can rewrite or replace the **unanchored tail**. The width of that window is the
anchor interval (configured; default proposal 60 minutes). The verifier flags it as `UNANCHORED_TAIL`, but a
rewritten tail looks internally consistent, so the flag only says "no external proof for these entries".

What narrows it, without trusting us:

- **Receipts held by the owner.** Each append returns `seq`, `entry_hash`, `created_at`. If the owner (or an
  app) stores the latest receipt, a later pack whose chain does not contain that `entry_hash` at that `seq`
  proves a rewrite. This only helps if the receipt is actually kept outside the server.
- **Witness receipts** (SPEC §4.3): a witness holds the `entry_hash` of their cosign entry, which commits to the whole
  history before it.
- **Server-signed receipts** would let the owner prove the operator _said_ something; this is **[OPEN]**.

### 4.3 Forking (equivocation)

The operator could show owner A one chain and a verifier another. Both would be internally valid. What limits
this: only one of the two can match an anchor and any receipts already given out. Two valid but different
chains for one `ledger_id`, each backed by receipts or anchors, is itself proof of operator misbehaviour. If
neither side kept a receipt and the fork is within the unanchored window, it is **undetectable**.

Within our own system, concurrent writes cannot create a fork by accident: appends are serialized per ledger
(row lock or advisory lock) and `UNIQUE(ledger_id, seq)` rejects a second entry with the same `seq`.

### 4.4 Refusal, deletion, outage

The operator can refuse to store an entry, delete the ledger, or be unavailable when it is needed. Paper Trail
does not prevent this. Mitigations are the owner's own exports (JSON pack, PDF) kept elsewhere, and encouraging
exports after important events. Backups and retention policy are operational matters outside this document.

### 4.5 Backdating `created_at`

`created_at` is a claim by our server clock. The anchor gives an **upper** bound: the entry existed no later than
`genTime`. For the **lower** bound there is only the monotonic chain (an entry cannot be earlier than its
predecessor's `created_at` without `TIME_REGRESSION`) and any witness or anchor earlier in the chain. So a
dishonest operator could make an entry look **older** than it is, but only within the span between the
previous trustworthy bound and the next anchor. Entries cannot be made to look **newer than** their covering anchor
(`ANCHOR_TIME_CONFLICT`).

Practical reading: shorter anchor intervals and earlier witnesses shrink the uncertain span; they never remove it.

## 5. Witnesses

### 5.1 What a witness cosign gives

A cosign entry is a signature by a browser-generated key over the exact `target_entry_hash` (SPEC §4). The server cannot
create that confirmation without the key, and cannot later move it to a different entry. It is evidence that
"someone holding this link confirmed this content at roughly the time the cosign entry was made".

### 5.2 Leaked or forwarded link

A link is a bearer secret: **whoever opens it first can sign, under any name they like.**

What happens if it leaks to someone else:

- That person sees the one entry the invite points at (and its photo or file, if any), plus the owner name the
  owner chose for that invite. Nothing else in the ledger: not the title, other entries, or the owner's email.
- If they sign before the intended witness, a cosign with their chosen name is appended. Because the chain is
  append-only, **it cannot be removed**, not by the owner and not by us. The intended witness then sees "link not
  valid" and the owner must issue a new invite.
- They cannot sign twice, change what was signed, sign a different entry, or reuse the signature with another
  invite (`invite_id` and `target_entry_hash` are inside the signed message).

Mitigations in place:

| Mitigation                                                                                  | Effect                                                                                                                 |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 256-bit random token; only `SHA256(token)` stored                                           | Guessing is infeasible; a database leak does not reveal usable links.                                                  |
| Token only in the URL **fragment** of the shared link                                       | Not sent with the page request, not in `Referer`, not in web server or proxy logs.                                     |
| API logs redact `/witness/<token>` to `/witness/:token`                                     | The token is not written to our logs. Reverse proxies in front of the API must redact the same path (deployment note). |
| `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on witness responses and the page | The token does not leak through links on the page or caches.                                                           |
| Single use, consumed atomically with the append                                             | Parallel attempts with one token yield exactly one cosign (tested with 10 in parallel).                                |
| Expiry (default 72 h) and owner revocation while unused                                     | Shrinks the window in which a leaked link is useful.                                                                   |
| One generic "not valid" answer for unknown, malformed, expired, revoked and used tokens     | A guesser cannot tell which tokens exist or what happened to them.                                                     |
| Rate limits per IP and per token (hashed key)                                               | Limits scanning and repeated attempts on one link.                                                                     |
| Owner sees each invite's status and the signer's name                                       | A wrong or unexpected signer is visible quickly.                                                                       |

Not mitigated: an attacker who obtains the link before the intended witness wins the race, and the resulting
cosign is permanent. The honest remedy is social and on the record: the owner appends a note stating that cosign
`seq N` was not made by the intended witness and invites the witness again. Advice to owners: send the link over a
channel the witness controls (personal chat, not a group), and confirm with the witness by another route.

### 5.3 Collusion and sybil witnesses

The owner can create many links and open them personally, or recruit a friend. The system cannot
distinguish an independent witness from the owner. A cosign therefore proves a _signature_, not _independence_
or _identity_ (SPEC §4.4). Optional identity binding (for example confirming a phone number) is **[OPEN]** and,
if added, would collect personal data, which conflicts with the minimal-data principle.

### 5.4 Witness privacy and coercion

A witness sees the one entry the owner chose to share. They enter only a name they choose to give; the page says
it is stored permanently and visible to the owner. Because entries are append-only, **a witness name cannot be
deleted later**, even on request; a witness who is worried should use a recognisable nickname. We store the public
key, the signature, the name and the device clock reading, not a phone number or email, unless a later decision
changes this. The witness's private key is non-extractable and discarded, so nobody (including us) can sign as
that key again; the witness also cannot later prove "that key was mine" beyond holding the receipt.

## 6. Keys, TSA and trust roots

Before a token is stored, the worker checks status, imprint, nonce, `genTime`, the CMS signature, the ESS
signing-certificate attribute and the timeStamping key usage, and, when `TSA_CA_CERTS` is set, the certificate chain
(SPEC §5.1). A TSA that answers wrongly is never trusted for that anchor; the anchor is marked `failed` and retried
later. The worker runs as a database role that cannot write entries, so a compromised worker can withhold or delay
anchors but cannot alter the chain.

| Failure                                        | Impact                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TSA private key compromised / TSA dishonest    | An attacker could forge timestamps; anchors from that TSA lose value from the compromise date, and certificate revocation may apply. Using two independent TSAs per anchor is **[OPEN]**. |
| TSA certificate expires or is revoked          | Old tokens remain checkable only if the verifier accepts historical validity; long-term validation (for example embedded revocation data) is **[OPEN]**.                                  |
| TSA unavailable                                | Anchors are delayed, the unanchored window grows. The worker retries with backoff and uses a dead-letter queue; entries are never blocked on the TSA.                                     |
| Verifier configured with wrong trust roots     | A malicious pack with a fake TSA could verify. Trust roots are an explicit verifier input, and without them the verifier reports `ANCHOR_UNVERIFIED`, never a silent pass.                |
| Our own signing key (if server receipts exist) | Not applicable in v0.1 (no server signatures). If added, compromise would allow forged receipts; key custody would need its own section.                                                  |
| SHA-256 weakened                               | Entry `v` and anchor `v` allow migration; old anchors would need re-anchoring with a new hash.                                                                                            |
| Client-side key generation weak (old browsers) | A predictable witness key would allow forging that witness's signature. We rely on the platform's WebCrypto and refuse to proceed if it is missing.                                       |

## 7. Privacy

- The **public verification page** takes a pasted pack and checks it in the browser using the same core library
  (`packages/chain`). It needs no login and no server lookup, so it learns nothing about the owner or content
  beyond what the user chooses to paste.
- A pack contains only the payloads the owner **chose** to include. Hidden entries still reveal `type`,
  `created_at`, and that they exist. The export screen must state this plainly.
- TSA requests contain only a hash derived from `ledger_id` and the head hash (SPEC §5.1); no content, no names.
- Photos can contain location and device metadata (EXIF). Whether we strip it by default is **[OPEN]**; stripping
  changes the file bytes and therefore its hash, which must be explained to users.
- Logs must not contain entry text, tokens, or witness names. Witness tokens are stored only as hashes.
- Personal data is minimal: pseudonymous `author_ref`, no email/phone in hashed fields.

## 8. Out of scope for v0.1

Physical coercion of users, device malware that edits what the user sees before submission, truthfulness of
content, identity proofing, long-term archival formats, and legal admissibility analysis.

## 9. Reading guide for verifiers

A pack that reports `CHAIN_OK` with verified anchors supports exactly this statement and no more:

> The entries in this pack, with these hashes, existed no later than the anchored time and have not been altered
> since, up to the last anchored entry. Entries after that have no external time proof.

Everything beyond that — that events happened, who wrote them, whether the owner left things out — depends on
other evidence and on people, not on this tool.
