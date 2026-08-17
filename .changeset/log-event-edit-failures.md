---
"@guildthing/bot": patch
---

The event-edit modal's handler silently swallowed every error (not just an actual timeout) with no logging at all — an edit that saved to the database but then failed to re-render the Discord message left no trace anywhere. Now only a genuine collector timeout stays silent; anything else gets logged.
