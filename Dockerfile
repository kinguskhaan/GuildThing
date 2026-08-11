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
# --chown matters here specifically: this directory is also the
# sqlite-data volume's mount point (see docker-compose.yml) — Docker seeds
# a fresh named volume from the image content at that path, ownership
# included, and the container runs as the non-root `nextjs` user below, so
# a root-owned seed means it can never create/open db.sqlite there.
COPY --from=builder --chown=nextjs:nodejs /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/packages/db/generated ./packages/db/generated

RUN mkdir -p apps/web/.next && chown nextjs:nodejs apps/web/.next

# Next's standalone output (built with outputFileTracingRoot pointing at the
# monorepo root, see apps/web/next.config.js) mirrors the workspace layout —
# apps/web/server.js plus a pruned root node_modules covering every
# workspace package it traced (@guildthing/db, @guildthing/wowhead-data).
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

# prisma CLI (needed at runtime for `db push`, not part of the standalone
# trace) — pnpm puts its .bin shim under packages/db/node_modules (prisma's
# a devDependency of that package specifically, not the workspace root), so
# root node_modules alone isn't enough; the shim script also needs the
# .pnpm virtual store it resolves into, hence copying the whole root
# node_modules too rather than cherry-picking.
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=nextjs:nodejs /app/packages/db/node_modules ./packages/db/node_modules

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && chown nextjs:nodejs docker-entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]

# ---- bot-runner: minimal production image for apps/bot ----
# discord.js bot has no build step (no bundler, no compiled JS output) — it
# runs its TypeScript source directly via tsx (a real `dependencies` entry
# in apps/bot/package.json for exactly this reason, not just a dev tool
# here). So instead of tracing a build like the web runner does, this just
# copies the source plus the node_modules pnpm actually installed for it.
FROM base AS bot-runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 bot

# --chown matters here specifically — see the matching comment on the
# runner stage above (same sqlite-data volume, mounted at this same path).
COPY --from=builder --chown=bot:nodejs /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/packages/db/generated ./packages/db/generated
COPY --from=builder /app/packages/db/src ./packages/db/src
COPY --from=builder /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder /app/apps/bot/src ./apps/bot/src
COPY --from=builder /app/apps/bot/package.json ./apps/bot/package.json

# Root node_modules for its .pnpm virtual store (the packages/db and
# apps/bot bin shims below both resolve into it) and root-level tsx;
# packages/db/node_modules for the prisma CLI (db push at startup, same
# reasoning as the web runner); apps/bot/node_modules for discord.js and
# the @guildthing/db workspace symlink, which pnpm's isolated layout only
# exposes at the package's own node_modules, not the root.
COPY --from=deps --chown=bot:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=bot:nodejs /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps --chown=bot:nodejs /app/apps/bot/node_modules ./apps/bot/node_modules

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && chown bot:nodejs docker-entrypoint.sh

USER bot

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node_modules/.bin/tsx", "apps/bot/src/index.ts"]
