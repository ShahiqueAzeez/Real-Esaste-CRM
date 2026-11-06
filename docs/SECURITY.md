# Security

This describes the controls that exist in the code today, what they protect against, and the gaps
an operator must close before production. Report vulnerabilities privately to the operator of the
deployment; do not open public issues containing exploit details.

## Threat model in one page

| Asset | Main threats | Primary controls |
|---|---|---|
| Lead data (names, phone numbers, notes) | Cross-tenant access, over-broad access inside a tenant, bulk exfiltration | Tenant scoping from the session only, Prisma tenant guard, role permissions, agent number masking, formula-safe exports, audit log |
| Calls and recordings | Toll fraud, eavesdropping, permanent public recording links | Server-side dialling only, receive-only browser tokens, signed short-lived playback through an authorising proxy, recording access audit |
| Provider credentials (Plivo, WhatsApp) | Leakage to browsers or logs, database theft | AES-256-GCM encryption at rest, never returned by the API, log redaction |
| Accounts | Credential stuffing, session theft, CSRF | Argon2id, lockout, rate limits, HttpOnly session cookie, CSRF double-submit + Origin check |
| Webhooks | Forged call events, replay | Plivo V3 / Meta HMAC signatures, idempotent event store, monotonic state machine |

## Authentication and sessions

* **Passwords** are hashed with Argon2id (`@node-rs/argon2` defaults: 19 MiB memory, 2 passes,
  parallelism 1, the OWASP baseline). Policy: 10 to 128 characters with letters and a digit
  (`passwordSchema` in `packages/shared`).
* **Lockout**: 5 consecutive failures lock the account for 15 minutes. Login responses never reveal
  whether an email exists.
* **Rate limits** (Redis-backed, shared by all API instances): 10 requests per minute per IP on
  login, forgot-password and reset-password (`AUTH_RATE_LIMIT_PER_MIN`), 600 per minute per IP
  elsewhere, 20 per minute for browser-token issuance.
