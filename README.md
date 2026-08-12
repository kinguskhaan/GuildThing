# GuildThing

Guild management webtool + Discord bot for World of Warcraft guilds. T3 stack monorepo (Next.js, Prisma/SQLite, tRPC, Better Auth) with a companion Discord bot and an in-game addon.

## Struktur

```
apps/
  web/     Next.js-appen (@guildthing/web)
  bot/     Discord-bot (@guildthing/bot)
  addon/   WoW-addon, paketeras separat (@guildthing/addon)
packages/
  db/               Prisma-schema + genererad klient, delas av web och bot
  wowhead-data/     Data/synk mot Wowhead
```

Delad SQLite-databas (`packages/db/prisma/db.sqlite`) mellan web och bot.

## Köra med Docker Compose

Snabbaste vägen, kräver ingen lokal Node/pnpm-installation.

1. Kopiera env-filen och fyll i värden:
   ```bash
   cp .env.example .env
   ```
   Sätt minst `BETTER_AUTH_SECRET`, `BETTER_AUTH_DISCORD_CLIENT_ID`/`SECRET`, `DISCORD_BOT_TOKEN` och `GUILD_CREATOR_EMAIL`. `DATABASE_URL` i `.env` används bara lokalt (pnpm dev) — i Docker sätts den redan i `docker-compose.yml` och pekar in i containerns filsystem, så du behöver inte ändra den för Docker-körning.

2. Bygg och starta:
   ```bash
   docker compose up --build
   ```
   Detta startar två tjänster:
   - `app` — webbappen, exponerad på `http://localhost:3308`
   - `bot` — Discord-boten

   Båda delar SQLite-databasen via volymen `sqlite-data`, och kör `prisma db push` mot den vid start (se `docker-entrypoint.sh`).

3. Stoppa:
   ```bash
   docker compose down
   ```
   (Lägg till `-v` om du även vill ta bort `sqlite-data`-volymen och nollställa databasen.)

Efterföljande starter kan köras utan `--build` (`docker compose up`) så länge inget i `Dockerfile`, dependencies eller källkod ändrats sedan senaste bygget.

## Köra lokalt (utan Docker)

Kräver Node 20+ och pnpm (version pinnad i `package.json` → `packageManager`, hämtas automatiskt via corepack).

```bash
corepack enable
pnpm install
cp .env.example .env   # fyll i värden, se ovan
```

`DATABASE_URL` i `.env` måste vara en absolut sökväg till `packages/db/prisma/db.sqlite` i din checkout (kommentaren i `.env.example` förklarar varför relativ path inte funkar i monorepot).

Skapa databasen:
```bash
pnpm db:push
```

Starta webbappen (dev):
```bash
pnpm dev
```

Starta boten (dev, i ett annat terminalfönster):
```bash
pnpm --filter @guildthing/bot dev
```

## Övriga scripts

| Kommando | Vad det gör |
|---|---|
| `pnpm build` | Bygger alla appar (turbo) |
| `pnpm lint` / `pnpm lint:fix` | Lint över hela monorepot |
| `pnpm typecheck` | Typkontroll över hela monorepot |
| `pnpm check` | Lint + typecheck |
| `pnpm db:generate` | Generera Prisma-klient |
| `pnpm db:migrate` | Kör Prisma-migrationer |
| `pnpm db:studio` | Öppna Prisma Studio |
| `pnpm wowhead:sync` | Synka data från Wowhead |
| `pnpm addon:package` | Paketera WoW-addonet |

## Stack

[Next.js](https://nextjs.org) · [Better Auth](https://www.better-auth.com/) · [Prisma](https://prisma.io) (SQLite) · [tRPC](https://trpc.io) · [Tailwind CSS](https://tailwindcss.com) · [discord.js](https://discord.js.org) · [Turborepo](https://turbo.build/repo)
