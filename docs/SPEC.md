# Paper Trail Format Specification — Draft v0.1

Status: **draft, pre-alpha**. Nothing here is frozen. Items marked **[OPEN]** are decisions
tracked in [OPEN_DECISIONS.md](OPEN_DECISIONS.md). The key words MUST, SHOULD and MAY are used as in RFC 2119.

This document defines what is hashed, signed, anchored and exported, and how a third party verifies it.
It is written so that `packages/chain` and `packages/verifier` can be implemented from it alone.

> Paper Trail helps show that a record was not changed after it was made and when it existed.
> It is not legal advice and does not guarantee acceptance as evidence. See [THREAT_MODEL.md](THREAT_MODEL.md).

## 1. Conventions

| Topic          | Rule                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical JSON | JCS, RFC 8785. Hashed objects MUST NOT contain floating-point numbers, `null`, or duplicate keys. Only integers (`v`, `seq`, `size`) are numeric.             |
| Hash           | SHA-256 over the UTF-8 bytes of the canonical form.                                                                                                           |
| Hash encoding  | 64 characters, lowercase hex. Never uppercase, never prefixed.                                                                                                |
| Timestamps     | `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, millisecond precision, always `Z`). Always assigned by the server. A client-supplied time is never stored in a hashed field. |
| Text           | Free text is normalized to Unicode NFC by the server before hashing. The hash covers the stored, normalized value.                                            |
| IDs            | `ledger_id` is a lowercase UUID string.                                                                                                                       |
| Binary         | Binary values inside JSON (keys, signatures, DER) are base64url without padding.                                                                              |

## 2. Ledger and entry

A **ledger** is one append-only chain owned by one user (for example, one dispute). Entries are numbered by
`seq`, starting at `0`, with no gaps.

### 2.1 Entry envelope (the hashed part)

| Field          | Type    | Description                                                                                                                |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `v`            | integer | Entry format version. `1` in this draft.                                                                                   |
| `ledger_id`    | string  | UUID of the ledger. Binding it into the hash prevents splicing an entry into another ledger.                               |
| `seq`          | integer | Position in the ledger. `0` for the first entry. Each next entry is exactly previous `seq + 1`.                            |
| `type`         | string  | One of `note`, `photo`, `file`, `witness_cosign` (see §3).                                                                 |
| `created_at`   | string  | Server time of creation.                                                                                                   |
| `author_ref`   | string  | Opaque pseudonymous reference to the author: `owner:<id>` or `witness:<key-fingerprint>`. MUST NOT contain email or phone. |
| `payload_hash` | string  | SHA-256 of the canonical payload (see §3). Lets an export hide a payload while keeping the chain verifiable.               |
| `prev_hash`    | string  | `entry_hash` of entry `seq - 1`. For `seq = 0`, the genesis value (§2.3).                                                  |

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

A witness has no account. The owner creates a one-time link for one target entry. The link carries a random
256-bit token. The server stores only `SHA256(token)`; the plaintext token exists only in the link. The link
expires (default 7 days) and works once.

The witness's browser generates a fresh key pair (ECDSA P-256 via WebCrypto; **[OPEN]** vs Ed25519). The
private key never leaves the browser. The witness sees the target entry (the owner chose to share it),
optionally types a name (self-declared, ≤ 80 characters, not verified), and presses confirm.

### 4.1 What is signed

The signed message is the JCS encoding of this object:

```json
{
  "purpose": "papertrail.witness.cosign.v1",
  "ledger_id": "…",
  "target_seq": 3,
  "target_entry_hash": "…64 hex…",
  "statement": "confirm",
  "witness_name": "Budi",
  "witness_pub": "…base64url…"
}
```

- `statement` is a code: `confirm` ("I saw this entry as shown"). More codes may be added.
- `witness_name` is omitted if the witness gave none.
- `witness_pub` is the uncompressed P-256 public point (65 bytes), base64url.
- No client timestamp is signed. Time comes from the entry that carries the signature.

Signature: ECDSA P-256 with SHA-256 over the JCS bytes, raw `r || s` (64 bytes), base64url.

### 4.2 The cosign entry

The server verifies the signature, then appends an entry of type `witness_cosign` to the same ledger with this payload:

```json
{
  "target_seq": 3,
  "target_entry_hash": "…",
  "statement": "confirm",
  "witness_name": "Budi",
  "witness_pub": "…",
  "signature": "…base64url…"
}
```

`author_ref` is `witness:` followed by the lowercase hex SHA-256 of the decoded `witness_pub` bytes.

### 4.3 Witness receipt

After signing, the witness receives a receipt: the cosign entry's `seq`, `entry_hash`, and `created_at`. The
witness SHOULD keep it (screenshot, share to chat). It is an independent copy of a chain position, which limits
what a dishonest server can later change (see THREAT_MODEL §4.2).

### 4.4 What the signature does and does not prove

It proves: whoever held the link and the generated key confirmed this exact `target_entry_hash` in this
ledger, and the server cannot fabricate that confirmation later without that key.
It does **not** prove who the witness is, nor that the witness is independent of the owner. Identity binding
is **[OPEN]**.

## 5. Anchor (RFC 3161)

An **anchor** pins the chain head to a time attested by an external Time-Stamping Authority (TSA).

### 5.1 What is hashed

```
anchor_digest = SHA256( JCS({ v, ledger_id, head_seq, head_hash }) )     // v = 1
```

`head_hash` is the `entry_hash` of entry `head_seq`. Because every entry commits to its predecessor, one
anchor covers entries `0 … head_seq`. Only `anchor_digest` is sent to the TSA, as the `messageImprint` of an
RFC 3161 `TimeStampReq` with `hashAlgorithm = sha256`. No ledger content or ID leaves the system.

### 5.2 What is stored

| Field           | Description                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `v`             | `1`                                                                                             |
| `ledger_id`     | Anchored ledger.                                                                                |
| `head_seq`      | Sequence number of the anchored head.                                                           |
| `head_hash`     | Hash of the anchored head.                                                                      |
| `anchor_digest` | The value sent to the TSA.                                                                      |
| `tsa_label`     | Human-readable TSA name from configuration (informational, not trusted).                        |
| `tst`           | The RFC 3161 `TimeStampToken` (CMS `SignedData`, DER), base64url. Includes the TSA's `genTime`. |
| `certs`         | TSA certificate chain as DER base64url, if not already inside `tst`.                            |
| `requested_at`  | Server time of the request (informational; the authoritative time is `genTime` inside `tst`).   |

The TSA URL comes from configuration (`TSA_URL`) and is never hard-coded. Choosing a TSA is **[OPEN]**.

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
   2. `ledger_id` equals the pack's `ledger.id`, else `LEDGER_MISMATCH`.
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
   (`ANCHOR_INVALID`/`HEAD_MISMATCH`); recompute `anchor_digest` (`DIGEST_MISMATCH`); parse the token and check
   `messageImprint` equals `anchor_digest` (`IMPRINT_MISMATCH`/`TOKEN_MALFORMED`); verify the CMS signature
   and certificate chain against trusted roots (`SIGNATURE_INVALID`/`CERT_UNTRUSTED`). Without trusted roots,
   skip the signature part and emit `ANCHOR_UNVERIFIED`.
8. **Coverage.** No anchors → `NO_ANCHOR`. Otherwise let `H` be the highest verified `head_seq`; if
   `H < head.seq` → `UNANCHORED_TAIL`.
9. **Time bound.** For each entry, take the earliest verified anchor with `head_seq >= seq`. If the entry's
   `created_at` is later than that anchor's `genTime` → `ANCHOR_TIME_CONFLICT`. The usable guarantee for an
   entry is therefore "existed no later than that `genTime`"; `created_at` is the server's claim inside it.
10. **Verdict.** `OK` if no `error` finding, else `FAILED`.

## 9. Versioning

- Entry `v`, anchor `v`, and pack `format_version` evolve independently.
- A change that alters any hashed byte requires a new `v`. Old versions remain verifiable.
- `0.x` pack versions carry no stability promise.
