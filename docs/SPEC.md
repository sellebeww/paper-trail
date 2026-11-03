# Paper Trail Format Specification — Draft v0.4

Status: **draft, pre-alpha**. Nothing here is frozen. Changes from v0.1 are listed in §10. Items marked **[OPEN]** are decisions
tracked in [OPEN_DECISIONS.md](OPEN_DECISIONS.md). The key words MUST, SHOULD and MAY are used as in RFC 2119.

This document defines what is hashed, signed, anchored and exported, and how a third party verifies it.
It is written so that `packages/chain` and `packages/verifier` can be implemented from it alone.

> Paper Trail helps show that a record was not changed after it was made and when it existed.
> It is not legal advice and does not guarantee acceptance as evidence. See [THREAT_MODEL.md](THREAT_MODEL.md).

## 1. Conventions

| Topic          | Rule                                                                                                                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical JSON | JCS, RFC 8785. Hashed objects MUST NOT contain floating-point numbers, `null`, or duplicate keys. Numbers MUST be integers in the safe range ±(2^53 − 1).                                                                                                                                                        |
| Hash           | SHA-256 over the UTF-8 bytes of the canonical form.                                                                                                                                                                                                                                                              |
| Hash encoding  | 64 characters, lowercase hex. Never uppercase, never prefixed.                                                                                                                                                                                                                                                   |
| Timestamps     | `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, millisecond precision, always `Z`). Always assigned by the server. A client-supplied time is never stored in a hashed field. If the server clock reads earlier than the head entry, the server uses the head's `created_at` (never earlier), so `created_at` is non-decreasing. |
| Text           | Free text is normalized to Unicode NFC by the server before hashing. The hash covers the stored, normalized value.                                                                                                                                                                                               |
| IDs            | `ledger_id` is a lowercase UUID string.                                                                                                                                                                                                                                                                          |
| Binary         | Binary values inside JSON (keys, signatures, DER) are base64url without padding.                                                                                                                                                                                                                                 |

## 2. Ledger and entry

A **ledger** is one append-only chain owned by one user (for example, one dispute). Entries are numbered by
`seq`, starting at `0`, with no gaps.

### 2.1 Entry envelope (the hashed part)

| Field          | Type    | Description                                                                                                                                                                    |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `v`            | integer | Entry format version. `1` in this draft.                                                                                                                                       |
| `ledger_id`    | string  | UUID of the ledger. Binding it into the hash prevents splicing an entry into another ledger.                                                                                   |
| `seq`          | integer | Position in the ledger. `0` for the first entry. Each next entry is exactly previous `seq + 1`.                                                                                |
| `type`         | string  | One of `note`, `photo`, `file`, `witness_cosign` (see §3).                                                                                                                     |
| `created_at`   | string  | Server time of creation.                                                                                                                                                       |
| `author_ref`   | string  | Pseudonymous author reference matching `^(owner\|witness):[0-9a-f-]{1,128}$`: `owner:<user uuid>` or `witness:<key fingerprint>`. The grammar makes email or phone impossible. |
| `payload_hash` | string  | SHA-256 of the canonical payload (see §3). Lets an export hide a payload while keeping the chain verifiable.                                                                   |
| `prev_hash`    | string  | `entry_hash` of entry `seq - 1`. For `seq = 0`, the genesis value (§2.3).                                                                                                      |

### 2.2 Entry hash

```
entry_hash = SHA256( JCS({ v, ledger_id, seq, type, created_at, author_ref, payload_hash, prev_hash }) )
```

The stored/exported entry is the envelope plus `entry_hash` plus, optionally, `payload`:

```json
{
  "v": 1,
  "ledger_id": "6f1c0a52-3d1e-4b0a-9f55-0c7d6a2e8b11",
  "seq": 3,
  "type": "note",
  "created_at": "2026-11-02T11:20:00.000Z",
  "author_ref": "owner:9d2f4c1a",
  "payload_hash": "…64 hex…",
  "prev_hash": "…64 hex…",
  "entry_hash": "…64 hex…",
  "payload": { "text": "Atasan menolak membayar lembur." }
}
```

`entry_hash` is derived, so it MUST NOT be an input of its own computation.

### 2.3 Genesis

For `seq = 0`, `prev_hash` is 64 zero characters (`"0"` × 64).

Reason: `ledger_id` is already part of every hash, so a special per-ledger genesis value would add no
protection, and an all-zero value is unambiguous, easy to audit by eye, and common practice. It cannot
realistically collide with a real SHA-256 output. Entry `0` MUST NOT be of type `witness_cosign`.

## 3. Entry types and payloads

`payload_hash = SHA256(JCS(payload))`. Payload objects contain no floats and no `null`.

| `type`           | Payload                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `note`           | `{ "text": string }`, 1–10 000 characters after NFC.                                                                                 |
| `photo`          | `{ "content_sha256": hex, "size": int, "media_type": string, "caption"?: string }`. `media_type` is on an allow-list (image types).  |
| `file`           | `{ "content_sha256": hex, "size": int, "media_type": string, "name": string }`. `media_type` is on an allow-list; `size` is limited. |
| `witness_cosign` | See §4. The witness signature lives inside the payload.                                                                              |

For `photo` and `file`, the chain commits to the file only through `content_sha256` (computed by the server on
upload). File bytes live in object storage and are **not** part of the chain; an export that includes the file
lets a verifier recompute the hash. Stripping EXIF/GPS metadata is a privacy decision **[OPEN]**.

## 4. Witness co-sign

A witness has no account. The owner creates a one-time **invite** for one target entry (any type except
`witness_cosign`). The invite carries a random 256-bit token (base64url, 43 characters). The server stores only
`SHA256(token)`. The token appears only in the link the owner shares, and only in its **fragment**
(`https://<web>/saksi#<token>`), so it is never sent in the page request or in a `Referer`. An invite expires
(default 72 hours, owner may choose 1 hour to 30 days), can be revoked by the owner while unused, and works once.

