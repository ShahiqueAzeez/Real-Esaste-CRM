# syntax=docker/dockerfile:1.7
#
# Web front end (Next.js standalone server). Build from the repository root:
#   docker build -f apps/web/Dockerfile -t calling-crm/web .
#
# The browser always calls /api and /socket.io on its own origin; the reverse proxy (Caddy, an
# ALB) routes those paths to the API. API_INTERNAL_URL is only used when the web container is
# reached directly, and NEXT_PUBLIC_* values are compiled into the client bundle at build time.
#
# Behind a TLS-intercepting proxy, pass the proxy with --build-arg HTTPS_PROXY=... and its CA with
# --secret id=extra_ca,src=/path/to/ca.pem. Neither ends up in the image.

ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.base.json ./
COPY tools/stubs tools/stubs
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=extra_ca --mount=type=cache,target=/root/.npm \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund -w @crm/shared -w @crm/web --include-workspace-root
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG API_INTERNAL_URL=http://api:4000
ARG NEXT_PUBLIC_SOCKET_URL=
ARG NEXT_PUBLIC_PRODUCT_NAME=
ENV API_INTERNAL_URL=${API_INTERNAL_URL} \
    NEXT_PUBLIC_SOCKET_URL=${NEXT_PUBLIC_SOCKET_URL} \
    NEXT_PUBLIC_PRODUCT_NAME=${NEXT_PUBLIC_PRODUCT_NAME}
RUN npm run build -w @crm/shared && NODE_ENV=production npm run build -w @crm/web

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
