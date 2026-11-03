# Paper Trail Format Specification — Version 1.0

Status: **version 1.0**, the first complete format. The product is still pre-alpha; after 1.0, hashed bytes never
change without a new version number (§9). Changes from earlier drafts are in §10. Items marked **[OPEN]** are
decisions tracked in [OPEN_DECISIONS.md](OPEN_DECISIONS.md). MUST, SHOULD and MAY are used as in RFC 2119.

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
| `v`            | integer | Entry format version. `1`.                                                                                                                                                     |
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

Why not `SHA256(JCS({v, ledger_id, head_seq, head_hash}))` (an earlier draft) or `SHA256(bytes(head_hash))`?
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
(§8 step 10 spells out how `created_at` is checked against this bound). The same is true of a partial export (§6.2): an
anchor only helps if the anchored head entry is inside the pack.

## 6. Evidence pack

An **evidence pack** is what the owner hands to a legal aide, union or mediator. It is one JSON file, or a `.zip`
when attachments travel with it. Anyone can verify it offline (§8).

### 6.1 Structure

```json
{
  "format_version": "1.0",
  "generated_at": "2026-11-03T03:30:56.000Z",
  "generator": { "name": "paper-trail", "version": "0.0.0" },
  "ledger": { "id": "3b1f7a0e-…", "title": "Sengketa uang lembur", "category": "kerja" },
  "scope": {
    "from_seq": 0,
    "to_seq": 5,
    "first_prev_hash": "0000…0000",
    "requested_to_seq": 5,
    "ledger_head_seq": 5
  },
  "head": { "seq": 5, "hash": "…64 hex…" },
  "entries": [
    {
      "v": 1,
      "ledger_id": "…",
      "seq": 0,
      "type": "note",
      "created_at": "…",
      "author_ref": "…",
      "payload_hash": "…",
      "prev_hash": "…",
      "entry_hash": "…",
      "payload": { "text": "…" }
    }
  ],
  "witnesses": [
    {
      "entry_seq": 3,
      "target_seq": 1,
      "witness_name": "Budi",
      "alg": "Ed25519",
      "witness_pub": "…",
      "signature": "…",
      "signed_message": "{\"alg\":\"Ed25519\",…}"
    }
  ],
  "anchors": [
    {
      "v": 1,
      "ledger_id": "…",
      "head_seq": 5,
      "head_hash": "…",
      "anchor_digest": "…",
      "tsa_label": "https://tsa.example/tsr",
      "tst": "…base64url DER…",
      "certs": ["…"],
      "gen_time": "2026-11-03T03:30:56.000Z"
    }
  ],
  "disclosure": { "payloads_included": [0, 1, 2, 3, 4, 5], "files_included": ["…sha256…"] },
  "pack_hash": "…64 hex…"
}
```

