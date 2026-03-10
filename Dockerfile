FROM oven/bun:1-alpine AS base
WORKDIR /app

# Install dependencies (separate layer for caching)
FROM base AS deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile --production

# Final image — copy source and run directly with Bun (no build step needed)
FROM base
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package.json tsconfig.json ./

ENV NODE_ENV=production
CMD ["bun", "run", "src/index.ts"]