* **Sessions** are random 256-bit tokens stored only as SHA-256 hashes in `sessions`. The cookie
  `crm_sid` is HttpOnly, SameSite=Lax and Secure in production. Sessions slide for
  `SESSION_TTL_HOURS` (default 12) of inactivity and are capped at 7 days absolute. They are
  revoked on logout, password change or reset (all of the user's sessions) and membership
  deactivation; sessions of a suspended organisation are refused on every request.
* **CSRF**: every state-changing request needs the `x-csrf-token` header matching the readable
  `crm_csrf` cookie, whose hash is bound to the session. Requests whose `Origin` is not in
  `WEB_ORIGIN` are rejected. Webhooks are exempt and authenticated by signature instead.
* **No default accounts.** The first platform administrator is created with
  `bootstrap-admin` by an operator with database access; it refuses to create a second one unless
  `--allow-additional` is passed. The development seed refuses to run when `NODE_ENV=production`.
* Invitations, email verification and password reset use single-use random tokens stored as hashes,
  with expiry.

## Authorisation and tenant isolation

* The tenant comes from the session's membership, never from the URL or body.
* `PermissionsGuard` enforces the permission map in `packages/shared/src/permissions.ts` on every
  route. The web app uses the same map only to hide controls.
* Agents see only their own leads, calls and callbacks; phone numbers are masked for agents because
  the server dials and the agent never needs the full number. Supervisors see their teams.
* Platform administrators manage tenants, plans and subscriptions but have no route into tenant
  leads, calls or recordings (integration-tested).
* Cross-tenant identifiers return 404, never 403.
* The Prisma client used by request code is wrapped by `tenant-guard`, which throws if a read,
  update or delete on a tenant-owned model lacks `tenantId` in its `where`. Code that must span
  tenants uses the explicitly named `prisma.system` client (webhook resolution, sweeps,
  authentication), which keeps every exception searchable.

### Row-level security (considered, not enabled)

PostgreSQL RLS would add a database-enforced backstop. It needs `SET LOCAL app.tenant_id` inside a
transaction for every request, which fights Prisma's connection pooling and non-transactional
reads, and a half-applied RLS policy gives false confidence. The application-level guard plus
integration tests are the current control. Enabling RLS is a recommended hardening step: wrap
request handling in an interactive transaction that sets the tenant, add `USING (tenant_id =
current_setting('app.tenant_id')::uuid)` policies table by table, and run the API as a role without
`BYPASSRLS`.

## Telephony abuse controls

* The browser never places calls. Plivo browser tokens are minted server-side through Plivo's token
  API with `incoming_allow=true, outgoing_allow=false` and a one-hour expiry (renewed by the SDK's
  token generator), and the browser auto-answers only the call the server announced for that
  agent.
* Every call is created by the server from a queue reservation: one agent, one lead, one call. The
  dial endpoint takes a per-agent advisory lock and an `Idempotency-Key`, and refuses to dial while
  a wrap-up is pending, outside calling hours, for suppressed numbers, without required consent,
  beyond the attempt limit, or when the subscription is inactive.
* Synthetic seed leads are refused by any real provider.
* Maximum call duration (`maxCallMinutes`) is passed to Plivo as `time_limit`, and the stuck-call
  sweep closes calls that stop receiving events.

## Webhooks

* Plivo callbacks are verified with the SDK's own `validateV3Signature` against
  `PUBLIC_BASE_URL + originalUrl` and the auth token of the account that owns the call. The call and
  leg identifiers in the URL must also match the stored leg.
* WhatsApp callbacks are verified with `X-Hub-Signature-256` (HMAC-SHA256 with the tenant's app
  secret, constant-time comparison). Verification `GET`s need the tenant's verify token.
* Every event is stored once (`call_events` unique on provider + dedupe key) and applied under a row
  lock through a state machine in which terminal states are absorbing and ranks only move forward,
  so replays and out-of-order deliveries cannot revive or regress a call.

## Data protection

* Tenant provider secrets are encrypted with AES-256-GCM under `DATA_ENCRYPTION_KEY` and are never
  returned to the browser (the API returns only "configured" flags and the last error).
* Recordings: provider recording URLs never reach browsers. Playback uses a 5-minute HMAC-signed
  token bound to recording, tenant and member; the API checks permission again, streams the media
  (fetching from Plivo with the account's credentials) and audits the access. Enable HTTP
  authentication on recording URLs in the Plivo console, because Plivo serves them publicly by
  default.
* Logs are structured JSON. Authorization headers, cookies, CSRF tokens, signature headers,
  passwords, tokens, phone numbers, emails and Plivo `To`/`From` fields are redacted; request bodies
  are never logged; query strings are dropped from request logs.
* Exports neutralise spreadsheet formula injection (cells starting with `= + - @` or control
  characters are prefixed with `'`).
* Uploads: CSV only, size-capped (`MAX_UPLOAD_MB`) and row-capped (100,000 rows), parsed with
  `csv-parse`, stored in private storage (never served statically), with error reports
  downloadable only through tenant-scoped endpoints.
* Retention: recordings carry `retention_until`; leads without activity can be deleted after a
  tenant-configured number of days. Both run in the maintenance sweep and are audited.

## HTTP hardening

* API: Helmet defaults (HSTS, no-sniff, frame denial, referrer policy), CORS limited to
  `WEB_ORIGIN`, `trust proxy` set to the number of proxies (`TRUST_PROXY`) so client IPs used by
  rate limits and audit logs cannot be spoofed with `X-Forwarded-For`.
* Web: `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, `Permissions-Policy` allowing
  the microphone only for the app itself; no `X-Powered-By`.
* Caddy strips the `Server` header, adds HSTS on HTTPS, caps request bodies and redacts cookies in
  access logs.
* Containers run as an unprivileged user on read-only root filesystems with all Linux capabilities
  dropped and `no-new-privileges`. Postgres and Redis are not published to the host; Redis requires
  a password.

## Operator checklist before production

- [ ] Strong, unique `APP_SECRET`, `DATA_ENCRYPTION_KEY`, database and Redis passwords stored in a
      secret manager, not in the repository or images.
- [ ] HTTPS only (`PUBLIC_BASE_URL` https, `COOKIE_SECURE=true` enforced in production).
- [ ] `ALLOW_MOCK_PROVIDER`, `ALLOW_MOCK_CONTROLS` and `WHATSAPP_ALLOW_MOCK` set to `false`.
- [ ] `ENABLE_API_DOCS=false` on public deployments.
- [ ] `TRUST_PROXY` matches the real number of proxies.
- [ ] Plivo recording URL authentication enabled; Plivo subaccount per tenant.
- [ ] Database backups encrypted and restore-tested; access to backups restricted.
- [ ] SMTP configured so password resets reach users.
- [ ] Dependency and image vulnerability scanning in CI (not set up in this repository).
- [ ] An external penetration test before handling real customer data.

## Known gaps

* No multi-factor authentication yet. Recommended next for administrators.
* No PostgreSQL RLS (see above).
* No automated key rotation: rotating `DATA_ENCRYPTION_KEY` requires re-entering tenant provider
  credentials; rotating `APP_SECRET` invalidates outstanding playback links (harmless, 5 minutes).
* No malware scanning of uploads (CSV only, never executed or served inline).
