# Deployment

Nothing in this repository deploys itself, buys services or places real calls. Every option below
is run by an operator who has the accounts, budget approval and the compliance prerequisites in
`docs/COMPLIANCE_INDIA.md`.

The application is three processes built from two images:

| Process | Image | Command | Scales |
|---|---|---|---|
| API (REST, Socket.IO, webhooks) | `calling-crm/api` | `node dist/main.js` | Horizontally. Stateless: sessions in Postgres, rate limits and realtime fan-out in Redis. |
| Worker (queues, dialler legs, imports, WhatsApp, sweeps) | `calling-crm/api` | `node dist/worker.js` | Horizontally. BullMQ distributes jobs; maintenance schedules are upserted idempotently. |
| Migrations (one-off, before each release) | `calling-crm/api` | `/app/node_modules/.bin/prisma migrate deploy` | Run once per release. |
| Web (Next.js) | `calling-crm/web` | `node apps/web/server.js` | Horizontally. |

Required backing services: PostgreSQL 16, Redis 7 with `maxmemory-policy noeviction`, a reverse
proxy or load balancer that sends `/api/*` and `/socket.io/*` to the API and everything else to the
web app on **one origin**, and a public HTTPS URL for Plivo and Meta webhooks.

## Build the images

```bash
docker build -f apps/api/Dockerfile -t calling-crm/api:1.0.0 .
```

```bash
docker build -f apps/web/Dockerfile -t calling-crm/web:1.0.0 --build-arg NEXT_PUBLIC_PRODUCT_NAME="Calling CRM" .
```

Run both from the repository root. `NEXT_PUBLIC_*` values are compiled into the browser
bundle, so set them at build time. Behind a TLS-intercepting corporate proxy add
`--build-arg HTTPS_PROXY=…` and `--secret id=extra_ca,src=<ca.pem>`; behind a blocked Debian mirror,
`--build-arg DEBIAN_MIRROR=<mirror>` (the API image installs OpenSSL for Prisma).

## Option A: one server with Docker Compose

Suitable for a pilot with a few agencies. Tested end to end in this repository's build environment
(all containers healthy, browser suite passing through Caddy).

1. A Linux VM (2 vCPU / 4 GB is enough for a pilot) with Docker Engine and the Compose plugin, in
   India (for example AWS `ap-south-1`) to keep latency and data location local.
2. DNS `A` record, for example `crm.example.com`, pointing at the server; inbound 80 and 443 open.
3. `cp .env.example .env` and set:
   * the four secrets (see the comments in the file),
   * `PUBLIC_BASE_URL=https://crm.example.com`, `WEB_ORIGIN=https://crm.example.com`,
   * `SITE_ADDRESS=crm.example.com`, `HTTP_PORT=80`, `HTTPS_PORT=443` (Caddy obtains and renews
     the certificate automatically),
   * `ALLOW_MOCK_PROVIDER=false`, `ALLOW_MOCK_CONTROLS=false`, `WHATSAPP_ALLOW_MOCK=false`,
   * `SMTP_URL` and `MAIL_FROM`.
4. `docker compose up -d --build` (migrations run first, then the API, worker, web and Caddy).
5. Create the first platform administrator and the example plans:

   ```bash
   docker compose run --rm api node dist/scripts/bootstrap-admin.js --email ops@example.com --name "Ops" --with-example-plans
   ```

   The generated password is printed once.
6. Set up backups (`docs/OPERATIONS.md`) and copy them off the server.

Upgrades: `git pull && docker compose up -d --build`. The `migrate` service runs before the new
API and worker start.

## Option B: AWS reference architecture

Region `ap-south-1` (Mumbai). Everything below is standard managed AWS; sizes are starting points.

```
Route 53 ─► ALB (HTTPS, ACM certificate) ─┬─ /api/*, /socket.io/* ─► ECS service "api"    (Fargate, 2+ tasks)
                                          └─ default               ─► ECS service "web"    (Fargate, 2 tasks)
                                             ECS service "worker" (Fargate, 1–2 tasks, no load balancer)
                                             ECS task "migrate"   (run once per release)
Private subnets: RDS PostgreSQL 16 (Multi-AZ) · ElastiCache Redis 7 · S3 bucket (recordings, imports)
Secrets Manager / SSM Parameter Store · CloudWatch Logs and alarms · ECR (images)
```

