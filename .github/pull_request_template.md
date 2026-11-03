<!-- Security problems: do not open a pull request or issue; see docs/SECURITY.md. -->

## What and why

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass; integration tests (`pnpm test:int`) if the API, worker or database changed
- [ ] New integrity or security code has a test that a **tampered or malicious** input fails
- [ ] Hashed bytes, canonicalization or verification results unchanged, **or** SPEC.md and its version updated here (docs/SPEC.md §9)
- [ ] No tokens, passwords, entry text, witness names or file names in logs
- [ ] User-facing text does not overstate what a hash, signature or anchor proves; Indonesian and English updated together
- [ ] Docs and CHANGELOG updated if behaviour or configuration changed
