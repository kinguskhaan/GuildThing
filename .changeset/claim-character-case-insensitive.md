---
"@guildthing/web": patch
---

"Claim a character" matched roster rows with an exact-case lookup, so claiming e.g. "msparker" when the roster already had "Msparker" silently created a second duplicate row instead of updating the existing one. The lookup is now case-insensitive, matching how the bot itself matches character names during onboarding.
