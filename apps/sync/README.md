# @guildthing/sync

Reads the GuildThing Roster and OurRecipes addons' SavedVariables files
directly and pushes them to your guild's GuildThing page — no more copying
export strings and pasting them into the website by hand.

## Setup

1. On your guild's page, go to **Admin > API keys** and create one. Copy
   the key now — you won't see it again.
2. In this folder:
   ```bash
   pnpm install
   cp .env.example .env
   ```
3. Fill in `.env`:
   - `GUILDTHING_API_URL` — your GuildThing instance's URL.
   - `GUILDTHING_API_KEY` — the key from step 1.
   - `WOW_WTF_DIR` — only needed on Linux/Steam Proton (Windows is
     detected automatically). Point it at the folder containing `Account`,
     e.g.
     `.../steamapps/compatdata/<id>/pfx/drive_c/Program Files (x86)/World of Warcraft/_anniversary_/WTF`.

## Running

```bash
pnpm start          # watch mode — syncs automatically a few seconds after
                     # you log in/out of WoW, runs until you stop it
pnpm start:once      # one sync, then exit — for cron/Task Scheduler
```

Watch mode is the "just log into WoW and forget about it" option — it
polls both addons' SavedVariables files every 15s and syncs ~5s after
either one changes (debounced, since WoW touches several addons' files
close together on logout).

If you'd rather run it on a fixed schedule instead of leaving it running:

**cron** (Linux/Mac), e.g. every 30 minutes:
```cron
*/30 * * * * cd /path/to/GuildThing/apps/sync && pnpm start:once >> sync.log 2>&1
```

**Windows Task Scheduler**: create a task that runs
`pnpm start:once` with "Start in" set to this folder, triggered on a
schedule or at login.

## What gets synced

- **Roster** (name/rank/level/class/notes) from the GuildThing Roster
  addon — full replace each time, same as pasting a fresh `/gtr` export.
- **Professions/recipes** from OurRecipes, for every character on the
  account — full replace per character. If a character's already been
  claimed by a real Discord member (through onboarding), this only
  updates its professions and never touches who owns it.

Peer-relayed data (recipes picked up through OurRecipes' P2P mesh from
other players) isn't pushed yet — only your own characters' own scans.
