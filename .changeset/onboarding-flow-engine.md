---
"@guildthing/bot": minor
"@guildthing/web": minor
"@guildthing/db": minor
---

Onboarding is now 100% admin-built: the bot's hardcoded fixed steps (the "guild member or PUG?" ask, the character-name prompts, the alts loop, and the forced nickname) are gone. The flow editor's canvas gains three new step types — **condition** (branch junction whose outgoing wires carry the condition), **action** (claim characters with Battle.net verification, assign PUG, set nickname from a `{variable}` template, grant roles/channels directly, send a DM), and **loop** (repeat a body chain, e.g. collecting alts into a list) — alongside the existing question steps. Collected answers become variables (`{main}`, `{alts}`, …) that later prompts, nickname templates, and DM templates can reference.

Role rules gain a new condition source: **onboarding answer** — a rule can now require that a member answered a specific question with one of its options ("members who answered *What role do you want?* with *Tank* get @Tank-lärling"), composable with the existing rank/level/class conditions. Persisted answers are re-evaluated on every sync, not just at onboarding time.

The two separate sections "Role rules" and "Onboarding" on the Discord Server Controls page are merged into one section, **Onboarding & rollregler** — the flow canvas and the rule editor (with answer conditions) live side by side, and the read-only rules reference inside the question editor is gone.

Migration: existing guilds' question graphs and answers are copied to the new flow storage on first bot start (or when the admin page is loaded), wrapped in a default flow that reproduces the old fixed steps as editable nodes — nothing is lost, everything is now rewirable. Legacy tables stay in the database (read-only) until a later cleanup.