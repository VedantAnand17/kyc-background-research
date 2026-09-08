# Multi-stage image for the research API. PRD.md section 18 M1.
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
# pnpm-workspace.yaml carries the allowBuilds list; without it pnpm refuses better-sqlite3's native build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build \
  && cp src/db/schema.sql dist/db/schema.sql

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable \
  && groupadd --system app \
  && useradd --system --gid app --home /app app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=deps /app/node_modules ./node_modules
RUN pnpm prune --prod
COPY --from=build /app/dist ./dist
USER app
EXPOSE 3000
CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