The witness page shows the target entry (the owner chose to share it), its `entry_hash`, and an owner name only if
the owner typed one for this invite. The witness types a display name (self-declared, not verified), confirms,
and the browser signs. The private key is generated in the browser as non-extractable and never leaves it.

### 4.1 What is signed

The signed message is the UTF-8 bytes of the JCS encoding of:

```json
{
  "v": 1,
  "purpose": "papertrail.witness.cosign.v1",
  "ledger_id": "…uuid…",
  "invite_id": "…uuid…",
  "target_seq": 3,
  "target_entry_hash": "…64 hex…",
  "statement": "confirm",
  "witness_name": "Siti Rahayu",
  "witness_pub": "…base64url…",
  "alg": "Ed25519",
  "signed_client_time": "2026-11-03T08:00:00.000Z"
}
```

| Field                                          | Why it is signed                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`, `purpose`                                 | Domain separation: the signature cannot be reused as anything else.                                                                                                                                                 |
| `ledger_id`, `target_seq`, `target_entry_hash` | Exactly what was witnessed. The hash alone is unique; `seq` makes the statement readable.                                                                                                                           |
| `invite_id`                                    | Binds the signature to one invite, so it cannot be replayed with another invite.                                                                                                                                    |
| `statement`                                    | Meaning of the signature. `confirm` = "I have seen this entry as shown". Other codes may be added in later versions.                                                                                                |
| `witness_name`                                 | 1–80 code points, Unicode **NFC**, no leading/trailing space, no control characters. The browser normalizes before signing; the server rejects other forms instead of normalizing, which would break the signature. |
| `witness_pub`, `alg`                           | Binds the message to its key and algorithm (no key or algorithm substitution).                                                                                                                                      |
| `signed_client_time`                           | The witness device's clock. A **claim only**: never used as evidence time and not checked for skew (cheap phones often have wrong clocks). The authoritative time is the cosign entry's `created_at`.               |

Algorithms (WebCrypto):

| `alg`     | When                                                | `witness_pub` (raw, base64url)                | Signature (base64url)                     |
| --------- | --------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| `Ed25519` | Preferred, used whenever the browser supports it.   | 32 bytes                                      | 64 bytes                                  |
| `ES256`   | Fallback for browsers without Ed25519 in WebCrypto. | 65-byte uncompressed P-256 point (`0x04‖x‖y`) | 64 bytes, raw `r‖s` (IEEE P1363), SHA-256 |

base64url is strict: no padding, and it must re-encode to the same string. ES256 signatures are malleable
(`(r, s)` and `(r, n−s)` both verify); this does not matter here because the signature is fixed inside a hashed entry.

### 4.2 The cosign entry

The server takes the target and invite from its own records (never from the request), adds the witness's
`alg`, `witness_pub`, `witness_name`, `signed_client_time` and `signature`, verifies the signature, and appends an
entry of type `witness_cosign` to the same ledger. Its payload has **exactly** these fields (a verifier rejects
any extra field, because it would not be covered by the signature):

```json
{
  "invite_id": "…",
  "target_seq": 3,
  "target_entry_hash": "…",
  "statement": "confirm",
  "witness_name": "Siti Rahayu",
  "witness_pub": "…",
  "alg": "Ed25519",
  "signed_client_time": "2026-11-03T08:00:00.000Z",
  "signature": "…"
}
```

The signed message is rebuilt from the payload plus the entry's `ledger_id`. `author_ref` is `witness:` followed by
the lowercase hex SHA-256 of the decoded `witness_pub` bytes. Marking the invite as used happens in the same
database transaction as the append, under the ledger lock, so two parallel signatures with one token produce exactly
one cosign entry.

### 4.3 Witness receipt

After signing, the witness can download a receipt ("bukti saya"), their own independent copy:

```json
{
  "format": "papertrail.witness-receipt/0.1",
  "signed_message": { "…the §4.1 object…": "…" },
  "signature": "…",
  "cosign_entry": {
    "v": 1,
    "ledger_id": "…",
    "seq": 4,
    "type": "witness_cosign",
    "created_at": "…",
    "author_ref": "…",
    "payload_hash": "…",
    "prev_hash": "…",
    "entry_hash": "…"
  },
  "target_entry": { "seq": 3, "entry_hash": "…" }
}
```

With the receipt alone anyone can check the signature over `signed_message`. Because `cosign_entry.entry_hash`
commits (through `prev_hash`) to the whole chain before it, a later pack that lacks this hash at this `seq`
proves the history was rewritten (THREAT_MODEL §4.2). The private key is not in the receipt; it is discarded.

### 4.4 What the signature does and does not prove

It proves: whoever held the link (and the key generated at that moment) stated `confirm` for this exact
`target_entry_hash` in this ledger, and the server cannot fabricate or move that statement later without the key.
It does **not** prove who the witness is, that the witness is independent of the owner, or that the entry's content
is true. Identity binding is **[OPEN]**.

## 5. Anchor (RFC 3161)

An **anchor** pins the chain head to a time attested by an external Time-Stamping Authority (TSA).

### 5.1 What is timestamped

The **data** given to the TSA is the head entry's canonical envelope, the same bytes whose SHA-256 is its
`entry_hash` (§2.2):

```
data            = UTF-8( JCS(envelope of entry head_seq) )
messageImprint  = { hashAlgorithm: sha256, hashedMessage: SHA256(data) }  =  head_hash
anchor_digest   = head_hash
```

So the imprint is simply `head_hash`. Nothing new is hashed, and anyone can check an anchor with standard
tools and no Paper Trail code: write the envelope JCS to a file and run
`openssl ts -verify -data envelope.json -in token.der -token_in -CAfile tsa-roots.pem`.

Why not `SHA256(JCS({v, ledger_id, head_seq, head_hash}))` (v0.3) or `SHA256(bytes(head_hash))` (a later proposal)?
`head_hash` already commits to `ledger_id`, `seq` and, through `prev_hash`, the whole history, so wrapping or
re-hashing it adds no security. Both alternatives would also make the timestamped "data" something that exists only
to be timestamped, which standard verifiers cannot reproduce from the entry itself.

Because every entry commits to its predecessor, one anchor covers entries `0 … head_seq`. Only the 32-byte imprint is
sent to the TSA; no ledger content leaves the system.

Each request carries a random 64-bit `nonce` and `certReq = true`. A response is accepted only if all of these hold
(apps/worker `validateTimeStampResponse`):

1. `PKIStatus` is `granted` (0) or `grantedWithMods` (1). `waiting` (3) is retried; anything else is a refusal.
2. The token is CMS `SignedData` whose content is a `TSTInfo` (`id-ct-TSTInfo`).
3. `messageImprint` is SHA-256 and equals the imprint we sent; `nonce` equals our nonce.
4. `genTime` is within 10 minutes of the worker's clock.
5. The CMS signature verifies with the certificate embedded in the token; the signed attributes include an ESS
   signing-certificate attribute (RFC 5035 v2, or RFC 2634 v1) whose hash matches that certificate (RFC 3161 §2.4.2).
6. The certificate was valid at `genTime` and has a critical extended key usage `id-kp-timeStamping`.
7. If trust anchors are configured (`TSA_CA_CERTS`), the certificate chains to one of them.

### 5.2 What is stored

| Field (database `anchors`)                             | Exported as (§6)                     | Description                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `ledger_id`, `anchored_head_seq`, `anchored_head_hash` | `ledger_id`, `head_seq`, `head_hash` | The anchored head. Unique per (`ledger_id`, `head_seq`).                                                                     |
| `anchor_digest`                                        | `anchor_digest`                      | The imprint; equal to `head_hash` (§5.1).                                                                                    |
| `tst_token`                                            | `tst`                                | The RFC 3161 `TimeStampToken` (CMS `ContentInfo`, DER; base64url when exported). Includes `genTime` and the TSA certificate. |
| `tst_gen_time`                                         | –                                    | `genTime` copied out for queries. The token is authoritative.                                                                |
| `tsa_url`                                              | `tsa_label`                          | Which configured TSA answered (credentials stripped). Informational, not trusted.                                            |
| `status`, `attempts`, `last_error`                     | –                                    | Operational state: `pending`, `ok` (frozen by a trigger), or `failed`.                                                       |

TSA endpoints come from configuration (`TSA_URLS`, a fallback list tried in order) and are never hard-coded.
Choosing providers is **[OPEN]** (OPEN_DECISIONS D1).

### 5.3 What an anchor proves

Entries `0 … head_seq`, with exactly these hashes, existed **no later than** the token's `genTime`. It proves
nothing about entries after `head_seq`, and nothing about how much earlier than `genTime` they were made
(§8 step 9 spells out how `created_at` is checked against this bound).

## 6. Evidence pack (JSON)

A single JSON file that the owner exports and anyone can verify offline.

```json
{
  "format_version": "0.1",
  "generated_at": "2026-11-02T12:00:00.000Z",
  "generator": { "name": "paper-trail", "version": "0.0.0" },
  "ledger": { "id": "6f1c0a52-…", "title": "Sengketa lembur Okt 2026" },
  "head": { "seq": 12, "hash": "…64 hex…" },
  "entries": [{ "…envelope…": "…", "entry_hash": "…", "payload": {} }],
  "anchors": [{ "…anchor record…": "…" }],
  "disclosure": { "payloads_included": [0, 3, 5], "files_included": [] }
}
```

Rules:

- `format_version` is a string. A verifier MUST reject an unknown major version with `FORMAT_UNSUPPORTED`.
- `entries` MUST contain **every** entry from `seq 0` to `head.seq`, in order. The pack is never a partial
  range, because the chain cannot be verified from the middle.
- `payload` is optional per entry. The owner chooses which payloads to disclose; for the rest the envelope
  (with `payload_hash`) is still present, so the chain verifies without revealing content. The envelope itself
  always reveals `type`, `created_at` and entry count; the export UI MUST say so.
- `ledger.title` is optional and not hashed. It is a convenience label and carries no evidentiary weight.
- Files are referenced by `content_sha256`. Bundling file bytes (for example in a zip next to the JSON) is **[OPEN]**.
- The pack is a snapshot. It proves nothing about entries made after `generated_at`.

## 7. Result codes

Verification returns a `verdict` plus a list of findings. Each finding has a `code`, a `severity`
(`info`, `warning` or `error`), an optional `seq`, and human-readable `detail`.

| Code                      | Severity | Meaning                                                                                                                                                                   |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_OK`                | info     | Hash chain is intact from `seq 0` to head. Emitted only when no chain-level error exists.                                                                                 |
| `PACK_MALFORMED`          | error    | Not valid JSON, missing required fields, or fields of the wrong type/format (for example uppercase hex).                                                                  |
| `FORMAT_UNSUPPORTED`      | error    | Unknown `format_version`.                                                                                                                                                 |
| `GENESIS_INVALID`         | error    | First entry does not have `seq 0` with an all-zero `prev_hash`, or is a `witness_cosign`.                                                                                 |
| `SEQ_GAP`                 | error    | Missing or duplicated `seq` (`seq` is not previous + 1). `seq` = first offending entry.                                                                                   |
| `LEDGER_MISMATCH`         | error    | An entry's `ledger_id` differs from the pack's ledger.                                                                                                                    |
| `BROKEN_AT_SEQ`           | error    | `prev_hash` does not equal the previous `entry_hash`, or `entry_hash` does not recompute. `seq` = first break. `detail` states which.                                     |
| `PAYLOAD_HASH_MISMATCH`   | error    | A disclosed `payload` does not hash to `payload_hash`.                                                                                                                    |
| `TIME_REGRESSION`         | error    | `created_at` decreases between consecutive entries.                                                                                                                       |
| `HEAD_MISMATCH`           | error    | `head.seq`/`head.hash` differ from the last entry.                                                                                                                        |
| `WITNESS_SIG_INVALID`     | error    | A `witness_cosign` signature does not verify over the reconstructed message, or `author_ref` does not match the key.                                                      |
| `WITNESS_TARGET_MISMATCH` | error    | Cosign `target_entry_hash` ≠ actual hash at `target_seq`, or `target_seq` ≥ the cosign's own `seq`.                                                                       |
| `ANCHOR_INVALID`          | error    | An anchor fails a check. `detail` carries a sub-reason: `DIGEST_MISMATCH`, `HEAD_MISMATCH`, `SIGNATURE_INVALID`, `CERT_UNTRUSTED`, `IMPRINT_MISMATCH`, `TOKEN_MALFORMED`. |
| `ANCHOR_TIME_CONFLICT`    | error    | An entry covered by an anchor has `created_at` later than the anchor's `genTime`. Impossible for an honest server.                                                        |
| `NO_ANCHOR`               | warning  | The pack has no anchors, so the chain has no external time proof.                                                                                                         |
| `UNANCHORED_TAIL`         | warning  | Entries after the last anchor's `head_seq` have no external time proof. `seq` = first uncovered entry.                                                                    |
| `ANCHOR_UNVERIFIED`       | warning  | Anchor signature was not checked because no trusted TSA roots were configured in the verifier.                                                                            |

