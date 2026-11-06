# Architecture

Calling CRM is a multi-tenant SaaS for real estate teams that run outbound calling campaigns.
It is a **modular monolith**: one TypeScript codebase deployed as two backend processes plus a web
frontend. There are no microservices.

```
                         ┌──────────────────────────── browser ───────────────────────────┐
                         │ Next.js app (agent / supervisor / admin / platform layouts)    │
                         │  • TanStack Query → REST /api/*      • Socket.IO → /socket.io   │
                         │  • Plivo Browser SDK (WebRTC, receive-only JWT)                │
                         └───────────────┬───────────────────────────────┬────────────────┘
                                         │ HTTPS                         │ WebRTC media
                         ┌───────────────▼───────────────┐               │
                         │ reverse proxy (Caddy / ALB)   │               │
                         └───────┬───────────────┬───────┘               │
                     /api, /socket.io           /*                       │
              ┌──────────────────▼─────┐   ┌─────▼──────┐        ┌───────▼────────┐
              │ api (NestJS)           │   │ web (Next) │        │ Plivo Voice    │
              │ REST + Swagger         │   └────────────┘        │ (calls, MPC,   │
              │ Socket.IO gateway      │◄─── webhooks (signed) ──┤  recordings)   │
              │ Plivo / WhatsApp       │──── REST API (SDK) ────►│                │
              │ webhook receivers      │                         └────────────────┘
              └───┬───────────┬────────┘
                  │ Prisma    │ BullMQ jobs + Redis pub/sub (realtime fan-out)
           ┌──────▼─────┐ ┌───▼───┐ ┌────────────────────────────────────────────┐
           │ PostgreSQL │ │ Redis │◄┤ worker (NestJS app context, BullMQ)         │
           └──────▲─────┘ └───────┘ │ imports • dialer • call events • callbacks │
                  └─────────────────┤ whatsapp • maintenance sweeps • simulator  │
                                    └────────────────────────────────────────────┘
```

## Processes

| Process  | Entry point               | Responsibilities |
|----------|---------------------------|------------------|
| `api`    | `apps/api/src/main.ts`    | REST API under `/api`, OpenAPI at `/api/docs`, Socket.IO gateway, provider webhooks, auth/session, synchronous Plivo answer XML. |
| `worker` | `apps/api/src/worker.ts`  | BullMQ processors: CSV validation/import, customer-leg dialling, asynchronous call-event processing, callback reminders, WhatsApp sends, the mock call simulator, and repeatable maintenance sweeps. |
| `web`    | `apps/web` (Next.js)      | All user interfaces. Talks to the API through a same-origin `/api` rewrite so session cookies stay first-party. |

The worker publishes realtime events to a Redis channel; every API instance subscribes and emits to
its own Socket.IO rooms (`tenant:<id>`, `tenant:<id>:supervisors`, `membership:<id>`). This fans out
correctly across several API instances without sticky state.

## Backend modules (`apps/api/src/modules`)

