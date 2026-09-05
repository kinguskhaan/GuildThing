---
version: 1
slug: "src-app-guilds-guildslug-admin-raid-comp-page-tsx"
primary_target: "apps/web/src/app/guilds/[guildSlug]/admin/raid-comp/page.tsx"
related_targets: []
---

# Surface brief: Raid Comp (admin/raid-comp)

Scope: officer/GM-only raid composition builder at /guilds/[guildSlug]/admin/raid-comp. Operate mode.

Audience: guild officers assembling raid comps from the roster; browse is officer-only, comps saved per guild.

Job: drag roster names into a dynamic set of group boxes; class+spec auto-syncs from Battle.net (manual fallback); live raid buff/debuff coverage per guild expansion.

## Direction contract

THESIS: The comp is a modular block wall — every filled slot is a snap-block carrying its class icon and class color, and the raid's buff coverage reads as solid bands under the wall. Refuses the wowtbc default of a flat empty-slot grid: blocks, not holes.

OWN-WORLD: Discord-native admin surface — base/elevated tiers, pill controls, one blurple accent; class colors enter only as game data semantics on blocks and coverage bands.

STORY: The officer sees the guild's roster within reach, snaps people into blocks, and instantly reads what the comp covers and what it lacks — before raid night.

FIRST VIEWPORT: Full-height workbench: left roster drawer (search + class filter, icon rows), center block canvas of group boxes (default group count per expansion, Add Group), right/bottom coverage band; primary action is the roster itself.

FORM: Chosen structure (Dumbar modular). Bench group holds unplaced picks.

SIGNATURE INTERACTION: Drag or click a roster row and the block snaps in with its icon at once — placement never waits on a server round-trip; spec fills in as it syncs.

## Unresolved

None open; build-time verification of classicann specializations endpoint and spec-icon asset sourcing happen inside the build.
