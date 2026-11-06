# syntax=docker/dockerfile:1.7
#
# API, background worker and migration image. Build from the calling-crm directory:
#   docker build -f apps/api/Dockerfile -t calling-crm/api .
# One image, three commands:
#   node dist/main.js                               API (default)
#   node dist/worker.js                             queues, simulator, sweeps
#   /app/node_modules/.bin/prisma migrate deploy    apply pending migrations
#
# Behind a TLS-intercepting proxy, pass the proxy with --build-arg HTTPS_PROXY=... and its CA with
# --secret id=extra_ca,src=/path/to/ca.pem. Neither ends up in the image.

ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS base
# Prisma's engines need OpenSSL 3 (absent from the slim image; skipped when the base already has
# it, e.g. NODE_IMAGE=node:22.23.4-bookworm). DEBIAN_MIRROR lets builds use an internal mirror.
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN --mount=type=secret,id=extra_ca \
    set -eu; \
    if ! dpkg -s openssl ca-certificates >/dev/null 2>&1; then \
      sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
      if [ -s /run/secrets/extra_ca ]; then echo 'Acquire::https::CAInfo "/run/secrets/extra_ca";' > /etc/apt/apt.conf.d/99-extra-ca; fi; \
      apt-get update; \
      apt-get install -y --no-install-recommends openssl ca-certificates; \
      rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99-extra-ca; \
    fi
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1

# Workspace manifests only, so dependency layers are cached until a lockfile changes.
FROM base AS manifests
COPY package.json package-lock.json tsconfig.base.json ./
COPY tools/stubs tools/stubs
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

FROM manifests AS build
RUN --mount=type=secret,id=extra_ca --mount=type=cache,target=/root/.npm \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund -w @crm/shared -w @crm/api --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @crm/shared && npm run build -w @crm/api

FROM manifests AS prod-deps
COPY apps/api/prisma apps/api/prisma
RUN --mount=type=secret,id=extra_ca --mount=type=cache,target=/root/.npm \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund --omit=dev -w @crm/shared -w @crm/api --include-workspace-root=false && \
    cd apps/api && /app/node_modules/.bin/prisma generate && \
    mkdir -p /app/apps/api/node_modules /app/packages/shared/node_modules

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    STORAGE_DIR=/data/storage
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/api/node_modules /app/apps/api/node_modules
COPY --from=prod-deps /app/packages/shared/node_modules /app/packages/shared/node_modules
COPY --from=build /app/package.json /app/
COPY --from=build /app/packages/shared/package.json /app/packages/shared/
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/apps/api/package.json /app/apps/api/
COPY --from=build /app/apps/api/prisma /app/apps/api/prisma
COPY --from=build /app/apps/api/dist /app/apps/api/dist
RUN mkdir -p /data/storage && chown -R node:node /data
WORKDIR /app/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