| Field            | Rules                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format_version` | The string `"1.0"`. A verifier MUST reject any other value with `FORMAT_UNSUPPORTED`.                                                                                                                                                                                                                                                                               |
| `generated_at`   | Server time of export. A label, not evidence; it is covered by `pack_hash`.                                                                                                                                                                                                                                                                                         |
| `generator`      | Informational.                                                                                                                                                                                                                                                                                                                                                      |
| `ledger`         | `id` is required. `title` is omitted when the owner withholds it; `category` is one of `kerja`, `sewa`, `freelance`, `gig`, `lainnya`. Neither is hashed into the chain and neither carries evidentiary weight.                                                                                                                                                     |
| `scope`          | See §6.2. `entries` is exactly `from_seq … to_seq`, contiguous.                                                                                                                                                                                                                                                                                                     |
| `head`           | The **last entry in the pack** (`to_seq`), not necessarily the ledger's head.                                                                                                                                                                                                                                                                                       |
| `entries`        | Chain fields exactly as hashed (§2) plus `entry_hash`; `payload` only where disclosed (§6.4). No other fields (no database ids).                                                                                                                                                                                                                                    |
| `witnesses`      | A summary of every **disclosed** `witness_cosign` entry: the fields a reader needs, plus `signed_message`, the JCS string that was signed (§4.1). It MUST match what the cosign entries contain exactly; the verifier recomputes it.                                                                                                                                |
| `anchors`        | Confirmed anchors whose `head_seq` lies inside `from_seq … to_seq`. `tst` is the RFC 3161 token, DER, base64url (strict: no padding). `certs` lists the certificates found in the token, DER base64url, for human inspection; the token itself is what is verified. `gen_time` is the token's `genTime` at export, informational; verifiers read it from the token. |
| `disclosure`     | `payloads_included` lists, ascending, exactly the seqs that carry a `payload`. `files_included` lists sha256 values of files shipped in the zip (§6.5).                                                                                                                                                                                                             |
| `pack_hash`      | §6.3.                                                                                                                                                                                                                                                                                                                                                               |

Packs contain only JSON-safe values (§1): integers, strings, booleans, arrays, objects. No `null`, no floats.

**Offline verification needs the TSA's trust anchors.** A pack carries the TSA certificate (inside every token, because
the request sets `certReq`) but not the TSA's root. A verifier is given roots explicitly (`--roots`); without them it
checks signatures and everything else, and says that the certificate chain was not checked (`ANCHOR_UNVERIFIED`).

### 6.2 Selecting a range, and what a partial pack can and cannot prove

The owner may export all entries, a range of seqs, or a range of dates (resolved to seqs on the server). A pack for
`from_seq > 0` states `scope.first_prev_hash`, the `prev_hash` of its first entry, so the segment can still be hashed
and linked. `scope.requested_to_seq` is the last seq the owner asked for.

**Anchor bridge.** An anchor only covers entries up to its anchored head, and a verifier can only use it if that head
is inside the pack. So, unless the owner switches it off, a range that ends before the ledger's head is **extended**
with entries up to the nearest later confirmed anchor. Those extra entries (`seq > requested_to_seq`) are _bridge
entries_: envelope only, never a `payload`. They still reveal that the entries exist, their type and their time.

What a verifier can conclude from a partial pack:

| Statement                                                                         | From a partial pack?                                                                                          |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The entries shown form an unbroken, unaltered chain segment (`from_seq … to_seq`) | **Yes**                                                                                                       |
| Disclosed payloads are the ones that were hashed                                  | **Yes**                                                                                                       |
| Witness signatures on disclosed cosign entries are valid                          | **Yes**. If the target entry lies before `from_seq` the target hash is not checked; reported as an info note. |
| These entries existed no later than the anchor's `genTime`                        | **Yes, if** an anchored head is inside the pack (every entry up to it is covered)                             |
| `first_prev_hash` is the real hash of entry `from_seq − 1`                        | **No.** It is a claim. Only an anchor makes the segment as a whole hard to fabricate.                         |
| What entries `0 … from_seq − 1` contain, or that they exist                       | **No**                                                                                                        |
| That there are no further entries, or that no other ledger exists                 | **No** (also true of a full pack: it is "what the owner chose to show")                                       |
| The segment belongs at this position in this ledger                               | **No**, unless an anchor, a witness receipt or a head hash kept outside the system ties it down               |

A fabricated segment with an invented `first_prev_hash` verifies as an internally valid chain. This is not new (an
owner can fabricate a whole chain, THREAT_MODEL §3.2), but a partial pack makes it cheaper, so a verifier always
reports `PARTIAL_PACK` and, without an anchor, `NO_ANCHOR`. A pack that starts at seq 0 must have an all-zero
`first_prev_hash` and is checked against the genesis rules.

### 6.3 `pack_hash`

```
pack_hash = SHA256( JCS( the pack without the pack_hash field ) )
```

The hash covers every other byte of the pack, so key order and whitespace do not matter and any change to a value
changes it. **It is a checksum and an identifier, not a signature**: anyone who edits a pack can recompute it. Its
uses are (1) to name a pack ("the pack with hash …"); (2) to compare the pack with the hash printed in the PDF summary
(§6.6) or received through another channel, which exposes a swapped pack; and (3) to catch accidental corruption.
Real tamper-evidence comes from the chain and the anchors, which a verifier checks independently.

### 6.4 Disclosure

The owner chooses which payloads to disclose: all, none, or a list of seqs. An undisclosed entry still has its full
envelope with `payload_hash`, so the chain verifies, but a reader learns that the entry exists and its `type` and
`created_at`. The export UI MUST say so. Undisclosed `witness_cosign` payloads are not checkable, and are neither
listed in `witnesses` nor an error.

### 6.5 Attachments (zip)

With attachments the pack is a `.zip` containing `pack.json` (the pack, unchanged), `README.txt`, and
`files/<sha256>.<ext>` for each file of a disclosed `photo`/`file` entry (listed in `disclosure.files_included`).
A verifier recomputes the SHA-256 of every file and compares it with `content_sha256` in the entry
(`FILE_HASH_MISMATCH`); a listed file that is absent is `FILE_MISSING` (warning). File names inside the zip are not
trusted; only content hashes matter. Bundles are size-limited by the exporter and by the verifier.

### 6.6 PDF summary

`GET …/export.pdf` renders the same pack as a short Indonesian document: cover (title, period, number of entries, head
hash, time of the last anchor), a table of entries (seq, server time, type, summary, first 8 characters of the hash),
the witnesses, the anchors, a QR code to the verification page with the pack hash, and the neutral legal disclaimer.
The pack hash on its pages equals the JSON's only if both were built from the same selection and `generated_at`; the
export API lets a client pass `generated_at` (within the last 30 days) to rebuild an identical pack. The PDF is a
reading aid. It is not verified by the verifier and carries no more weight than the pack it summarises.

## 7. Result codes

Verification returns a `verdict`, a list of findings, and a summary. A finding has a `code`, a `severity`
(`info`, `warning`, `error`), an optional `seq`, an optional `reason` (for `ANCHOR_INVALID`) and a `detail`.
`verdict` is `OK` when there is no `error` finding, otherwise `FAILED`. Warnings never change the verdict but MUST be
shown. User-facing headline (Indonesian): no error → "Rantai utuh" (partial: "Rantai utuh pada rentang yang
diekspor"); chain error → "Terputus di entri X"; otherwise "Paket tidak lolos pemeriksaan".

| Code                       | Severity     | Meaning                                                                                                                                                                                              |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_OK`                 | info         | The chain (or segment) is intact. Emitted only when no chain-level error exists.                                                                                                                     |
| `PACK_MALFORMED`           | error        | Not a JSON object, a required field is missing or has the wrong type or format, or disclosure bookkeeping is inconsistent (including a payload on a bridge entry).                                   |
| `FORMAT_UNSUPPORTED`       | error        | `format_version` is not `1.0`.                                                                                                                                                                       |
| `PACK_HASH_MISMATCH`       | error        | `pack_hash` does not match the pack contents (§6.3).                                                                                                                                                 |
| `SCOPE_INVALID`            | error        | `scope` is inconsistent with `entries` (§6.2), or a pack from seq 0 has a non-zero `first_prev_hash`.                                                                                                |
| `GENESIS_INVALID`          | error        | Entry 0 has the wrong `prev_hash`, or is a `witness_cosign`, or the first entry is not seq 0 in a pack that claims to start there.                                                                   |
| `SEQ_GAP`                  | error        | Missing or duplicated `seq`. `seq` = first offending entry.                                                                                                                                          |
| `LEDGER_MISMATCH`          | error        | An entry's `ledger_id` differs from the others or from `ledger.id`.                                                                                                                                  |
| `BROKEN_AT_SEQ`            | error        | `prev_hash` does not equal the previous `entry_hash` (or `first_prev_hash`), or `entry_hash` does not recompute. `seq` = first break; `detail` says which.                                           |
| `PAYLOAD_HASH_MISMATCH`    | error        | A disclosed `payload` does not hash to `payload_hash`.                                                                                                                                               |
| `TIME_REGRESSION`          | error        | `created_at` decreases between consecutive entries.                                                                                                                                                  |
| `HEAD_MISMATCH`            | error        | `head` differs from the last entry.                                                                                                                                                                  |
| `WITNESS_SIG_INVALID`      | error        | A `witness_cosign` signature does not verify, or `author_ref` does not match the key.                                                                                                                |
| `WITNESS_TARGET_MISMATCH`  | error / info | Error: the cosign's `target_entry_hash` differs from the real hash of `target_seq`, or `target_seq ≥` its own seq. Info: the target lies before `from_seq` and was not checked.                      |
| `WITNESS_SUMMARY_MISMATCH` | error        | `witnesses[]` differs from what the disclosed cosign entries say.                                                                                                                                    |
| `ANCHOR_INVALID`           | error        | An anchor fails a check; `reason` is one of `HEAD_MISMATCH` (not inside the pack, or hash differs), `DIGEST_MISMATCH`, `TOKEN_MALFORMED`, `IMPRINT_MISMATCH`, `SIGNATURE_INVALID`, `CERT_UNTRUSTED`. |
| `ANCHOR_TIME_CONFLICT`     | error        | An entry is newer than the anchor that covers it, beyond the tolerance in §8 step 10. Impossible for an honest server.                                                                               |
| `FILE_HASH_MISMATCH`       | error        | A file in the zip does not match `content_sha256`.                                                                                                                                                   |
| `FILE_MISSING`             | warning      | A file listed in `files_included` is not in the zip.                                                                                                                                                 |
| `PARTIAL_PACK`             | warning      | The pack does not start at seq 0 and/or ends before the ledger's head when it was exported (§6.2).                                                                                                   |
| `NO_ANCHOR`                | warning      | No usable anchor: nothing in the pack is proven to have existed at a particular time.                                                                                                                |
| `UNANCHORED_TAIL`          | warning      | Entries after the last verified anchor have no external time proof. `seq` = first uncovered entry.                                                                                                   |
| `ANCHOR_UNVERIFIED`        | warning      | Tokens were checked without trusted TSA roots (certificate chain not verified), or not checked at all (no token verifier was used).                                                                  |

