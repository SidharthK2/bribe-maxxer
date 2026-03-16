FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# ── Install dependencies (cached layer) ─────────────────
FROM base AS deps
# better-sqlite3 needs build tools for native addon
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── Build TypeScript ─────────────────────────────────────
FROM base AS build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc --noEmit

# ── Runtime ──────────────────────────────────────────────
FROM base AS runtime
RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Data directory for SQLite persistence (mount as volume)
RUN mkdir -p /app/data

EXPOSE 3000

# tini handles PID 1 + signal forwarding (SIGTERM → graceful shutdown)
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
