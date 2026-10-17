# Synthetic demo government site. Build from the repo root:
#   docker build -f packages/demo-site/Dockerfile -t chronicle-demo .
FROM node:20-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core ./packages/core
COPY packages/demo-site ./packages/demo-site

RUN pnpm install --frozen-lockfile --filter @chronicle/demo-site... \
  && pnpm --filter @chronicle/core build \
  && pnpm --filter @chronicle/demo-site build \
  && pnpm --filter @chronicle/demo-site deploy --prod --legacy /deploy

FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home chronicle

WORKDIR /app
COPY --from=build /deploy ./

ENV NODE_ENV=production \
    DEMO_PORT=4000

USER chronicle
EXPOSE 4000
CMD ["node", "dist/server.js"]