## 8. Verification algorithm

Input: a pack (and optionally its files, and trusted TSA roots). The function is pure and offline. Chain checking
stops at the first chain error, because every later hash depends on it; the pack-level findings before it are kept.

1. **Parse.** The input is a JSON object with the fields of §6.1, hashes match `^[0-9a-f]{64}$`, timestamps match §1.
   Otherwise `PACK_MALFORMED`. `format_version` must be `"1.0"` (`FORMAT_UNSUPPORTED`).
2. **Pack checksum.** Recompute `pack_hash` (§6.3); mismatch is `PACK_HASH_MISMATCH` (verification continues).
3. **Scope.** `to_seq = from_seq + len(entries) − 1`; `requested_to_seq` and `ledger_head_seq` are consistent;
   `first_prev_hash` is 64 zeros when `from_seq = 0`. Otherwise `SCOPE_INVALID`.
4. **Chain segment.** For each entry in order, with `seq = from_seq + i`:
   1. `entry.seq == seq`, else `SEQ_GAP` (`GENESIS_INVALID` for the first entry of a pack that claims to start at 0).
   2. First entry: `prev_hash == first_prev_hash`; from seq 0 also not a `witness_cosign` (`GENESIS_INVALID`,
      `BROKEN_AT_SEQ`).
   3. `ledger_id` equals the first entry's, else `LEDGER_MISMATCH`.
   4. `prev_hash` equals the previous `entry_hash`, else `BROKEN_AT_SEQ` (link).
   5. Recompute `entry_hash` (§2.2); mismatch is `BROKEN_AT_SEQ` (hash).
   6. A present `payload` hashes to `payload_hash` (§3), else `PAYLOAD_HASH_MISMATCH`.
   7. `created_at` is not earlier than the previous entry's, else `TIME_REGRESSION`.
   8. A disclosed `witness_cosign`: rebuild the §4.1 message and verify the signature (`WITNESS_SIG_INVALID`); check
      `author_ref` equals `witness:` + SHA-256(`witness_pub`) (`WITNESS_SIG_INVALID`); `target_seq` is below the
      entry's seq, and, if it is inside the pack, `target_entry_hash` equals that entry's hash
      (`WITNESS_TARGET_MISMATCH`); if it is before `from_seq`, record an info note instead.
