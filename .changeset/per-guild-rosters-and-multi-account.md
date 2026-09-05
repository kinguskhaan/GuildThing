---
"@guildthing/sync": minor
"@guildthing/web": minor
"@guildthing/addon": minor
---

- The addon now stores its roster scan per guild (`GuildThingRosterDB.rosterByGuild`) instead of one account-wide slot that the last-logged-in character overwrote. The `/gtr` export and the in-game tabs keep working exactly as before, and old SavedVariables files still sync via the legacy fallback.
- The sync script and desktop app read **every** account folder under `WTF/Account` (previously only the first one) and push each guild target the roster matching that guild's name — never another guild's roster. A guild with no matching scan on disk is skipped with a clear message instead of receiving the wrong roster.
- New `GET /api/v1/guild` endpoint so key-authenticated syncs can resolve which guild a key belongs to.
- Characters (`OurRecipes.lua`) are now collected from all accounts on the install, not just the first one.