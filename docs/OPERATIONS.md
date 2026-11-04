# Operations

Short runbook for the API and the worker in a local or small deployment. Architecture: [ARCHITECTURE.md](ARCHITECTURE.md).

## First-time setup

```bash
pnpm install
pnpm infra:up                                   # postgres and rabbitmq
pnpm --filter @paper-trail/api db:migrate       # schema, triggers, the pt_worker group role
pnpm --filter @paper-trail/worker db:role       # login role from WORKER_DATABASE_URL, member of pt_worker
```

`db:role` reads the admin connection from `DATABASE_URL` and the worker's role name and password from
`WORKER_DATABASE_URL`. Run it again after changing that password. Never give the worker the admin URL: the separate
role is what stops it from writing entries.

> Storage note: uploaded files go to `STORAGE_DIR` (default `.data/files`; `/data/files` in the api image, mount a
> volume there and back it up together with the database). For several API hosts set `S3_*` instead and unset
> `STORAGE_DIR`. In November 2026 the `minio/minio` image could no longer be pulled, so the compose MinIO service is
> behind the `s3` profile.

## Choosing a TSA

`TSA_URLS` is a comma-separated list tried in order; the first valid answer wins. **Before using any provider, check
yourself:** its terms of service (rate limits, commercial use, whether automated use is allowed), availability, and its
certificate chain. Put the provider's root (and intermediates) in a PEM file and point `TSA_CA_CERTS` at it; without it
the worker checks signatures but not the chain, and logs a warning at start-up. Credentials in a URL
(`https://user:pass@host/path`) are sent as HTTP Basic auth and are stripped from logs and from the stored `tsa_url`.

### Check a provider before you rely on it

```bash
TSA_URLS=https://tsa.example/tsr TSA_CA_CERTS=roots.pem pnpm --filter @paper-trail/worker tsa:check
```

Sends the hash of random bytes (no user data) with the worker's own client and prints what came back: `gen_time`,
clock skew, accuracy, whether the certificate chain verified, and the round-trip time. Run it from the machine that will
run the worker.

**Tested with FreeTSA (2026-11-03).** `https://freetsa.org/tsr`, root from `https://freetsa.org/files/cacert.pem`
(a copy is in [examples/freetsa-root.pem](examples/freetsa-root.pem); get your own from their site). The token
validated with the chain checked, took about 0.8 s, and states no accuracy. A pack anchored by it,
[examples/example-pack-freetsa.json](examples/example-pack-freetsa.json), verifies with the CLI and also with the
Python and OpenSSL steps in [VERIFY.md](VERIFY.md) (`openssl ts -verify`: OK). What its pages say (read them yourself
before relying on it): free; timestamps may be used commercially; at most **one request per second per IP**; best
effort, **no SLA**, no uptime or restoration guarantee; no request logs kept. With it set `WORKER_PREFETCH=1` so jobs
do not run in parallel, and add a second independent TSA to `TSA_URLS` for anything that matters.

**Tested with DigiCert (2026-11-04).** `http://timestamp.digicert.com`, root `DigiCert Trusted Root G4`. Also works end to end
(chain verified, about 0.8 s, no accuracy stated). Its token carries a cross-signed copy of that root, which the
verifier used to trip over; fixed, with a real token kept as a regression test. DigiCert's page for this service is
written for code signing (Authenticode) and states **no** rate limit, SLA or terms for other uses, and says its TSA
certificates are replaced at least every 15 months (verification checks the certificate as of the token's time, so old
packs stay valid).

**Recommended setup, and why.** Put FreeTSA first (its pages explicitly allow this use) and DigiCert second as a
failover, so one provider being down does not leave a ledger unanchored. The list is failover, not redundancy: each
anchor holds one token, from the first provider that answers. Roots for both are in
[../deploy/tsa-roots.pem](../deploy/tsa-roots.pem) (and at `/app/tsa-roots.pem` in the worker image) with their SHA-256
fingerprints: compare them with what the providers publish before relying on them.

```
TSA_URLS=https://freetsa.org/tsr,http://timestamp.digicert.com
TSA_CA_CERTS=deploy/tsa-roots.pem
WORKER_PREFETCH=1
```

Nothing is enabled by default: a fresh checkout makes no outside requests until you set `TSA_URLS`. For stronger
guarantees (an SLA, a stated legal standing) arrange a commercial or locally qualified TSA; the setup does not change.

### Offline demo with the mock TSA

```bash
pnpm --filter @paper-trail/worker mock-tsa      # prints TSA_URLS and TSA_CA_CERTS to use
```

The mock TSA signs with a throwaway CA generated at start-up. Its tokens prove nothing about real time; use it only for
demos and tests. Restart the worker after restarting the mock (new CA).

## Running

```bash
pnpm dev                                        # api + worker + web, in watch mode
```

The worker scans for changed ledgers once at start-up and then every `ANCHOR_INTERVAL_HOURS` (default 6). For a demo,
set `ANCHOR_INTERVAL_HOURS=0.01` (36 seconds) in the worker's environment.