`verdict` is `OK` when there is no `error` finding, otherwise `FAILED`. Warnings never change the verdict
but MUST be displayed. User-facing wording (Indonesian): `CHAIN_OK` → "Rantai utuh"; `BROKEN_AT_SEQ` and
`SEQ_GAP` → "Terputus di entri X".

## 8. Verification algorithm

Input: an evidence pack; optional set of trusted TSA root certificates. Pure function, no network.
Stop collecting chain findings at the first chain error (later hashes depend on it), but still report
independent findings (anchors, witnesses) that can be evaluated.

1. **Parse.** Valid JSON, required fields present, all hashes match `^[0-9a-f]{64}$`, timestamps match the
   fixed format. Else `PACK_MALFORMED`. Check `format_version`, else `FORMAT_UNSUPPORTED`.
2. **Genesis.** `entries[0].seq == 0`, `prev_hash` is 64 zeros, type is not `witness_cosign`. Else `GENESIS_INVALID`.
3. **For each entry `i` in order:**
   1. `seq == i`, else `SEQ_GAP`.
   2. `ledger_id` equals the pack's `ledger.id` (or, for a bare chain, the ledger of entry 0), else `LEDGER_MISMATCH`.
   3. `prev_hash` equals `entries[i-1].entry_hash` (genesis for `i = 0`), else `BROKEN_AT_SEQ` (detail: link).
   4. Recompute `entry_hash` from the envelope with JCS + SHA-256; compare, else `BROKEN_AT_SEQ` (detail: hash).
   5. If `payload` is present, recompute `SHA256(JCS(payload))`; compare with `payload_hash`, else `PAYLOAD_HASH_MISMATCH`.
   6. `created_at >= entries[i-1].created_at`, else `TIME_REGRESSION`.
