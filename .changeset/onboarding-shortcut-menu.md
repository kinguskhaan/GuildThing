---
"@guildthing/bot": minor
---

Running `/onboarding` (or clicking "Start Onboarding") again after you've already onboarded now gets you a shortcut menu instead of the full flow from scratch: **Add an alt**, **Change nickname**, **Show characters** (lists what's on file, including any still pending a roster match), **Update characters** (re-run the questions — additive, doesn't remove anything not mentioned), and **Reset everything** (with a confirmation step — unclaims your characters, clears your nickname override, and strips roles/channel access immediately instead of waiting for the next daily sync).

Also:
- Timing out partway through onboarding (e.g. missing the "add another alt?" question) no longer throws away everything you'd already entered — whatever you'd answered gets saved and your roles/nickname set up for it, with a DM explaining what happened.
- DMs sent by background jobs (timeout recovery, the pending-roster-match retry, "you're done") now say which server they're about, since a plain DM gives no other clue if you're in more than one GuildThing server.
- Fixed a bug where the very first prompt of a run — when started from the standing public "Start Onboarding" button — could edit that public channel message in place instead of replying privately, momentarily showing onboarding questions to the whole channel.
