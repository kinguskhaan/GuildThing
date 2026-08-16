---
"@guildthing/bot": minor
"@guildthing/web": minor
"@guildthing/db": minor
---

- The "real character, not a guild member" admin notice now names the source ("looked up via BNet API") and lists the person's other, actual guild characters for context, e.g. `heretic9962 (real characters: \`Nanceyy\`) typed \`Lokfang\` (no guild) ...`.
- New "Claim a character" admin tool (Members page) — manually claims a character for a Discord account. If the name already exists as an unclaimed roster row, claims it as-is; otherwise creates a new row that survives future addon re-imports (previously impossible for an out-of-guild alt, since a plain manual DB row would get wiped on the next import).
- The Nicknames panel now also shows each member's actual current Discord server nickname and last-tracked activity date, next to the computed/override columns — no more guessing whether "computed" ever actually landed.