4. **Head.** `head` equals the last entry's `seq` and `entry_hash`, else `HEAD_MISMATCH`.
5. **Chain result.** If steps 1–4 produced no error, emit `CHAIN_OK`.
6. **Witnesses.** For each `witness_cosign` entry whose payload is disclosed: check `target_seq < seq` and
   `target_entry_hash == entries[target_seq].entry_hash` (else `WITNESS_TARGET_MISMATCH`); rebuild the §4.1
   message and verify the ECDSA signature with `witness_pub` (else `WITNESS_SIG_INVALID`); check `author_ref`
   equals `witness:` + SHA-256(`witness_pub`) (else `WITNESS_SIG_INVALID`). Undisclosed cosign payloads are
   reported as "not checkable", not as errors.
7. **Anchors.** For each anchor: `head_seq` exists and `head_hash == entries[head_seq].entry_hash`
   (`ANCHOR_INVALID`/`HEAD_MISMATCH`); check `anchor_digest == head_hash` (`DIGEST_MISMATCH`); parse the token and
   check `messageImprint` equals `head_hash` (`IMPRINT_MISMATCH`/`TOKEN_MALFORMED`); verify the CMS signature, the ESS
   signing-certificate attribute, the timeStamping key usage, and the certificate chain against trusted roots
   (`SIGNATURE_INVALID`/`CERT_UNTRUSTED`). Without trusted roots, skip the chain part and emit `ANCHOR_UNVERIFIED`.
