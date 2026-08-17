---
"@guildthing/bot": minor
---

The event Edit modal now has a "Roles" field, pre-filled with the event's current composition — so forgetting to add DPS slots (or any other role) when creating an event no longer means recreating the whole post. Existing role names are matched case-insensitively and just get their capacity/emoji updated; new names get created. A role name removed from the text is only deleted if nobody's signed up for it — one with existing signups is left untouched instead of wiping people's spots, and reappears pre-filled next time you edit.