5. **Chain result.** No error so far in steps 3–4 → `CHAIN_OK`. If the chain failed, stop here and report.
6. **Head and ledger.** `head` equals the last entry (`HEAD_MISMATCH`); `ledger.id` equals the entries' ledger
   (`LEDGER_MISMATCH`). If `from_seq > 0` or `to_seq < ledger_head_seq`, add `PARTIAL_PACK`.
7. **Disclosure.** `payloads_included` equals the seqs that carry a payload, and no bridge entry
   (`seq > requested_to_seq`) carries one (`PACK_MALFORMED`).
8. **Witness summaries.** Derive the summary of each disclosed cosign entry (§6.1) and compare it with `witnesses[]`
   (`WITNESS_SUMMARY_MISMATCH`).
9. **Anchors.** For each anchor: its `head_seq` is inside the pack and `head_hash`/`ledger_id` equal that entry's
   (`ANCHOR_INVALID`/`HEAD_MISMATCH`); `anchor_digest == head_hash` (`DIGEST_MISMATCH`); `tst` is present and strict
   base64url (`TOKEN_MALFORMED`). Then verify the token over `UTF-8(JCS(envelope of the head entry))` (§5.1): CMS
   `SignedData` over a `TSTInfo`; SHA-256 `messageImprint` equal to the digest (`IMPRINT_MISMATCH`); signature with the
   embedded certificate and the ESS signing-certificate attribute (`SIGNATURE_INVALID`); certificate valid at `genTime`
   with a critical `id-kp-timeStamping` key usage, and a path to a trusted root when roots are given
   (`CERT_UNTRUSTED`). Without roots the chain is unchecked: `ANCHOR_UNVERIFIED`. Without any token verifier, anchors
   are only checked structurally and reported as unverified.