8. **Coverage.** No anchors → `NO_ANCHOR`. Otherwise let `H` be the highest verified `head_seq`; if
   `H < head.seq` → `UNANCHORED_TAIL`.
9. **Time bound.** For each entry, take the earliest verified anchor with `head_seq >= seq`. If the entry's
   `created_at` is later than that anchor's `genTime` + 1 second + the token's `accuracy` → `ANCHOR_TIME_CONFLICT`.
   (Many TSAs report `genTime` in whole seconds while `created_at` has milliseconds; without this tolerance an honest
   anchor made in the same second would be flagged.) The usable guarantee for an entry is "existed no later than
   that `genTime` (± accuracy)"; `created_at` is the server's claim inside it. The worker refuses to store a token that
   would trip this check (server clock ahead of the TSA) and retries later.
10. **Verdict.** `OK` if no `error` finding, else `FAILED`.

## 9. Versioning

- Entry `v`, anchor `v`, and pack `format_version` evolve independently.
- A change that alters any hashed byte requires a new `v`. Old versions remain verifiable.
- `0.x` pack versions carry no stability promise.

## 10. Changes

**v0.4** (anchoring implemented; entry `v` stays `1`):

- The timestamped data is the head entry's JCS envelope, so `messageImprint = anchor_digest = head_hash` (§5.1).
  v0.3's `SHA256(JCS({v, ledger_id, head_seq, head_hash}))` is dropped; no anchors existed under it.