| Module | Purpose |
|--------|---------|
| `auth` | Login/logout, Argon2id hashing, DB-backed sessions, CSRF double-submit, invitations, email verification, password reset, lockout. |
| `tenancy` | Request tenant context, permission guards, Prisma tenant guard. |
| `platform` | Super-admin: tenants, plans, subscription actions, platform health and integration failures. Never exposes tenant leads or recordings. |
| `users` | Memberships, roles, teams, invitations, agent profiles (calling mode, telephony identity). |
| `leads` | Lead CRUD, search/filter/sort/pagination, bulk assign/status, export, activity timeline, retention. |
| `imports` | CSV upload → mapping → validation preview → batched import with error report. |
| `compliance` | Suppression (DNC/opt-out) list, consent records, calling hours, eligibility evaluation. |
| `queues` | Queues, queue items, atomic next-lead reservation (`FOR UPDATE SKIP LOCKED`), retry scheduling. |
| `agent` | Agent availability state machine (Offline/Ready/Paused/Dialing/On call/Wrap-up), heartbeats, dial-next. |
| `calls` | Call attempts, legs, events, idempotent event ingestion, call state machine, wrap-up, recovery. |
| `telephony` | Provider adapter interface plus `PlivoProvider` and `MockProvider`, browser token issuance, webhook receivers. |
| `callbacks` | Scheduled callbacks, reminders, overdue tracking. |
| `supervisor` | Live board, team metrics, monitoring/coaching actions (Plivo MPC coach mode). |
| `recordings` | Recording metadata, signed short-lived playback through an authorizing proxy, retention, deletion. |
| `whatsapp` | WhatsApp Cloud API adapter (+ mock), templates, policy checks, delivery webhooks, opt-out. |
| `reports` | Aggregations computed from persisted data only; CSV export. |
| `billing` | Plans, subscriptions, entitlements, billing ledger (manual/simulated), usage ledger. |
| `org` | Organisation profile, tenant settings (calling hours, retry policy, recording, WhatsApp, cost estimates) and configurable outcomes. |
| `integrations` | Tenant-owned Plivo credentials (encrypted), connection test, removal. |
| `maintenance`, `worker` | Repeatable sweeps (stale agents, stuck calls, orphaned reservations, pending events, retention) and the BullMQ processors. |
| `notifications`, `audit`, `health`, `realtime` | Supporting modules. Infrastructure (Prisma, Redis, mail, storage, crypto, logging, jobs) lives in `apps/api/src/infra`. |

## Multi-tenancy

* Shared database, shared schema, `tenant_id` on every tenant-owned row.
* The tenant is taken **only** from the authenticated session's membership, never from the request
  body or URL. Every service method receives a `TenantContext` and scopes queries with it.
* Cross-tenant lookups return 404 (not 403) so IDs from other tenants cannot be probed.
* A Prisma client extension (`tenant-guard`) rejects reads, updates and deletes on tenant-owned
  models whose `where` clause lacks `tenantId`. This catches programming mistakes in tests and at
  runtime. System code that legitimately spans tenants (maintenance sweeps, webhooks resolved by an
  opaque call id, authentication) uses the explicit `prisma.system` client, which is easy to audit.
* PostgreSQL row-level security was considered. It requires a `SET LOCAL app.tenant_id` inside a
  transaction for every request, which conflicts with connection pooling and Prisma's query model.
  It is documented as a future hardening step in `docs/SECURITY.md` rather than half-enabled.
* Tenant isolation is covered by integration tests (`apps/api/test/auth-isolation.int-spec.ts`)
  and the guard itself by unit tests (`apps/api/src/infra/prisma/tenant-guard.spec.ts`).

## Roles and permissions

Roles live on `Membership` (a user can belong to several tenants; a session is bound to exactly one
membership). Platform super-admin is a flag on `User` and only unlocks `/api/platform/*`.

Permissions are defined once in `packages/shared/src/permissions.ts` and enforced by
`PermissionsGuard` on the backend. The frontend uses the same map only to hide controls.
Supervisors see agents and calls of the teams they supervise. Billing access for a supervisor
requires an explicit extra permission on the membership.

## Calling workflow (progressive dialling, agent-first)

Progressive dialling: one agent, one lead, one call at a time, initiated only when the agent asks.

1. The agent signs in. The browser asks for the microphone and checks audio devices.
2. In Plivo browser mode the web app requests a **receive-only** Plivo JWT
   (`incoming_allow=true`, `outgoing_allow=false`) from `POST /api/telephony/browser-token` and
   registers the Plivo Browser SDK with `loginWithAccessTokenGenerator`. The browser can never
   place calls itself, so it cannot dial arbitrary numbers.
3. The agent clicks **Ready**. The API checks subscription status, calling hours, device readiness
   and that no previous wrap-up is pending.
4. `POST /api/agent/dial-next` (with an `Idempotency-Key`) takes a per-agent advisory lock and
   reserves one eligible queue item using `SELECT … FOR UPDATE SKIP LOCKED`. Eligibility is
   re-checked on the reserved lead (suppression, consent, attempts, calling hours, active call).
