#!/usr/bin/env bash
# Run the Playwright end-to-end suite against a fresh local stack in simulated mode.
# Needs PostgreSQL and Redis running locally (or E2E_DATABASE_URL / E2E_REDIS_URL) and free ports 3000/4000.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# The API runs in development mode (mock providers are refused in production); Next.js must build/run as production.
unset NODE_ENV
export DATABASE_URL="${E2E_DATABASE_URL:-postgresql://crm:crm_dev_password@localhost:5432/crm_e2e?schema=public}"
export REDIS_URL="${E2E_REDIS_URL:-redis://localhost:6379/14}"
export APP_SECRET="e2e-app-secret-not-for-production-0123456789"
export DATA_ENCRYPTION_KEY="$(printf 'e2e-only-32-byte-key-0123456789!' | base64)"
export PUBLIC_BASE_URL="http://localhost:3000" WEB_ORIGIN="http://localhost:3000" PORT=4000
export ALLOW_MOCK_PROVIDER=true ALLOW_MOCK_CONTROLS=true WHATSAPP_ALLOW_MOCK=true TELEPHONY_DEFAULT_PROVIDER=mock
export MOCK_TIME_SCALE=0.5 LOG_LEVEL=warn LOG_PRETTY=false COOKIE_SECURE=false STORAGE_DIR="$ROOT/storage/e2e"
export E2E_PLATFORM_EMAIL="${E2E_PLATFORM_EMAIL:-e2e-platform@calling-crm.test}" E2E_PLATFORM_PASSWORD="${E2E_PLATFORM_PASSWORD:-E2e-platform-pass-1}"

DB_NAME="$(node -e 'console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))')"
if ! psql "${DATABASE_URL%%\?*}" -c 'select 1' >/dev/null 2>&1; then
  echo "Creating database $DB_NAME"
  psql "$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/postgres";u.search="";console.log(u.toString())')" -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null
fi

npm run build:shared >/dev/null
(cd apps/api && npx prisma migrate deploy >/dev/null && npx tsc -p tsconfig.build.json && NODE_ENV=development SEED_PASSWORD="E2e-password-123" node dist/scripts/seed.js >/dev/null)
(cd apps/api && NODE_ENV=development BOOTSTRAP_ADMIN_PASSWORD="$E2E_PLATFORM_PASSWORD" node dist/scripts/bootstrap-admin.js --email "$E2E_PLATFORM_EMAIL" --name "E2E Platform" --allow-additional >/dev/null)
(cd apps/web && NODE_ENV=production API_INTERNAL_URL=http://localhost:4000 NEXT_PUBLIC_SOCKET_URL=http://localhost:4000 npx next build >/dev/null)

LOGS="$ROOT/storage/e2e/logs"; mkdir -p "$LOGS"
# Each server runs in its own session so cleanup can stop the whole process group (npx spawns children).
(cd apps/api && NODE_ENV=development exec setsid node dist/main.js >"$LOGS/api.log" 2>&1) & API_PID=$!
(cd apps/api && NODE_ENV=development exec setsid node dist/worker.js >"$LOGS/worker.log" 2>&1) & WORKER_PID=$!
(cd apps/web && NODE_ENV=production API_INTERNAL_URL=http://localhost:4000 exec setsid npx next start --port 3000 >"$LOGS/web.log" 2>&1) & WEB_PID=$!
cleanup() { for pid in $API_PID $WORKER_PID $WEB_PID; do kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

ready=0
for _ in $(seq 1 90); do
  if curl -sf http://localhost:4000/api/health/ready >/dev/null && curl -sf -o /dev/null http://localhost:3000/login; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then echo "Stack did not become ready; see $LOGS" >&2; tail -n 40 "$LOGS"/*.log >&2; exit 1; fi
npx playwright test -c e2e/playwright.config.ts "$@"