- Response validation rules, including the ESS signing-certificate attribute (§5.1).
- Stored anchor fields aligned with the database; `TSA_URLS` is a fallback list (§5.2).
- `ANCHOR_TIME_CONFLICT` tolerates 1 s of `genTime` precision plus the token's `accuracy` (§8 step 9).

**v0.3** (witness co-sign; entry `v` stays `1`, but cosign payloads from v0.2 drafts are not valid v0.3 payloads):

- Signed message (§4.1) now includes `v`, `invite_id`, `alg` and `signed_client_time`; `witness_name` is required.
- Algorithms: `Ed25519` preferred, `ES256` (ECDSA P-256) as fallback for browsers without Ed25519. v0.2 had ES256 only.
- Cosign payload (§4.2) has an exact field set; extra fields are invalid.
- Links put the token in the URL fragment; default expiry is 72 hours (was 7 days).
- Witness receipt format `papertrail.witness-receipt/0.1` (§4.3).
- `verifyChain` checks disclosed cosign payloads (§8 step 6) and stops at the first failure like other chain checks.

**v0.2** (no change to how any existing valid entry is hashed; entry `v` stays `1`):

- `author_ref` has a fixed grammar (§2.1) instead of being free-form.
- Payload numbers MUST be safe integers (§1); v0.1 only said "no floats".
- Server clock clamp: `created_at` never goes below the head's `created_at` (§1).
- `LEDGER_MISMATCH` for a bare chain is checked against entry 0 (§8 step 3.2).
- Verification of a chain is defined to stop at the first chain error; `brokenAtSeq` is the chain position
  (the expected `seq`) where it stopped.
- Appendix A adds a test vector.

## Appendix A. Test vector

Inputs: `ledger_id = 6f1c0a52-3d1e-4b0a-9f55-0c7d6a2e8b11`, `seq = 0`, `type = note`,
`created_at = 2026-11-02T11:20:00.000Z`, `author_ref = owner:9d2f4c1a`,
payload `{"text":"Atasan menolak membayar lembur."}`.

```
JCS(payload)  = {"text":"Atasan menolak membayar lembur."}
payload_hash  = c8c6d06f3e1cc1e4a1b01ea8ffe0ec652c596a6518c08fdce704ffddd404bedb

JCS(envelope) = {"author_ref":"owner:9d2f4c1a","created_at":"2026-11-02T11:20:00.000Z","ledger_id":"6f1c0a52-3d1e-4b0a-9f55-0c7d6a2e8b11","payload_hash":"c8c6d06f3e1cc1e4a1b01ea8ffe0ec652c596a6518c08fdce704ffddd404bedb","prev_hash":"0000000000000000000000000000000000000000000000000000000000000000","seq":0,"type":"note","v":1}
entry_hash    = a423b1287ae37ea5e0f675aad051408898f526a272cc8863f11d1177be723950
```

Reproduce without any Paper Trail code: `printf '%s' '<JCS string>' | shasum -a 256`.
`packages/chain` pins this vector in `chain.test.ts`.
