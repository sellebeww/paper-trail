# Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
#
# Production images, one shared build. Pick the image with --target:
#   docker build --target api     -t paper-trail-api .
#   docker build --target worker  -t paper-trail-worker .
#   docker build --target web     -t paper-trail-web .
#   docker build --target migrate -t paper-trail-migrate .   # one-off: prisma migrate deploy (and db:role)
# Base images are floating tags; pin them by digest for a real deployment (docs/SECURITY.md).

ARG NODE_IMAGE=node:22-alpine

# ---- build: install everything, compile every package, then prune per app ------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store
RUN pnpm build
# Production-only node_modules per app, with the workspace packages copied in (no symlinks into /repo).
# The explicit store makes deploy reuse what install downloaded (it would otherwise pick a store next to /out).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @paper-trail/api deploy --legacy --prod --ignore-scripts --prefer-offline --store-dir=/pnpm/store /out/api && \
    pnpm --filter @paper-trail/worker deploy --legacy --prod --ignore-scripts --prefer-offline --store-dir=/pnpm/store /out/worker && \
    # @prisma/client lists the Prisma CLI as a peer dependency; the running API only needs the generated client.
    cd /out/api/node_modules && rm -rf .pnpm/prisma@* .pnpm/@prisma+studio-core* .pnpm/@prisma+dev@* .pnpm/@prisma+engines@* \
      .pnpm/@electric-sql+pglite* .pnpm/typescript@* .pnpm/effect@* .pnpm/elkjs@* .pnpm/react-dom@* .pnpm/react@* prisma

# ---- api -------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production API_PORT=3000 STORAGE_DIR=/data/files
WORKDIR /app
COPY --from=build --chown=node:node /out/api .
# Uploaded files: mount a volume here (or unset STORAGE_DIR and configure S3_*).
RUN mkdir -p /data/files && chown -R node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.API_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]

# ---- worker ----------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/worker .
# Public roots of the suggested TSAs (docs/OPERATIONS.md): TSA_CA_CERTS=/app/tsa-roots.pem. Check their fingerprints.
COPY --chown=node:node deploy/tsa-roots.pem ./tsa-roots.pem
USER node
# Exits on broker loss by design: run it under a supervisor that restarts it (restart: unless-stopped).
CMD ["node", "dist/index.js"]

# ---- migrate: the full build, for prisma migrate deploy and the worker's db:role --------------------------
FROM build AS migrate
CMD ["pnpm", "--filter", "@paper-trail/api", "db:migrate"]

# ---- web: static build behind nginx, which also proxies /api/ to the API ---------------------------------
FROM nginxinc/nginx-unprivileged:1.31-alpine AS web
ENV API_UPSTREAM=http://api:3000 CLIENT_MAX_BODY_SIZE=16m
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