5. A `Call` row (status `INITIATING`) and its `AGENT` leg are created in the same transaction.
6. After commit the provider adapter places the **agent leg**: a server-initiated call to the
   agent's browser identity (`sip:<identity>@phone.plivo.com`) or, in phone mode, to the agent's
   own phone. The browser auto-answers only an incoming call that carries the expected call id.
7. When the agent leg is answered, Plivo requests the answer URL. The API returns
   `<MultiPartyCall role="Agent">call-<id></MultiPartyCall>` and enqueues the **customer leg**.
8. The worker dials the customer. On answer, the customer joins the same multiparty call (MPC),
   optionally after a recording notice. Both participants use `endMpcOnExit`, so either side
   hanging up ends the conversation.
9. Every provider callback (ring, answer, hangup, MPC status, recording) is signature-checked,
   stored once in `call_events` (unique dedupe key) and applied through the call state machine
   under a row lock. Duplicate and out-of-order events are absorbed.
10. A terminal call puts the agent in **Wrap-up**. The agent must save an outcome; the server
    refuses `dial-next` until it has done so. Outcomes drive lead status, retries, callbacks,
    suppression and optional WhatsApp follow-ups.
11. The agent returns to Ready (or pauses).

The UI never shows "connected" until the provider reports that the customer leg was answered.

### Why an MPC instead of a plain `<Dial>` bridge

Plivo's supervisor coaching (speak to the agent without the customer hearing) is the `coachMode`
of a MultiPartyCall participant. A `<Dial>` bridge cannot add a whispering supervisor. Using an MPC
for every call gives one consistent architecture for plain calls and coached calls, and gives each
leg its own call UUID and hangup callback for clean state tracking.

### Mock (simulated) mode

When `ALLOW_MOCK_PROVIDER=true` and a tenant has no Plivo credentials of its own (and no
platform-owned Plivo account is configured with `TELEPHONY_DEFAULT_PROVIDER=plivo`), calls use
`MockProvider`. It emits the same normalized events through the same ingestion path, driven by
BullMQ delayed jobs. Every simulated call is stored with `is_simulated = true` and the UI shows a
**SIMULATED** badge. Simulated calls never claim that audio or a real call took place.

## Retries, callbacks and queue ordering

Queue ordering for an agent: due callbacks assigned to that agent → due callbacks assigned to
nobody → higher priority → longest waiting. Retry rules are per tenant (`retry_policy` setting): per
outcome delay schedule, maximum attempts, and whether the attempt counts. Next attempt times are
pushed into the next open calling window in the tenant's timezone. Leads never retry after an
opt-out, a "do not call", "wrong number" or "invalid number" outcome, or after the attempt limit.

## Realtime

Socket.IO with cookie authentication on the handshake. Events: agent state changes, call
state/leg updates, queue stats, import progress, notifications and callback reminders. Clients
refetch authoritative data through REST on reconnect; realtime is only an accelerator.

## Failure handling

* Provider API errors when starting a call: the call is marked `FAILED` (`provider_error`), the
  queue item is released without counting an attempt, and the agent sees the error.
* Agent leg not answered (browser offline): call `FAILED` (`agent_unreachable`), lead released,
  agent moved to `PAUSED` with an explanation so the dialer does not loop.
* Stuck calls (no events for several minutes): the maintenance sweep reconciles them from the
  provider's call detail record, or closes them as `FAILED (reconcile_timeout)` in mock mode.
* Stale agents (no heartbeat for 90 s) are moved to Offline. Expired reservations are released.
* Webhook processing failures are retried by BullMQ with backoff; the stored event row makes the
  retry idempotent.

## Data protection

Secrets for tenant-owned provider accounts are encrypted with AES-256-GCM using
`DATA_ENCRYPTION_KEY` and are never returned to the browser. Logs redact credentials, cookies and
phone numbers. Recordings are only reachable through short-lived signed URLs that the API checks
and proxies; provider recording URLs are never sent to browsers.