10. **Coverage and time bound.** No usable anchor → `NO_ANCHOR`. Otherwise let `H` be the highest verified `head_seq`;
    if `H < to_seq`, `UNANCHORED_TAIL` at `H + 1`. For each entry take the earliest verified anchor with
    `head_seq ≥ seq`; if the entry's `created_at` is later than that anchor's `genTime` + 1 second + the token's
    `accuracy` → `ANCHOR_TIME_CONFLICT`. (Many TSAs report `genTime` in whole seconds while `created_at` has
    milliseconds.) The usable guarantee is "existed no later than that `genTime` (± accuracy)".
11. **Attachments** (zip only). §6.5.
12. **Verdict.** `OK` if no finding has severity `error`, otherwise `FAILED`.

The summary also reports: entries, `from_seq`, `to_seq`, whether the pack starts at genesis, whether the chain is
intact, witnesses verified, anchors verified, and the highest entry covered by a verified anchor.

## 9. Versioning

- `format_version` (pack), entry `v`, and anchor `v` evolve independently.
- After 1.0, any change that alters a hashed byte requires a new entry or anchor `v`, and old versions remain
  verifiable. A pack change that older verifiers cannot read increments the major version of `format_version`; a
  backwards-compatible addition increments the minor. A verifier rejects a pack with an unknown major version.
- `pack_hash` is defined over the pack of its own version.

## 10. Changes

**v1.0** (evidence pack; entry `v` stays `1`):

- New §6: pack structure, `scope` with `first_prev_hash` for partial exports, the anchor bridge, `pack_hash`, disclosure,
  zip attachments, PDF summary. The pack's `format_version` is now `"1.0"`; earlier `0.x` packs were never produced.
- `anchors[]` carry `certs` and `gen_time` (replacing the unused `requested_at`); `ledger` carries `category`.
- `witnesses[]` summary added; must match the cosign entries.
- Verification (§8) works on segments, checks `pack_hash`, witness summaries, disclosure bookkeeping and attachments;
  new codes `PACK_HASH_MISMATCH`, `SCOPE_INVALID`, `WITNESS_SUMMARY_MISMATCH`, `FILE_HASH_MISMATCH`, `FILE_MISSING`,
  `PARTIAL_PACK`. `WITNESS_TARGET_MISMATCH` has an info form for targets outside a partial pack.
- Verification of an anchor's token moved into the shared `packages/verifier`.
- Editorial: removed `[OPEN]` markers that were resolved (witness algorithms, zip bundling) and renumbered §6–§10.

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

## Appendix B. Example packs

`docs/examples/` holds packs built from fictional data (see its README): a full pack, a partial pack bridged to an
anchor, the same full pack as a zip with its file, and the PDF summary. Their anchors come from a local **mock** TSA
and its throwaway root (`example-tsa-root.pem`), so they demonstrate the format and the verifier but prove nothing about
real time. Verify offline:

```bash
papertrail-verify docs/examples/example-pack.json --roots docs/examples/example-tsa-root.pem
```
