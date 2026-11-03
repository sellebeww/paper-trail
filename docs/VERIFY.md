# Verifying a Paper Trail evidence pack without Paper Trail

An evidence pack is a single JSON file (or a zip holding `pack.json` and the attached files). Everything needed to check
it is inside the pack, except one thing you must get yourself: the **root certificate of the time-stamping authority
(TSA)** that issued its anchors. This guide checks a pack with nothing but **Python 3** (standard library) and
**OpenSSL 3**. Our own tools are not needed, and neither are an account or a network connection. The format is
specified in [SPEC.md](SPEC.md); this guide follows its verification algorithm (§8).

> Paper Trail helps prove that records were not changed after they were made and when they existed. It is not legal
> advice and does not guarantee acceptance as evidence. Consult a legal adviser.

## What you need

| Item                        | Where it comes from                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pack.json`                 | The person who gave you the evidence. From a `.zip`, unzip it: `pack.json` plus `files/`.                                  |
| TSA root certificate        | **From the TSA itself** (its website or policy), never from the pack's sender. `anchors[].tsa_label` says which TSA it is. |
| Python ≥ 3.8, OpenSSL ≥ 3.0 | `python3 --version`, `openssl version`.                                                                                    |

The commands below use the fictional pack in [examples/](examples/README.md). Its anchors come from a **mock** TSA whose
root is `examples/example-tsa-root.pem`; with a real pack, use the real TSA's root instead.

## Step 1: the chain and the pack checksum (script)

Save this as `verify_pack.py` (it is short enough to read before you run it):

```python
#!/usr/bin/env python3
"""Checks a Paper Trail evidence pack (SPEC 1.0) with the Python standard library only.

Checks the pack_hash, every entry hash and link, and the payload hashes. For each anchor and each
witness signature it writes the files that the openssl commands in docs/VERIFY.md check.
Usage: python3 verify_pack.py pack.json [out-dir]
"""
import base64, hashlib, json, os, sys

def jcs(v):
    # RFC 8785 for what a pack contains (objects, arrays, strings, integers, booleans; ASCII keys).
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

def sha(b):
    return hashlib.sha256(b).hexdigest()

