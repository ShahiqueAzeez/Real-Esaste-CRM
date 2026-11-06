# Testing

Four layers. None of them contacts Plivo, Meta or any other external service: telephony and
WhatsApp are exercised through the **simulated providers** and signed webhook fixtures, and every
test that relies on them says so in its name or file. A real-provider smoke test is a separate,
manual procedure (`docs/TELEPHONY_PLIVO.md`).

| Layer | Command | Needs | Covers |
|---|---|---|---|
| Shared domain unit tests | `npm run test -w @crm/shared` | nothing | Permissions, settings schemas, calling hours (time zones, windows), retry policy, call and leg state machines, outcomes, CSV safety, phone normalisation. |
| API unit tests | `npm run test:unit -w @crm/api` | nothing | Config validation, tenant guard, encryption, Plivo event mapping and answer XML, WhatsApp client/signatures/opt-out keywords, CSV import row validation, enum sync between Prisma and shared. |
| API integration tests | `npm run test:int -w @crm/api` | PostgreSQL and Redis | Real NestJS app, real database and queues, simulated provider: auth, CSRF, lockout, invitations, tenant isolation, concurrent reservations, idempotent dialling, call lifecycle and wrap-up, retries and attempt limits, callbacks, suppression, consent, agent-line failure, provider outage, reports from persisted data, CSV import, WhatsApp policy and webhooks, Plivo signed webhooks (ordering, duplicates, bad signatures), caller-ID validation. |
| End-to-end (browser) | `npm run test:e2e:stack` | PostgreSQL, Redis, free ports 3000/4000 | Builds and starts API, worker and web, then drives Chromium through: platform admin creates an organisation → org admin accepts the invitation, adjusts calling hours, invites an agent → CSV import with validation preview → agent makes a simulated call, wraps up with a callback → admin sees the call (SIMULATED), outcome and report. |

`npm test` at the repository root runs the first three.

## Local prerequisites

* PostgreSQL 16. Integration tests default to
  `postgresql://crm:crm_dev_password@localhost:5432/crm_test` (override with `TEST_DATABASE_URL`;
  the database name must end in `_test`, a guard against pointing them at real data). The e2e
  script uses `crm_e2e` and creates it if missing (override with `E2E_DATABASE_URL`).
* Redis URLs can be overridden with `TEST_REDIS_URL` / `E2E_REDIS_URL`.
* Redis 7. Integration tests use database 15 and the e2e stack database 14, so they never touch
  development data in database 0.
* Easiest: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis`
  and point the URLs at `localhost`.

Test databases are migrated with `prisma migrate deploy` and are **not wiped** between runs: each
test creates its own organisations, users and phone numbers with unique values, so runs are
repeatable and parallel developers do not collide.

## Running the browser suite against Docker Compose

The same Playwright suite runs against the production containers:

```bash
docker compose up -d --build
```

```bash
docker compose run --rm -e BOOTSTRAP_ADMIN_PASSWORD='E2e-platform-pass-1' api node dist/scripts/bootstrap-admin.js --email e2e-platform@calling-crm.test --with-example-plans --allow-additional
```

```bash
E2E_BASE_URL=http://localhost:8080 npx playwright test -c e2e/playwright.config.ts
```

The Compose stack must run with the simulated providers enabled (the defaults in `.env.example`).
Set `MOCK_TIME_SCALE=0.5` in `.env` to shorten simulated ring and talk times.

## Simulator scenarios

The simulated provider picks the customer-leg behaviour from the last four digits of the number:

| Ends with | Result |
|---|---|
| `0000` | Call fails |
| `1111` | Busy |
| `2222` | No answer |
| `3333` | Answers, then the customer hangs up after about 11 seconds |
| anything else | Answers and stays connected until someone hangs up |

`ALLOW_MOCK_CONTROLS=true` also enables the "simulate" buttons on the agent console (answer, busy,
no answer, fail, customer hang-up) for demonstrations.

## What is not covered automatically

* Real Plivo calls, browser WebRTC audio, MPC coaching audio and Plivo recordings (manual smoke
  test).
* Real WhatsApp delivery (see `docs/WHATSAPP.md`).
* Load testing. The reservation and idempotency paths are concurrency-tested, but there is no
  sustained-load benchmark yet.