**Networking.** VPC with public subnets for the ALB and private subnets for tasks, RDS and Redis.
Security groups: ALB → api:4000 and web:3000 only; tasks → RDS 5432, Redis 6379; outbound HTTPS
for Plivo, Meta and SES (NAT gateway or VPC endpoints for S3, ECR, CloudWatch, Secrets Manager).

**Load balancer.** Listener rules: `/api/*` and `/socket.io/*` to the API target group, default to
the web target group. Health checks: API `/api/health/live`, web `/login`. Enable **stickiness**
(load-balancer cookie) on the API target group: Socket.IO tries WebSocket first, but its HTTP
long-polling fallback needs consecutive requests on the same task. Keep the idle timeout at or
above 60 seconds. Set `TRUST_PROXY=1` when the ALB talks to the tasks directly.

**Database.** RDS PostgreSQL 16, Multi-AZ, encrypted with KMS, automated backups with
point-in-time recovery (7–35 days), deletion protection, `rds.force_ssl=1`. Use
`?sslmode=require&connection_limit=10` in `DATABASE_URL` and keep
`tasks × connection_limit` below the instance's `max_connections`.

**Redis.** ElastiCache for Redis 7 (cluster mode disabled), parameter group with
`maxmemory-policy noeviction` (BullMQ requirement), in-transit encryption and an AUTH token:
`REDIS_URL=rediss://:<token>@<primary-endpoint>:6379/0`. Redis holds queues and short-lived state;
Postgres is the system of record.

**Files.** `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION=ap-south-1`. Block all public access,
enable versioning, default encryption, and a lifecycle rule that expires `imports/` objects after a
few weeks. Grant the task role `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on the bucket
and leave `AWS_ACCESS_KEY_ID` unset.

**Secrets and configuration.** Store `DATABASE_URL`, `REDIS_URL`, `APP_SECRET`,
`DATA_ENCRYPTION_KEY`, `SMTP_URL` and any platform `PLIVO_AUTH_TOKEN` in Secrets Manager and map
them into the task definitions' `secrets`. Non-secret variables go in `environment`. Use the same
values for API and worker. Email through Amazon SES SMTP
(`smtps://<user>:<password>@email-smtp.ap-south-1.amazonaws.com:465`) after verifying the domain.

**Releases.** Build and push images to ECR from CI → run the `migrate` task with the new API image
and wait for exit code 0 → update the `api`, `worker` and `web` services (rolling deployment).
Migrations must stay compatible with the previous release while it drains.

**Observability.** `awslogs` driver to CloudWatch Logs (the API and worker log JSON). Alarms:
ALB 5xx rate and unhealthy hosts, ECS task restarts, RDS CPU/free storage/connections, Redis
memory and evictions (must stay 0). The platform **System health** page shows queue backlogs,
unprocessed provider events, stuck calls and integration failures; exporting those as metrics is a
recommended next step.

**Scaling notes.** Calls are progressive (one call per ready agent), so load grows with agent
count, not with list size. Start with 2 API tasks (0.5 vCPU / 1 GB), 1 worker task, 2 web tasks,
`db.t4g.medium` Multi-AZ and `cache.t4g.small`, then size from CloudWatch.

## Plivo and Meta configuration after deployment

* Plivo: per tenant, Integrations → Plivo (Auth ID, Auth Token, rented caller IDs). Outbound legs
  need no Plivo application or answer URL in the console: the API passes answer, ring and hangup
  URLs on every call. Browser tokens are requested without an application ID; whether Plivo needs
  one for receive-only JWT users is confirmed in the smoke test. Enable HTTP authentication for
  recording URLs in the console.
* Meta: per tenant, see `docs/WHATSAPP.md`.
* Run the real-provider smoke test in `docs/TELEPHONY_PLIVO.md` with approved test numbers before
  any agency calls customers.

## Production environment checklist

- [ ] `NODE_ENV=production`, HTTPS `PUBLIC_BASE_URL`, `WEB_ORIGIN` equal to the public origin.
- [ ] Mock flags `false`; `ENABLE_API_DOCS=false` unless the docs are protected.
- [ ] Secrets in a secret manager; `.env` files never committed or baked into images.
- [ ] Backups configured and a restore rehearsed.
- [ ] First platform admin bootstrapped; plans reviewed under Platform → Plans.
- [ ] Smoke test passed and recorded in `BUILD_STATUS.md`.
