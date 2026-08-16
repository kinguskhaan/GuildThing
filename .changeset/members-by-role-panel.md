---
"@guildthing/web": minor
---

Adds a "Members by role" tab to the Discord roles admin page — pick a role, see everyone who currently holds it, uncheck the ones who shouldn't, then apply as a batch. Nothing hits Discord until you apply. A staged removal only sticks if no GuildRoleRule still grants that person the role — otherwise the next sync re-adds it, same as any other manually-touched managed role.