def b64url(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def der_int(b):
    b = b.lstrip(b"\0") or b"\0"
    if b[0] & 0x80:
        b = b"\0" + b
    return b"\x02" + bytes([len(b)]) + b

def pem(der):
    body = base64.b64encode(der).decode()
    lines = [body[i:i + 64] for i in range(0, len(body), 64)]
    return "-----BEGIN PUBLIC KEY-----\n" + "\n".join(lines) + "\n-----END PUBLIC KEY-----\n"

def write(name, data):
    with open(os.path.join(out, name), "wb") as f:
        f.write(data)

pack = json.load(open(sys.argv[1], encoding="utf-8"))
out = sys.argv[2] if len(sys.argv) > 2 else "."
os.makedirs(out, exist_ok=True)
problems = []

if pack.get("format_version") != "1.0":
    sys.exit(f"format_version {pack.get('format_version')!r} is not 1.0")
rest = {k: v for k, v in pack.items() if k != "pack_hash"}
if sha(jcs(rest)) != pack["pack_hash"]:
    problems.append("pack_hash does not match the pack contents")

ENVELOPE = ["v", "ledger_id", "seq", "type", "created_at", "author_ref", "payload_hash", "prev_hash"]
prev = pack["scope"]["first_prev_hash"]
for i, e in enumerate(pack["entries"]):
    seq = pack["scope"]["from_seq"] + i
    envelope = jcs({k: e[k] for k in ENVELOPE})
    if e["seq"] != seq:
        problems.append(f"entry {seq}: seq is {e['seq']} (an entry is missing or out of order)")
        break
    if e["prev_hash"] != prev:
        problems.append(f"entry {seq}: prev_hash does not match the previous entry_hash")
        break
    if sha(envelope) != e["entry_hash"]:
        problems.append(f"entry {seq}: entry_hash does not match the envelope")
        break
    if "payload" in e and sha(jcs(e["payload"])) != e["payload_hash"]:
        problems.append(f"entry {seq}: payload does not match payload_hash")
        break
    prev = e["entry_hash"]
    write(f"entry-{seq}.envelope.json", envelope)  # the exact bytes an anchor timestamps (SPEC 5.1)
    if e["type"] == "witness_cosign" and "payload" in e:
        p = dict(e["payload"])
        sig = b64url(p.pop("signature"))
        pub = b64url(p["witness_pub"])
        if e["author_ref"] != "witness:" + sha(pub):
            problems.append(f"entry {seq}: author_ref is not the witness key")
        target = p["target_seq"] - pack["scope"]["from_seq"]
        if 0 <= target < i and pack["entries"][target]["entry_hash"] != p["target_entry_hash"]:
            problems.append(f"entry {seq}: the witness signed a different entry {p['target_seq']}")
        write(f"witness-{seq}.msg", jcs({**p, "v": 1, "purpose": "papertrail.witness.cosign.v1",
                                         "ledger_id": e["ledger_id"]}))
        if p["alg"] == "Ed25519":
            key = bytes.fromhex("302a300506032b6570032100") + pub
        else:  # ES256: P-256 SubjectPublicKeyInfo, and the raw r||s signature re-encoded as DER
            key = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200") + pub
            body = der_int(sig[:32]) + der_int(sig[32:])
            sig = b"\x30" + bytes([len(body)]) + body
        write(f"witness-{seq}.sig", sig)
        write(f"witness-{seq}.pub.pem", pem(key).encode())
        print(f"witness on entry {seq} ({p['alg']}, {p['witness_name']}): witness-{seq}.*")

for a in pack["anchors"]:
    write(f"anchor-{a['head_seq']}.tst", b64url(a["tst"]))
    print(f"anchor on entry {a['head_seq']}: anchor-{a['head_seq']}.tst")

print("\n".join(problems) if problems else f"OK: pack_hash and {len(pack['entries'])} entries match")
sys.exit(1 if problems else 0)
```

Run it:

```bash
python3 verify_pack.py docs/examples/example-pack.json out
# witness on entry 3 (Ed25519, Budi (contoh)): witness-3.*
# anchor on entry 3: anchor-3.tst
# anchor on entry 5: anchor-5.tst
# OK: pack_hash and 6 entries match
```

What it checks (SPEC §2, §3, §6.3, §8 steps 1–4):

- `pack_hash` is SHA-256 of the canonical JSON (RFC 8785, "JCS") of the pack without `pack_hash`. It is only a
  checksum: anyone who edits a pack can recompute it. Use it to compare with the hash printed on the PDF summary or sent
  to you separately.
- Each `entry_hash` is SHA-256 of the JCS of the entry's eight envelope fields; each `prev_hash` is the previous entry's
  `entry_hash` (the first equals `scope.first_prev_hash`, all zeros for a pack that starts at entry 0); `seq` has no
  gaps; a disclosed `payload` hashes to `payload_hash`. **Changing, deleting, inserting or reordering any entry breaks
  this**, and the script names the first entry where it breaks.
- For a witness co-sign: `author_ref` is `witness:` + SHA-256 of the witness's raw public key, and the entry the witness
  signed is the entry in the pack.

It also writes the files that the next steps check with OpenSSL: `entry-N.envelope.json` (the exact bytes whose SHA-256
is entry N's hash, which are also what a TSA timestamps), `anchor-N.tst` (the RFC 3161 token, DER) and `witness-N.*`.

About canonical JSON: `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)` equals RFC 8785 for the
values a pack contains (strings, integers, booleans, objects with ASCII keys; payloads never contain floats or `null`,
SPEC §3). A general-purpose verifier should use a real JCS library.

## Step 2: the time-stamp anchors (OpenSSL)

An anchor is an RFC 3161 time-stamp token over the head entry's envelope (SPEC §5.1). Check each one against the TSA
root you obtained (here the example root):

```bash
cd out
openssl ts -verify -data entry-5.envelope.json -in anchor-5.tst -token_in -CAfile ../docs/examples/example-tsa-root.pem
# Verification: OK
openssl ts -verify -data entry-3.envelope.json -in anchor-3.tst -token_in -CAfile ../docs/examples/example-tsa-root.pem
# Verification: OK
```

This checks that the token's message imprint is SHA-256 of that envelope (which equals the entry's `entry_hash`), that
the TSA's signature is valid, and that the TSA certificate chains to the root you gave. A token moved from another entry
fails with `message imprint mismatch`. Then read the time:

```bash
openssl ts -reply -in anchor-5.tst -token_in -text | grep -E 'Time stamp|Accuracy'
# Time stamp: Nov  3 03:30:56 2026 GMT
# Accuracy: 0x01 seconds, unspecified millis, unspecified micros
```

A valid anchor on entry N means that entries 0…N, exactly as they are in the pack, **existed no later than** that time
(± accuracy). Two more checks to do by eye (SPEC §8 step 10):

- No entry covered by an anchor may have a `created_at` later than the anchor's time + 1 second + accuracy.
- Entries after the last anchor have **no external time proof**: their `created_at` is only the server's claim.

Do not skip `-CAfile`: a signature checked only against the certificate inside the token proves nothing, because anyone
can make a certificate.

## Step 3: witness signatures (OpenSSL)

A witness signs the JCS message of SPEC §4.1 with a key created on their own device. For `Ed25519`:

```bash
openssl pkeyutl -verify -pubin -inkey witness-3.pub.pem -rawin -in witness-3.msg -sigfile witness-3.sig
# Signature Verified Successfully
```

For `ES256` (P-256) the script has already converted the signature to DER:

```bash
openssl dgst -sha256 -verify witness-3.pub.pem -signature witness-3.sig witness-3.msg
# Verified OK
```

A valid signature means that whoever held that key confirmed that exact entry. It does **not** prove who that person
is: the name is typed by the witness and the key is not tied to an identity. A changed name or target makes the
signature fail.

## Step 4: attachments (zip only)

Each `photo` or `file` entry commits to its file through `content_sha256`. Hash the files and compare:

```bash
shasum -a 256 files/*      # or: sha256sum files/*
```

Every hash must equal the `content_sha256` of a disclosed entry. File names inside the zip are not trusted, only hashes.

## Reading the result

| Check             | If it passes                                          | What it does not prove                                                    |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Chain             | No entry was changed, removed, inserted or reordered. | That the content is true, or that the owner recorded everything.          |
| `pack_hash`       | The file is the one the hash names.                   | Authenticity (anyone can recompute it).                                   |
| Anchor on entry N | Entries 0…N existed no later than the TSA's time.     | Anything about entries after N, or how much earlier entries were written. |
| Witness signature | The key holder confirmed that entry.                  | The witness's identity.                                                   |
| Attachment        | The file is the one the entry committed to.           | Where the file came from, or when it was made beyond the entry's anchor.  |

A partial pack (`scope.from_seq` above 0, or `scope.to_seq` below `scope.ledger_head_seq`) proves only the exported
range, and its `first_prev_hash` is unproven (SPEC §6.2).

## Writing your own verifier

[SPEC.md](SPEC.md) §8 is the full algorithm and §7 lists the result codes. To test an implementation, use the
conformance packs in [`packages/verifier/fixtures/`](../packages/verifier/fixtures): each file is a pack, and
[`expected.json`](../packages/verifier/fixtures/expected.json) says what a correct verifier must report for it (use
`docs/examples/example-tsa-root.pem` as the TSA root). The tampered packs are resealed, as a forger would do, so it is
the chain, signature or anchor check that catches them, not `pack_hash`:

| Fixture                | Tampering                                         | Caught by                        |
| ---------------------- | ------------------------------------------------- | -------------------------------- |
| `valid.json`           | none                                              | (passes)                         |
| `entry-modified.json`  | the text of entry 1 changed                       | Step 1 (`PAYLOAD_HASH_MISMATCH`) |
| `entry-deleted.json`   | entry 4 removed and the scope adjusted            | Step 1 (`SEQ_GAP`)               |
| `fake-witness.json`    | witness name changed, every later hash recomputed | Step 3 (`WITNESS_SIG_INVALID`)   |
| `fake-anchor.json`     | the anchor on entry 5 carries entry 3's token     | Step 2 (`ANCHOR_INVALID`)        |
| `wrong-pack-hash.json` | `pack_hash` belongs to other content              | Step 1 (`PACK_HASH_MISMATCH`)    |
| `unknown-version.json` | `format_version` is 2.0                           | Step 1 (`FORMAT_UNSUPPORTED`)    |

## Our tools (optional)

The same checks, automated: the CLI `npx paper-trail-verify pack.json --roots tsa-root.pem` (add `--json` for
machine-readable output), and the public page `/verify`, which runs the same code inside your browser and sends nothing
to our servers. CLI exit codes:

| Code | Meaning                                           |
| ---- | ------------------------------------------------- |
| 0    | All checks passed (read the warnings anyway)      |
| 1    | Chain broken                                      |
| 2    | Invalid or unreadable pack, or unknown version    |
| 3    | `pack_hash` does not match                        |
| 4    | A witness signature is invalid                    |
| 5    | An anchor is invalid                              |
| 6    | An attachment does not match                      |
| 64   | Usage error (bad arguments, unreadable `--roots`) |

When several checks fail, the first in this order sets the code: format, chain, witness, anchor, attachment,
`pack_hash`.
