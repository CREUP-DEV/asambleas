# syntax=docker/dockerfile:1.7

FROM node:22 AS base
WORKDIR /app

RUN corepack enable \
  && npm cache clean --force

FROM base AS builder

# Read by nuxt.config.ts at build time (i18n base URL, Umami module): the
# runtime value in the VPS .env does not change what the bundle embeds.
ARG NUXT_SITE_URL
ARG NUXT_PUBLIC_UMAMI_HOST
ARG NUXT_PUBLIC_UMAMI_WEBSITE_ID

ENV NUXT_SITE_URL=${NUXT_SITE_URL}
ENV NUXT_PUBLIC_UMAMI_HOST=${NUXT_PUBLIC_UMAMI_HOST}
ENV NUXT_PUBLIC_UMAMI_WEBSITE_ID=${NUXT_PUBLIC_UMAMI_WEBSITE_ID}
# `nuxt build` runs out of Node's default heap. Builder stage only.
ENV NODE_OPTIONS=--max-old-space-size=4096

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile

COPY . .

RUN NODE_ENV=production pnpm run build && pnpm run build:ops

RUN mkdir -p /app/storage/exports /app/storage/uploads

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runner

# Links the GHCR package to the repository, so it inherits the repository's
# access instead of starting as a private package nobody else can pull.
LABEL org.opencontainers.image.source="https://github.com/CREUP-DEV/asambleas" \
  org.opencontainers.image.description="CREUP Asambleas"

WORKDIR /app

ENV NODE_ENV=production \
  NITRO_PORT=3000 \
  HOST=0.0.0.0 \
  TZ=Europe/Madrid \
  EXPORT_STORAGE_DIR=/app/storage/exports \
  UPLOAD_STORAGE_DIR=/app/storage/uploads

# The VPS deploy user is uid 1000 too, so the bind-mounted data directories it
# creates stay writable by the app.
USER 1000:1000

COPY --from=builder --chown=1000:1000 /app/.output /app/.output
# Migrations, the RBAC seed and the one-off slug recalculation, bundled with
# their packages (pnpm build:ops): the image carries no node_modules besides
# the one inside .output.
COPY --from=builder --chown=1000:1000 /app/dist/ops/migrate.mjs /app/dist/ops/seed.mjs /app/dist/ops/reslug-documents.mjs /app/ops/
COPY --from=builder --chown=1000:1000 /app/drizzle/meta /app/drizzle/meta
COPY --from=builder --chown=1000:1000 /app/drizzle/*.sql /app/drizzle/
COPY --from=builder --chown=1000:1000 /app/storage /app/storage

EXPOSE 3000
# /api/health answers 404 to proxied requests, so it only works from inside.
# Distroless has no `node` on PATH: the binary is /nodejs/bin/node.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=3s --retries=3 CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.NITRO_PORT||'3000')+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["/app/.output/server/index.mjs"]
