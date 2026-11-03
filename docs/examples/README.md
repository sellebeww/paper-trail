# Examples

Everything here is **fictional** and was produced by `pnpm --filter @paper-trail/api example:pack`. The time-stamp tokens
come from a local mock TSA with a throwaway CA; they show the format and let the verifier run offline, but they prove
nothing about real time. Never use the mock TSA outside demos and tests.

| File                        | What it is                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| `example-pack.json`         | A full evidence pack: 6 entries, a file entry, a witness co-sign, two anchors (heads 3 and 5). |
| `example-pack-partial.json` | Entries 1–2 only, bridged by an envelope-only entry 3 to the anchor at head 3 (SPEC §6.2).     |
| `example-pack.zip`          | The full pack plus `README.txt` and the attached file under `files/` (SPEC §6.5).              |
| `example-pack.pdf`          | The PDF summary of the full pack (SPEC §6.6).                                                  |
| `example-tsa-root.pem`      | The mock TSA's root certificate, needed to verify the anchors' certificate chain.              |
| `quickstart.sh`             | `curl` walkthrough of the owner API ([../API.md](../API.md)).                                  |

Verify a pack offline, without an account or network:

```bash
pnpm build
node packages/verifier/dist/cli.js docs/examples/example-pack.json --roots docs/examples/example-tsa-root.pem
# ✔ Rantai utuh · saksi terverifikasi: 1, jangkar terverifikasi: 2
```

Change one character of a pack (for instance `21.00` to `22.00` in the first note) and run it again: the result becomes
"Terputus di entri 0" and the exit code is 1. Without `--roots` the pack still verifies but the verifier warns that the
TSA certificate chain was not checked.
