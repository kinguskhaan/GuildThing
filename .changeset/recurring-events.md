---
"@guildthing/web": minor
"@guildthing/bot": minor
"@guildthing/db": minor
---

Events can now repeat: the web create form has a "Repeat every N days" option. When a recurring event's occurrence naturally expires (24h after its date, same as any other event), the bot automatically spawns the next one — same title, description, image, channel, roles, and proposed times, dated N days later — and posts it fresh with no carried-over signups. The event card shows a "🔁 Repeats" field, and the events list shows a matching badge. Manually cancelling an occurrence stops the series instead of continuing it.
