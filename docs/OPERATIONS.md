# Operations

Commands assume Docker Compose from the `calling-crm` directory; on other platforms run the same
`node dist/...` commands in a one-off API container.

## Health and monitoring

| Signal | Where | Meaning |
|---|---|---|
| `GET /api/health/live` | API | Process is up (load balancer and container health check). |
| `GET /api/health/ready` | API | Database and Redis reachable: `{"status":"ok","checks":{"database":"ok","redis":"ok"}}`. |
| Platform → System health | Web (platform admin) | Queue backlogs per BullMQ queue (waiting, active, delayed, failed), provider events not processed after 60 s, calls stuck in a ringing state for over 10 minutes, tenants whose integrations report errors. |
| Integrations page | Web (org admin) | Last Plivo/WhatsApp error and when it was last checked. |
| Logs | `docker compose logs -f api worker` | JSON lines (pino). Request lines carry a request id that is also returned in error responses (`requestId`). |

Maintenance sweeps run in the worker: stale agents every 30 s (no heartbeat for 90 s → Offline,
never during a call), stuck calls every 60 s (no provider event for 3 minutes → reconcile from
Plivo's call record or close), orphaned reservations every 2 minutes, unprocessed provider events
every 60 s, subscription status hourly, retention every 6 hours.

## Backups

Tested commands (custom-format dump, restored into a scratch database and checked):

```bash
docker compose exec -T postgres pg_dump -U crm -d crm -Fc > crm-$(date +%F).dump
```

```bash
docker compose run --rm --no-deps -T --entrypoint tar api czf - -C /data/storage . > storage-$(date +%F).tgz
```

Copy both files off the server (encrypted) and keep `DATA_ENCRYPTION_KEY` and `APP_SECRET` in your
secret store: a database restored without the same `DATA_ENCRYPTION_KEY` cannot decrypt stored
provider credentials (tenants would have to re-enter them).

On AWS use RDS automated backups with point-in-time recovery and S3 versioning instead.

## Restore

Stop the writers, restore, start again:

```bash
docker compose stop api worker
```

```bash
docker compose exec -T postgres pg_restore -U crm -d crm --clean --if-exists --no-owner < crm-2026-11-06.dump
```

```bash
docker compose run --rm --no-deps -T --entrypoint tar api xzf - -C /data/storage < storage-2026-11-06.tgz
```

```bash
docker compose up -d
```

Rehearse a restore into a scratch database (`createdb … crm_restore_check`, `pg_restore -d
crm_restore_check`) every quarter.

## Runbooks

### An agent is stuck in "Dialing" or "On call"

The stuck-call sweep closes calls that stop receiving provider events within about 3 minutes and
asks Plivo for the call record first. If the call ended but the wrap-up is still pending, a
supervisor or admin opens the call (Calls → call) and uses **Recover call**, which ends live legs,
completes the wrap-up with notes and is audited. Agents whose browser closed are moved to Offline
after 90 seconds without a heartbeat.

### Plivo webhooks are rejected (HTTP 403) or calls never progress

1. `PUBLIC_BASE_URL` must be exactly the URL Plivo calls (scheme, host, port, path prefix). The
   signature covers the full URL, so a proxy that rewrites the host or path breaks it.
2. The tenant's Auth Token in Integrations must belong to the account that placed the call
   (changing accounts mid-call fails verification for that call only).
3. Plivo cannot reach `localhost` or private addresses; use a public HTTPS URL (a tunnel in
   development).
4. Platform → System health → "unprocessed call events" growing means events are stored but not
   applied: check the worker is running and its logs.

### Calls fail immediately in India with hangup cause 4590

Media anchoring violation: one of the legs left India. Most likely the agent leg in browser mode.
Switch the organisation (Settings → Calling → Default calling mode) or the agent to **Agent's
phone** and confirm with Plivo support whether WebRTC is anchored in India for your account.

### "Calling not configured" banner

No telephony provider resolved for the tenant: add Plivo credentials in Integrations (or, in
development only, set `ALLOW_MOCK_PROVIDER=true`).

### The agent's browser does not register

Check the device panel on the agent screen (microphone permission, Plivo login). Token errors
appear in Integrations as the last error. Corporate networks must allow WebRTC media (UDP) to
Plivo; otherwise use phone mode.

### Redis is down

Readiness turns `down`, dialling and imports pause, realtime updates stop (pages still refresh
from the API). Nothing is lost in Postgres. After Redis returns, queued jobs resume and the
pending-events sweep re-applies stored provider events.

### A migration failed during deployment

The `migrate` container exits non-zero and Compose does not start the new API or worker. Read
`docker compose logs migrate`. Fix the cause, then `docker compose up -d`. For a partially applied
migration see Prisma's `migrate resolve` documentation; never use `migrate reset` on real data.

### A user is locked out

Accounts unlock automatically after 15 minutes. An organisation admin can create a password reset
link for a member (Team → member). If the only platform administrator is locked out, an operator
re-runs bootstrap with the same email to set a new password:

```bash
docker compose run --rm api node dist/scripts/bootstrap-admin.js --email ops@example.com --allow-additional
```

### An import is stuck in "Validating" or "Importing"

The worker processes imports. Check `docker compose logs worker`; failed jobs retry with backoff
and the import page shows the error report when rows are rejected.

## Secrets rotation

* `APP_SECRET`: rotate any time; outstanding recording playback links (5 minutes) stop working.
* `DATA_ENCRYPTION_KEY`: rotating makes stored tenant credentials unreadable. Plan a window, rotate,
  then have each tenant re-enter Plivo/WhatsApp credentials (a re-encryption tool is a known gap).
* Database/Redis passwords: update the service and the `DATABASE_URL`/`REDIS_URL` together and
  restart API and worker.
* Plivo Auth Token: tenants update it in Integrations; calls already in flight keep verifying with
  the previous token only until the new one is saved, so rotate between calling sessions.

## Data requests

* Delete a lead (and its notes and timeline) from the lead page; recordings follow their retention.
* Export a lead list (permissioned, audited, formula-safe CSV).
* Add a number to the suppression list from the Compliance page to stop all future calls/messages.
