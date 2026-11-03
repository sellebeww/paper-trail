# Contributing to Paper Trail

Thank you for helping. Paper Trail holds evidence for people in disputes, so correctness and honesty about limits
matter more than features. Security problems: **do not open an issue**, follow [docs/SECURITY.md](docs/SECURITY.md).

## Getting started

Follow the quickstart in [README.md](README.md#quickstart-5-minutes). Before opening a pull request, run:

```bash
pnpm lint && pnpm typecheck && pnpm test   # fast, no infrastructure
pnpm infra:up && pnpm test:int             # integration + chaos tests (real Postgres and RabbitMQ)
pnpm --filter @paper-trail/web test:e2e    # browser tests (needs Google Chrome)
```

CI runs all of these plus the production image builds and an npm publish dry-run ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Ground rules

- **The format is versioned.** After SPEC 1.0, any change to hashed bytes, canonicalization or verification results
  needs a new format version and a SPEC update in the same pull request ([docs/SPEC.md §9](docs/SPEC.md)). Appendix A's
  test vector must keep passing.
- **Chain logic lives only in `packages/chain`.** The API, worker, CLI and `/verify` must never re-implement it.
- **Entries are append-only.** No code path may update or delete an entry; Postgres triggers enforce it as well.
- **The server is the only clock.** Never accept a client timestamp into a hashed field.
- **Never log secrets or content:** tokens, passwords, entry text, witness names, file names.
- **Say what it does not prove.** User-facing text must not overstate what a hash, signature or anchor shows. The legal
  disclaimer stays wherever evidence is presented.
- **Tests come with changes.** Integrity code needs tests that a tampered input fails, not only that a valid one
  passes; `verify.property.test.ts` shows the pattern.

## Style

- TypeScript strict, ESM, Prettier (`pnpm format`). Match the surrounding code; comment only the _why_.
- User-facing messages are Indonesian (the owner app also has English); code, docs and commit messages are English.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat(api): …`, `fix(worker): …`).
- New dependencies need a reason in the pull request; prefer the standard library and what is already installed.

## Repository map

See [README.md](README.md#repository-layout) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the license of
this project (Apache-2.0 §5).
