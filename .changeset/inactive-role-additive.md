---
"@guildthing/bot": minor
"@guildthing/web": patch
"@guildthing/db": minor
---

The inactivity filter no longer strips a member's existing roles when marking them inactive — it just adds the inactive role on top, leaving everything else untouched. `/reactivate` correspondingly just removes that one role instead of restoring a snapshot. Removes the now-unused `GuildMemberActivity.previousRoleIds` field.
