---
"@guildthing/bot": patch
---

Cancelling an event in a plain text channel (not a forum) locked and archived the thread correctly, but left the sign-up/vote buttons on the post — the edit that's supposed to strip them was looking for the message inside the thread, when for a text-channel event it actually lives in the parent channel (the thread's just attached to it for discussion). The edit failed silently every time, so the buttons never went away. Now checks the channel's actual type instead of just "does a thread exist" to find the right message.
