# Community / compose watcher image. Build from the repo root:
#   docker build -f packages/watcher/Dockerfile -t chronicle-watcher .
FROM node:20-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/watcher ./packages/watcher
# watcher's package.json lists demo-site as a workspace devDependency; a stub package.json is enough to install.
COPY packages/demo-site/package.json ./packages/demo-site/package.json

RUN pnpm install --frozen-lockfile --filter @chronicle/watcher... \
  && pnpm --filter @chronicle/core build \
  && pnpm --filter @chronicle/watcher build \
  && pnpm --filter @chronicle/watcher deploy --prod /deploy

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home chronicle

WORKDIR /app
COPY --from=build /deploy ./
COPY watchlist.json ./watchlist.json

ENV NODE_ENV=production \
    WATCHER_HEALTH_PORT=8081 \
    DATA_DIR=/data \
    WATCHLIST_PATH=/app/watchlist.json

RUN mkdir -p /data && chown -R chronicle:chronicle /app /data
USER chronicle
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WATCHER_HEALTH_PORT||8081)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/main.js"]
