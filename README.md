# Calling CRM

A multi-tenant cloud calling CRM for real estate agencies, built for teams in Chennai and the rest
of India. Agencies import leads, agents work a progressive dialling queue from the browser (or
their own phone), every call ends with a recorded outcome, and admins and supervisors see live
activity and reports computed from what actually happened.

Telephony is Plivo Voice behind a provider adapter. A clearly labelled **simulated provider** lets
the whole product run, be demonstrated and be tested without a Plivo account; simulated calls are
marked SIMULATED everywhere and never claim that a real call took place.

> Status: feature-complete MVP, tested with simulated providers only. Read `BUILD_STATUS.md`
> before any pilot: real Plivo calling, Indian telemarketing registration and WhatsApp delivery
> still need verification with real accounts.

## What it does

* **Organisations and people**: platform operators create organisations and plans; organisation
  admins invite supervisors and agents, form teams and set permissions.
* **Leads**: CSV import with column mapping, validation preview and error report; search, filters,
  bulk assignment and status changes, notes, timeline, consent records, formula-safe export.
* **Progressive dialling**: one ready agent, one reserved lead, one call. Agent leg first (browser
  WebRTC with a receive-only token, or the agent's phone), then the customer, joined in a Plivo
  multiparty call. Concurrency-safe reservation, idempotent dialling, mandatory wrap-up.
* **Outcomes, retries and callbacks**: configurable outcomes drive lead status, retry schedules
  inside calling windows, callbacks (dialled first when due), and do-not-call suppression.
* **Compliance controls**: suppression list, consent requirement, calling hours per tenant time
  zone, attempt limits, recording notice and retention, audit log. See
  `docs/COMPLIANCE_INDIA.md` for what the business must still do.
* **Supervisors**: live board of agents and calls, team metrics, whisper (coach) and barge on
  Plivo calls.
* **Recordings**: stored metadata, playback only through short-lived signed links proxied by the
  API, retention and deletion.
* **WhatsApp (optional)**: approved templates via the Cloud API for callback confirmations and
  missed-call follow-ups, with consent, opt-out and frequency checks. Off by default.
* **Reports**: attempts vs answered vs connected, outcomes, agent productivity, callbacks,
  provider-reported costs separated from estimates, CSV export.
* **Plans and billing records**: example Starter (₹7,999/month), Professional (₹14,999) and
  Business (₹24,999) plans, all editable; subscriptions with trials, entitlements (agents, imports,
  features) and a manual billing ledger. **No payment collection is integrated**; amounts are
  recorded manually and labelled as such.

## Quick start (Docker, simulated telephony)

Requires Docker with the Compose plugin.

```bash
cp .env.example .env
```

Fill in `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `APP_SECRET` and `DATA_ENCRYPTION_KEY` in `.env`
(the file explains how to generate them), then:

```bash
docker compose up -d --build
```

```bash
docker compose run --rm api node dist/scripts/bootstrap-admin.js --email you@example.com --name "Your Name" --with-example-plans
```

Open http://localhost:8080 and sign in with the printed password. As platform admin, create an
organisation; open the invitation link to set up its admin; import leads; invite an agent; start
calling. Use a Chromium-based browser or Firefox for plain-http localhost.

## Local development

Requires Node.js 22 and npm 10.

```bash
npm install
```

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
```

```bash
cp apps/api/.env.example apps/api/.env
```

```bash
cp apps/web/.env.example apps/web/.env.local
```

Edit `apps/api/.env` (database and Redis URLs with the passwords from the root `.env`, plus
`APP_SECRET` and `DATA_ENCRYPTION_KEY`), then:

```bash
npm run db:deploy
```

```bash
SEED_PASSWORD='Choose-a-dev-password-1' npm run db:seed
```

```bash
npm run dev
```

The web app runs on http://localhost:3000 (API on :4000, OpenAPI at http://localhost:4000/api/docs
when `ENABLE_API_DOCS=true`). The seed creates "Demo Realty Chennai" with
`admin@demo-realty.test`, `supervisor@demo-realty.test`, `agent1@demo-realty.test` and
`agent2@demo-realty.test`, all with `SEED_PASSWORD`, and 40 synthetic leads. Create a platform
admin with `npm run bootstrap:admin -- --email you@example.com`.

## Tests

```bash
npm test
```

```bash
npm run test:e2e:stack
```

`npm test` runs the shared and API unit tests and the API integration tests (needs Postgres and
Redis). The e2e command builds and starts the stack and drives a real browser. See
`docs/TESTING.md`.

## Repository layout

```
calling-crm/
├── packages/shared   domain rules shared by API and web: enums, permissions, settings,
│                     state machines, calling hours, retry policy, schemas (Zod)
├── apps/api          NestJS API + worker (one codebase, two entry points), Prisma schema
│                     and migrations, scripts (seed, bootstrap-admin, example-plans)
├── apps/web          Next.js app: agent console, supervisor board, admin and platform pages
├── e2e               Playwright end-to-end suite
├── infra/Caddyfile   edge proxy for Docker Compose
├── docker-compose.yml, docker-compose.dev.yml, .env.example
└── docs/             architecture and operations documentation
```

## Documentation

| Document | Contents |
|---|---|
| `BUILD_STATUS.md` | What is done, test results, known limitations, next steps |
| `docs/ARCHITECTURE.md` | Processes, modules, tenancy, calling workflow, failure handling |
| `docs/TELEPHONY_PLIVO.md` | Verified Plivo APIs, India constraints, costs, prerequisites, real-provider smoke test |
| `docs/COMPLIANCE_INDIA.md` | TRAI/DoT/DPDP notes, what the CRM provides and what it does not |
| `docs/SECURITY.md` | Security controls, threat model, production checklist, known gaps |
| `docs/DATABASE.md` | Schema overview, conventions, migrations, seed data |
| `docs/DEPLOYMENT.md` | Single-server Docker Compose and AWS reference architecture |
| `docs/OPERATIONS.md` | Monitoring, backups and restore, runbooks, secret rotation |
| `docs/WHATSAPP.md` | WhatsApp Cloud API setup and policy |
| `docs/TESTING.md` | Test layers, prerequisites, simulator scenarios |
| `docs/IMPLEMENTATION_CHECKLIST.md` | Phase-by-phase checklist |
