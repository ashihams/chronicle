# Indexer API + built web UI (+ bot sources for a future Stage 6B entrypoint).
# Build from the repo root:
#   docker build -f Dockerfile.app -t chronicle-app .
FROM node:20-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY vitest.shared.ts ./

# Install workspace deps once, then build the packages the app image needs.
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @chronicle/core build \
  && pnpm --filter @chronicle/indexer build \
  && pnpm --filter @chronicle/web build \
  && pnpm --filter @chronicle/bot build \
  && pnpm --filter @chronicle/cli build

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home chronicle

WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml /app/tsconfig.base.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core ./packages/core
COPY --from=build /app/packages/indexer ./packages/indexer
COPY --from=build /app/packages/web/dist ./packages/web/dist
COPY --from=build /app/packages/bot ./packages/bot
COPY --from=build /app/packages/cli ./packages/cli

ENV NODE_ENV=production \
    PORT=8080 \
    INDEXER_DB_PATH=/data/indexer.db

RUN mkdir -p /data && chown -R chronicle:chronicle /app /data
USER chronicle
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/packages/indexer
CMD ["node", "dist/main.js"]
