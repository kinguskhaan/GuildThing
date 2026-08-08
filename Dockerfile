# syntax=docker.io/docker/dockerfile:1

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat openssl
RUN corepack enable

# ---- deps: install dependencies only ----
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/bot/package.json ./apps/bot/
COPY apps/addon/package.json ./apps/addon/
COPY packages/db/package.json ./packages/db/
COPY packages/wowhead-data/package.json ./packages/wowhead-data/
COPY packages/db/prisma ./packages/db/prisma
RUN pnpm install --frozen-lockfile

# ---- builder: build the app ----
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV SKIP_ENV_VALIDATION=1

RUN pnpm --filter @guildthing/db exec prisma generate
RUN pnpm build

# ---- runner: minimal production image ----
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/packages/db/generated ./packages/db/generated

RUN mkdir -p apps/web/.next && chown nextjs:nodejs apps/web/.next

# Next's standalone output (built with outputFileTracingRoot pointing at the
# monorepo root, see apps/web/next.config.js) mirrors the workspace layout —
# apps/web/server.js plus a pruned root node_modules covering every
# workspace package it traced (@guildthing/db, @guildthing/wowhead-data).
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

# prisma CLI (needed at runtime for `db push`, not part of the standalone trace).
# pnpm hoists via a symlinked .pnpm store, so the whole node_modules is copied
# rather than cherry-picking prisma/@prisma (their symlinks would dangle otherwise).
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && chown nextjs:nodejs docker-entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]
