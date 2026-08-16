# @guildthing/bot

## 0.2.0

### Minor Changes

- f5dee71: Onboarding now optionally verifies unmatched character names against the Battle.net Game Data API (configured per-guild on the Discord onboarding roles admin page):

  - Nonexistent characters are flagged immediately instead of being silently queued for retry.
  - Characters Battle.net confirms are really in this guild get a confident "will resolve automatically" message.
  - Characters in a different guild (or none) are tracked separately, get level-range channel access only, and auto-promote to full membership once the local roster import catches up — no need to re-run `/onboarding`.
  - PUGs are required to provide a real, verifiable character name when this is configured.

  Also replaces the separate "include alts in nickname?" and "preferred nickname?" onboarding questions with one unified choice, backed by a new admin-editable nickname override.

### Patch Changes

- f5dee71: Daily-mode event-create buttons no longer get reposted (and mark the channel unread for everyone) when nothing has been posted there since the last repost.
- Updated dependencies [f5dee71]
  - @guildthing/db@0.2.0
