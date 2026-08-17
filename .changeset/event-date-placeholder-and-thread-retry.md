---
"@guildthing/bot": patch
---

- The event-create modal's date/time placeholder and parse-error message now show a real, always-current example date (tomorrow's) instead of one that quietly aged into the past.
- If posting an event's message succeeds but attaching its discussion thread fails (e.g. missing "Create Public Threads" in that specific channel), the message is now kept and reused on retry instead of a duplicate being posted every time the event re-syncs.
