# Paper Trail

> Bukti yang tidak bisa kamu edit sendiri, bahkan kalau kamu mau.

Paper Trail is a hash-chained evidence notebook for small disputes: workplace, rental, freelance, and gig work.
Each entry commits to the one before it, so changing or deleting an old entry is detectable. Witnesses can
co-sign through a one-time link without an account, and the chain head is periodically anchored to an external
RFC 3161 Time-Stamping Authority so the server cannot quietly move dates backwards.

**Status: pre-alpha.** Only the project skeleton, local infrastructure and design documents exist. There are no
user-facing features yet and the format is a draft. Do not use it for real evidence.

## Legal disclaimer

Paper Trail membantu membuktikan bahwa catatan tidak diubah setelah dibuat dan kapan catatan itu ada. Ini bukan nasihat hukum dan tidak menjamin penerimaan sebagai alat bukti. Konsultasikan dengan pendamping hukum.

_(English: Paper Trail helps show that a record was not changed after it was made and when it existed. It is not legal advice and does not guarantee acceptance as evidence. Consult a legal aide.)_

The legal weight of electronic evidence in Indonesian courts has not been verified by the project owner.

## What it does and does not do

It can show that an entry existed in a given form by a given time and has not changed since. It cannot show that
an entry is true, who really wrote it, or that nothing was left out. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Documentation

| Document                                         | Contents                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| [docs/SPEC.md](docs/SPEC.md)                     | Entry format, hash formula, witness signature, anchors, pack, verification |
| [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)     | What is protected, from whom, and the honest limits                        |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)     | Components and Mermaid flow diagrams                                       |
| [docs/API.md](docs/API.md)                       | Owner-side HTTP API, security notes, `curl` quickstart                     |
| [docs/OPERATIONS.md](docs/OPERATIONS.md)         | Worker runbook: TSA setup, queues, DLQ, manual anchoring                   |
| [docs/OPEN_DECISIONS.md](docs/OPEN_DECISIONS.md) | Undecided questions with recommendations                                   |

## Repository layout

```
apps/api          Express API (currently: GET /health)
apps/worker       RabbitMQ worker (currently: connects and logs "ready")
apps/web          React + Vite UI (currently: shows service status)
packages/chain    Pure hash-chain core (no framework dependencies)
packages/verifier Verifier library and CLI
docs/             Specification and design documents
```

## Requirements

- Node.js 22 LTS (`.nvmrc`), pnpm 10 (`packageManager` in `package.json`)
- Docker with Compose v2

## Run locally

```bash
pnpm install
pnpm infra:up                                  # copies .env.example to .env if missing, starts postgres, rabbitmq, minio
pnpm --filter @paper-trail/api db:migrate      # schema and integrity triggers
pnpm --filter @paper-trail/worker db:role      # least-privilege database role for the worker
pnpm dev                                       # api, worker, web
```

**Time-stamping authority (TSA).** Anchoring sends a hash of the newest entry to the RFC 3161 TSAs listed in
`TSA_URLS`. No TSA is configured or hard-coded: **you must choose providers yourself and verify their terms of service,
rate limits and availability before using them.** For an offline demo there is a local mock TSA whose tokens prove
nothing (`pnpm --filter @paper-trail/worker mock-tsa`). See [docs/OPERATIONS.md](docs/OPERATIONS.md) for setup,
monitoring the queues and triggering an anchor by hand.

- Web: http://localhost:5173 (shows service status)
- API: http://localhost:3000/health
- RabbitMQ management UI: http://localhost:15672
- MinIO console: http://localhost:9001

The values in `.env.example` are for local development only. Change host ports in `.env` if they clash with
services you already run. Stop infrastructure with `pnpm infra:down`.

## Scripts

| Command          | What it does                              |
| ---------------- | ----------------------------------------- |
| `pnpm dev`       | Run api, worker and web in watch mode     |
| `pnpm build`     | Build every package                       |
| `pnpm lint`      | ESLint and Prettier check                 |
| `pnpm typecheck` | TypeScript strict check in every package  |
| `pnpm test`      | Vitest in every package                   |
| `pnpm test:int`  | Integration tests (needs `pnpm infra:up`) |

## Author & License

Created by Vassel Goleyu. Copyright (c) 2026 Vassel Goleyu. All rights reserved.

The license is a placeholder until an open-source license is chosen (see [docs/OPEN_DECISIONS.md](docs/OPEN_DECISIONS.md), D3).
