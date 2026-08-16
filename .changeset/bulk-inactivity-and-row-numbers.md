---
"@guildthing/web": minor
---

- New "Bulk manage inactivity" panel under the Inactive tab: search/filter members, select many at once, and reset their activity clock to now (also backfills anyone who joined but never sent a tracked message — they get today as a starting point), mark them inactive immediately, or bulk-reactivate — without waiting for the daily pass or running `/reactivate` one person at a time. Mirrors the bot's own additive-role behavior exactly.
- Every wide data table on the Members and Discord Server Controls pages (roster, nicknames, external characters, members-by-role) now shows a row number column and a total-row-count line at the bottom.
