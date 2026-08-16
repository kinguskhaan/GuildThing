---
"@guildthing/bot": minor
"@guildthing/web": minor
"@guildthing/db": minor
---

Adds a per-guild "Mutually exclusive roles" list (Role rules tab) — an ordered set of Discord roles where a person can only ever hold the highest-priority one, even if a different rule fires for one of their other characters (e.g. a main that's Core Raider and an alt that only qualifies as a regular Guildie). Applies automatically wherever roles get synced: onboarding, the daily background resync, and force-sync. Anything outside the list is unaffected — channel grants, class roles, the PUG role, etc.