### Production images

One `Dockerfile` builds all images from a shared build stage ([ARCHITECTURE §6](ARCHITECTURE.md)):

```bash
for t in api worker web migrate; do docker build --target $t -t paper-trail-$t .; done
```

All configuration is environment variables, the same names as in `.env.example` (nothing is baked into the images).
Per release, in this order:

1. `docker run --rm --env-file prod.env paper-trail-migrate` (applies migrations), and once per environment
   `docker run --rm --env-file prod.env paper-trail-migrate pnpm --filter @paper-trail/worker db:role`.
2. `paper-trail-api` (port 3000, `HEALTHCHECK` on `/health`) and `paper-trail-worker` with a restart policy such as
   `--restart unless-stopped`: the worker exits on purpose when it loses RabbitMQ. Mount the TSA root bundle and point
   `TSA_CA_CERTS` at it.
3. `paper-trail-web` (port 8080) with `API_UPSTREAM` set to the API's internal URL (default `http://api:3000`) and,
   if you raise `UPLOAD_MAX_BYTES`, a matching `CLIENT_MAX_BODY_SIZE`. Terminate TLS in front of it.

Account mail: set `MAILER=smtp`, `SMTP_URL` (nodemailer URL, for example `smtps://user:pass@smtp.example.com:465`) and
`SMTP_FROM` on the api container. With `NODE_ENV=production` (the image default) the API will not start with the
console mailer. Test it by registering and checking that the verification mail arrives.

Before a real deployment, work through [SECURITY.md § Hardening before production](SECURITY.md#hardening-before-production).

### Trigger an anchor now

```bash
pnpm --filter @paper-trail/worker anchor:now                 # every ledger whose head changed
pnpm --filter @paper-trail/worker anchor:now <ledger-id>     # one ledger's current head
```

The command only queues jobs; the running worker processes them. Then check the ledger:

```bash
curl -s -b cookies.txt http://localhost:3000/ledgers/<ledger-id>   # last_confirmed_anchor.status = "ok", gen_time
```

## Monitoring

- **RabbitMQ UI:** http://localhost:15672 (user and password from `.env`). Watch `anchor.requests`, `reminders`, their
  `.retry.<i>` queues and the `.dlq` queues. A growing DLQ needs a human.
- **CLI:** `docker compose exec rabbitmq rabbitmqctl list_queues name messages consumers`
- **Worker logs** are JSON lines. The ones to alert on:
  - `"msg":"job dead-lettered","level":"error"` with `queue`, `message_id`, `attempts`, `error` and an `action` hint.
  - `"msg":"anchor jobs failed"` / `"reminder jobs failed"`: the scheduler itself failed (database or broker down).
  - `"msg":"TSA_CA_CERTS not set …"`: chain verification is off.
- **Database:** anchors that need attention

  ```sql
  SELECT ledger_id, anchored_head_seq, status, attempts, last_error, updated_at
    FROM anchors WHERE status <> 'ok' ORDER BY updated_at DESC;
  ```

## When anchors fail

1. Read `last_error` (query above) or the `x-error` header of the message in `anchor.requests.dlq`.
   - `HTTP 5xx`, `timeout`, `network error`: the TSA or the network was down; retries were exhausted.
   - `nonce`, `messageImprint`, `ESS`, `signature or certificate`: the TSA answered with something we must not store
     (misconfigured URL, wrong CA bundle, or a TSA problem). Not retried automatically.
   - `server clock ahead of the TSA`: fix the server's NTP; the job retries by itself.
2. Fix the cause.
3. Re-queue: failed anchors are picked up again by the next scheduler run, or immediately with `anchor:now`. Anchoring
   is idempotent, so replaying is always safe.
4. Purge the handled messages from `anchor.requests.dlq` in the RabbitMQ UI ("Purge"). For `reminders.dlq`, either
   purge (the next occurrence will be sent normally) or move the messages back to `reminders` with the UI's
   "Move messages" (needs the shovel plugins).

## Reminders

`NOTIFIER=console` (default) only logs that a reminder would be sent, with the address masked. For email set
`NOTIFIER=email`, `SMTP_URL` (e.g. `smtps://user:pass@smtp.example.com:465`) and `SMTP_FROM`. Users manage schedules via
`POST/GET/DELETE /reminders` ([API.md](API.md)). A reminder may very rarely be sent twice (crash between sending and
recording); it is never silently skipped.

## Checking an anchor without Paper Trail code

The timestamped data is the head entry's JCS envelope ([SPEC §5.1](SPEC.md)). With the token (`anchors.tst_token`, DER)
and the envelope written to `envelope.json` (sorted keys, no whitespace, no trailing newline):

```bash
openssl ts -verify -data envelope.json -in token.der -token_in -CAfile tsa-roots.pem   # Verification: OK
openssl ts -reply -in token.der -token_in -token_out -text                              # shows genTime, accuracy
```

This was checked with OpenSSL 3.6 against tokens produced by the worker.
