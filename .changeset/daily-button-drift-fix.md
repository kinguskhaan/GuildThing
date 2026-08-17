---
"@guildthing/bot": patch
---

A channel's "Create new event" button set to "daily" reposition mode still moved to the bottom on every single message, defeating the whole point of that setting. The 60s drift-fallback check (meant as a bot-restart safety net for "live" mode) wasn't excluding "daily"-mode buttons, so it kept deleting and recreating them the moment anything else got posted. It now only touches "live"-mode buttons — "daily" mode is fully handled by its own once-a-day check.
