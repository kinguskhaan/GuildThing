# @guildthing/sync

Reads the GuildThing Roster and OurRecipes addons' SavedVariables files
directly and pushes them to your guild's GuildThing page — no more copying
export strings and pasting them into the website by hand.

## Setup

There are two ways to configure this, depending on whether you're syncing
one guild or several.

### One guild, one WoW install

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

### Multiple guilds and/or WoW installs

Use this if you play on more than one WoW version (e.g. Classic Era and
Anniversary/TBC in separate WTF folders) and/or are in more than one guild
that both run GuildThing — each guild has its own API key, and several
targets can point at the *same* `wtfDir` (e.g. 3 guilds you're in on the
same Anniversary install, each with its own key).

1. Create an API key per guild (**Admin > API keys** on each guild's page).
2. In this folder:
   ```bash
   pnpm install
   cp sync.config.example.json sync.config.json
   ```
3. Edit `sync.config.json` — a JSON array, one entry per guild:
   ```json
   [
     {
       "name": "classic-era",
       "apiUrl": "http://localhost:3000",
       "apiKey": "gt_...",
       "wowDir": ".../World of Warcraft",
       "version": "classic_era"
     },
     {
       "name": "tbc-anni-guild-a",
       "apiUrl": "http://localhost:3000",
       "apiKey": "gt_...",
       "wowDir": ".../World of Warcraft",
       "version": "anniversary"
     }
   ]
   ```
   `name` is just a label for log lines — pick anything readable. `wowDir`
   is the WoW install root (the folder containing `_classic_era_`,
   `_anniversary_`, `_retail_`, etc. — see the path example above);
   `version` is one of `retail`, `classic`, `classic_era`, `anniversary`,
   and picks which of those subfolders' `WTF` to read. If your install
   doesn't follow that layout, set `wtfDir` directly instead (points
   straight at the folder containing `Account`) — either works.
   `sync.config.json` is gitignored since it holds API keys — never commit
   it. For extra safety (e.g. running from a scheduled cron job) keep it
   outside the repo entirely, e.g. `~/.config/guildthing/sync.config.json`,
   and point `GUILDTHING_SYNC_CONFIG` at it.

   **Windows** (most people): just paste your path as-is, backslashes and
   all, e.g. `"C:\Program Files (x86)\World of Warcraft"` — this file's
   JSON parsing tolerates raw Windows paths, no need to double up
   backslashes by hand. (Forward slashes, `C:/Program Files (x86)/...`,
   also work if you prefer — `sync.config.example.json` uses the raw
   backslash form since that's what most people will paste in.)

   **Linux/Steam Proton:** your `wowDir` is nested under the game's
   compatdata folder, e.g.
   `~/.local/share/Steam/steamapps/compatdata/<id>/pfx/drive_c/Program Files (x86)/World of Warcraft`.

   `sync.config.json` in this folder is picked up automatically. To use a
   different path/filename (e.g. for a second machine), set
   `GUILDTHING_SYNC_CONFIG=/path/to/config.json` in `.env` or the shell
   environment.

If `sync.config.json` exists it's used and `.env`/`WOW_WTF_DIR` is ignored;
otherwise it falls back to the single-guild `.env` setup above.

## Running

```bash
pnpm start          # watch mode — syncs automatically a few seconds after
                     # you log in/out of WoW, runs until you stop it
pnpm start:once      # one sync, then exit — for cron/Task Scheduler
```

Watch mode is the "just log into WoW and forget about it" option — it
polls both addons' SavedVariables files every 15s (once per WoW install,
even if several guild targets share it) and syncs ~5s after either one
changes (debounced, since WoW touches several addons' files close
together on logout).

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
- **Discord roles and a unified audit log, back down into the game.**
  After pushing the above, this also pulls current Discord role names and
  the merged rank-change/manual-role-change history for the guild, and
  writes them into `SyncData.lua` in the addon's own **install folder**
  (`Interface/AddOns/GuildThing/`, not the WTF/SavedVariables folder) —
  shown in its "Discord Roles" and "Audit Log" tabs. That's a plain addon-
  code file, not a `## SavedVariables:` entry — same trick TSM's
  AppHelper addon uses for its desktop-app data — so it's re-read fresh
  from disk on every addon load, including a plain `/reload`, and is never
  at risk of being clobbered by WoW's save-on-teardown the way a
  SavedVariables file would be. This is still **not live**: WoW addons
  can't make network calls at all, so the data you see in-game is only as
  fresh as your last sync run, and needs a `/reload` (or login) to actually
  load into the addon. Clicking "Request sync" in that tab is a separate,
  smaller piece that's still SavedVariables-based (it's addon-authored
  state, not externally written, so it doesn't have this problem) — it
  sets a flag this script picks up on its *next* run (so, up to your poll
  interval later, and still needs its own `/reload`/logout to flush to
  disk before this script can see it), which nudges the bot's role resync
  to happen sooner than the daily automatic one. None of this is instant.

Peer-relayed data (recipes picked up through OurRecipes' P2P mesh from
other players) isn't pushed yet — only your own characters' own scans.
