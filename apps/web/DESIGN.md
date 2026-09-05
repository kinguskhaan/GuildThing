---
name: guildthing
description: Discord-native guild ops console for WoW guilds. A retro-arcade attract-mode landing sells it; the admin surfaces stay Discord-native.
colors:
  discord-rail: "#1e1f22"
  discord-sidebar: "#2b2d31"
  discord-base: "#313338"
  discord-elevated: "#383a40"
  discord-elevated-hover: "#3f4147"
  discord-text: "#f2f3f5"
  discord-text-muted: "#949ba4"
  discord-brand: "#5865f2"
  discord-brand-hover: "#4752c4"
  discord-link: "#00a8fc"
  discord-green: "#23a55a"
  discord-red: "#f23f42"
  discord-red-hover: "#da373c"
  arcade-void: "#0a0a12"
typography:
  headline:
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif"
    fontWeight: 800
  title:
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif"
    fontWeight: 700
  body:
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif"
    fontWeight: 400
  label:
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif"
    fontWeight: 700
    letterSpacing: "0.05em"
  arcade-display:
    fontFamily: "var(--font-arcade-display), sans-serif"
    fontWeight: 400
    letterSpacing: "0.025em"
  arcade-ui:
    fontFamily: "var(--font-arcade-ui), sans-serif"
    fontWeight: 600
  arcade-mono:
    fontFamily: "var(--font-arcade-mono), monospace"
    fontWeight: 400
rounded:
  sm: "4px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.discord-brand}"
    textColor: "#ffffff"
    rounded: "{rounded.full}"
    padding: "6px 16px"
  button-primary-hover:
    backgroundColor: "{colors.discord-brand-hover}"
  button-danger:
    backgroundColor: "{colors.discord-red}"
    textColor: "#ffffff"
    rounded: "{rounded.full}"
    padding: "8px 16px"
  button-danger-hover:
    backgroundColor: "{colors.discord-red-hover}"
  button-neutral:
    backgroundColor: "{colors.discord-elevated-hover}"
    textColor: "{colors.discord-text}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
  button-cta-primary:
    backgroundColor: "{colors.discord-brand}"
    textColor: "#ffffff"
    rounded: "{rounded.full}"
    padding: "12px 24px"
  button-cta-secondary:
    backgroundColor: "{colors.discord-elevated}"
    textColor: "{colors.discord-text}"
    rounded: "{rounded.full}"
    padding: "12px 24px"
  input-pill:
    backgroundColor: "{colors.discord-elevated}"
    textColor: "{colors.discord-text}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
  demo-tag:
    backgroundColor: "{colors.discord-rail}"
    textColor: "{colors.discord-text-muted}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  card:
    backgroundColor: "{colors.discord-elevated}"
    rounded: "{rounded.xl}"
    padding: "16px"
---

# Design System: guildthing

## Overview

**Creative North Star: "Discord Ops Console, with an Arcade Cabinet Bleeding Through"**

The system runs on Discord's own dark UI language, borrowed on purpose: the same rail/sidebar/base/elevated surface tiers, the same blurple brand color, the same flat, dense, utility-first density. Officers already live in Discord; the app is designed to feel like a natural extension of it rather than a separate destination they have to context-switch into. That's confirmed and correct for the Operate-mode admin surfaces (roster, role rules, audit log, settings) and should stay the default there.

The retro-arcade register now has its flagship surface: the landing page (`/`) is built as an arcade cabinet's **attract mode** — a full-viewport starfield over near-black (`#0a0a12`, `arcade-void`) with drifting pixel invaders, a display-scale marquee wordmark, and a "demo reel" of panels that plays the product's mechanism (bot log, channel rules, one-database diagram, self-host story) as the visitor scrolls. The Discord login is not a separate screen anymore — it lives inside the hero as the primary pill CTA (pending/error states included), one glance from anywhere on the page via the footer's `Log in` anchor. The register is still fenced off from the dense, high-frequency admin screens (roster tables, forms, settings), where Discord-native legibility has to win; it expands to other low-frequency, high-emotion moments (empty states, first-run/onboarding, celebratory screens) from this base rather than from the old isolated login card.

**Key Characteristics:**
- Discord's actual dark palette and surface hierarchy, not a lookalike — reuse it exactly rather than reinventing "Discord-ish" colors.
- Flat, borderless, pill-heavy interactive chrome for day-to-day admin work.
- A deliberately separate retro-arcade register (starfield motion, pixel mark, drifting invaders, near-black void, arcade type roles) that owns the landing page's attract mode and stays reserved for low-frequency, high-emotion moments.

## Colors

Borrowed near-verbatim from Discord's own dark theme, plus one system-original color for the arcade register.

### Primary
- **Discord Blurple** (`#5865f2`): the app's one accent — primary CTAs (hero login button, "BOT" tag, "one database" node), active nav state, brand mark tinting. Hover state `#4752c4`.

### Secondary
- **Arcade Void** (`#0a0a12`): the near-black backdrop of the retro-arcade register. As built, it is the **document body ground** (`globals.css` sets `body { background-color: var(--color-arcade-void) }`), so the page reads dark even before/without the particle canvas and in full-page captures. The landing plays entirely on it; admin screens still paint `discord-base` on top. Never use it for ordinary admin surfaces — its whole job is to read as "somewhere else."

### Neutral
- **Rail** (`#1e1f22`): the darkest tier — guild-icon rail, avatar backdrops, the invader mark badge, the "one database" diagram node, and the `DEMO DATA` tag background.
- **Sidebar** (`#2b2d31`): navigation surface.
- **Base** (`#313338`): the app's default admin background — and, at 90% opacity (`bg-discord-base/90` + `backdrop-blur-sm`), the translucent panel fill of the landing's demo-reel bands floating over the void.
- **Elevated** (`#383a40`): cards, panels, modals, and any surface sitting "on top of" base. Hover: `#3f4147`. On the landing it fills surface nodes, mapping-row source chips, channel pills, and secondary CTAs.
- **Text** (`#f2f3f5`): primary text on dark surfaces.
- **Text Muted** (`#949ba4`): secondary/meta text, table headers, placeholders, captions under reel bands, the `DEMO DATA` tag.

### Semantic
- **Link** (`#00a8fc`): links, and on the landing also the color of role/channel tokens in demo content (`@Raider`, `#raider-chat`), keyboard focus outlines, and footer/CTA links.
- **Success** (`#23a55a`, "Discord Green") — the landing's bot log uses it for `✓` confirmation ticks.
- **Danger** (`#f23f42`, hover `#da373c`): destructive actions and error text — including the hero's sign-in error line (`role="alert"`).

### Named Rules
**The One Accent Rule.** Blurple is the only saturated color in the day-to-day admin UI. Everything else is a neutral gray step or the semantic red/green. Don't introduce a second brand hue into Operate-mode screens. (The starfield's drifting invaders carry decorative hue tints, but they live on the arcade ground, not in admin chrome.)

## Typography

**Admin/body font:** Geist Sans (`--font-geist-sans`), with the system sans-serif stack as fallback. It remains the only family on the Operate-mode surfaces; hierarchy there comes from size and weight, not a font switch.

**Arcade type roles:** the landing introduces three display voices, one job each. They belong to the arcade register — don't port them into admin screens (the existing `.schem-*` classes in `styles/discord-controls.css` already use the mono voice for schematic kickers/stamps).

- **Display / pixel headings — Silkscreen** (`--font-arcade-display`): the cabinet's sign. The pixel-art voice of the register: the `guildthing` wordmark in the hero (`text-5xl`/`md:text-6xl`), every demo-reel band heading (`text-2xl`/`md:text-3xl`), and the footer wordmark. Weight 400 carries it — Silkscreen's blocks read bold on their own; no extra tracking.
- **Labels / names — Chakra Petch** (`--font-arcade-ui`): the machine's engraved labels. Semibold small text for bot/user names, mapping-row source chips ("Guild rank — Raider"), surface-node names, and the `Yours to run` definition terms.
- **Log lines / mono — Share Tech Mono** (`--font-arcade-mono`): the machine's readout. Bot log lines, channel pills (`#raider-chat`), the hero's "the demo reel starts below" cue, and the "one database" node's uppercase label.

### Hierarchy
- **Headline** (extrabold 800, `text-2xl`–`text-3xl`, tight tracking): page-level guild/section titles on admin screens.
- **Title** (bold 700, `text-lg`–`text-xl`): card and panel headers ("Create an event", "Audit log"); also the hero's hook line ("Your guild's Discord, on rails.", `text-xl` bold).
- **Body** (regular 400, `text-sm`–`text-base`): default UI copy, table cells, descriptions, reel-band captions.
- **Label** (bold 700, `text-xs`, `tracking-wider`, uppercase): sidebar section headings, table column headers — the admin system's one recurring "loud but small" treatment.
- **Pixel heading** (Silkscreen 400, wordmark `text-5xl`–`text-6xl`, band headings `text-2xl`–`text-3xl`): hero/footer wordmarks and landing band headings.
- **Arcade label** (Chakra Petch 600, `text-sm`–`text-base`): demo-reel names, chips, and definition terms.
- **Arcade mono** (Share Tech Mono 400, `text-xs`–`text-sm`): log lines, channel tokens, micro-cues.

## Layout

Two layout worlds:

**Admin shell:** a fixed two-column shell — a `w-56` (224px) sidebar (`bg-discord-sidebar`, `border-r border-black/20`) and a flex-1 content column on `bg-discord-base`. No responsive collapse observed for the sidebar — this is a desktop-first admin console, consistent with its officer/GM audience (see PRODUCT.md). Content area centers a max-width column (`items-center`, page padding `px-6 py-8`) rather than spanning full width edge-to-edge.

**Landing (`/`):** an attract-mode single column over the void. A fixed full-screen particle canvas (`z-index: -1`) holds the starfield and drifting invaders; the content is a centered `max-w-3xl` column (`px-6`): hero → four reel bands → slim footer. The hero is `min-h-[78vh]`, centered, with the mono cue "the demo reel starts below" at its base — so the first reel panel peeks under the fold and invites the scroll. Each band is `py-20`; the footer is a slim, muted three-part row (wordmark · MIT + repo link · `Log in` anchor to `#top`) that stacks on mobile.

Density on admin screens stays tight: gaps of 4–8px between related controls (`gap-1`–`gap-2`), 12–16px between cards (`gap-3`, `p-4`), scaling up to 24–32px for hero-style moments. The landing breathes more: `py-16`–`py-20` between bands, `p-6`–`p-8` inside reel panels (`md:p-10` for the database diagram).

## Elevation & Depth

Admin surfaces are flat, by default rather than by confirmed rule (open to revisiting): almost every surface is a solid color step (base → elevated → elevated-hover) with no shadow. Depth reads through that color-tier hierarchy, not through shadow.

The arcade register is the exception, and it's consistent: surfaces that float over the void are translucent and lifted. The landing's reel bands sit on `bg-discord-base/90` with `backdrop-blur-sm`, letting the starfield ghost through; the bot-log card and the `Yours to run` panel carry `shadow-2xl`, and the "one database" node carries `shadow-lg`. (The old floating login card is gone — the hero presents the sign-in form bare, as cabinet chrome, not as a card.)

### Shadow Vocabulary
- **Arcade-float** (`shadow-2xl` + `backdrop-blur-sm` over a translucent panel): a demo-reel panel separating from the starfield behind it. Currently the bot-log card and the `Yours to run` panel; not used on admin screens.
- **Arcade-node** (`shadow-lg`): smaller lifted elements within the register — the invader rail badge, the "one database" diagram node.

## Shapes

Two co-existing radius languages: interactive controls — buttons, text inputs, chips, search fields, and now **every CTA on the landing, including the primary "Log in with Discord" button** — are fully pill-shaped (`rounded-full`). Containers — cards, panels, modals, dropdown/table wrappers — use a softer corner (`rounded-xl` 12px, or `rounded-lg` 8px for smaller/nested surfaces like nav links and the mapping-row source chips). The former 4px login-CTA outlier no longer exists; the landing rebuild made the pill universal for controls. The only square corners left are micro-badges that aren't controls (the `rounded` blurple "BOT" tag, `text-[10px]`) and the diagram's hairline connectors.

Borders are used sparingly and only as low-opacity black dividers (`border-black/20`, `border-black/10`) between table rows, sidebar sections, and the `Yours to run` definition rows — never as a colored outline or decorative stroke; focus/hover state is communicated by background color shift (admin) or the focus-visible outline (landing, see Buttons).

## Components

### Buttons
- **Shape:** pill (`rounded-full`, 9999px) everywhere — admin buttons/inputs/chips and all landing CTAs alike.
- **Primary (admin):** `bg-discord-brand` / white text / `font-semibold` / `px-4 py-1.5–2` / `text-sm`, hover → `discord-brand-hover`, `disabled:opacity-50`.
- **Primary (landing hero):** `bg-discord-brand` / white text / `font-semibold` / `px-6 py-3` / Discord glyph / `text-base`, hover → `discord-brand-hover`; pending state swaps the label to "Connecting…", sets `aria-busy` and `disabled:opacity-50`; sign-in errors render below as `role="alert"` in `discord-red`.
- **Secondary (landing):** "View source" — `bg-discord-elevated` → hover `discord-elevated-hover`, same pill proportions, GitHub glyph. Deep-panel actions ("Star on GitHub", "Get the in-game addon") start at `bg-discord-elevated-hover` and **hover to blurple** (`hover:bg-discord-brand`) — the register's way of making the exit paths glow.
- **Danger:** same shape/padding as admin primary, `bg-discord-red` → hover `discord-red-hover`. Used inside confirmation dialogs for destructive actions.
- **Neutral/Ghost (admin):** `bg-discord-elevated-hover` (or transparent nav-link style, see Navigation) for Cancel/secondary actions.
- **Focus:** the landing defines the system's first explicit keyboard focus treatment — `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-discord-link` on every CTA and text link. Admin controls still rely on background shifts (a system-defined focus state there remains an open gap).

### Inputs / Fields
- **Style:** pill (`rounded-full`), filled not outlined — `bg-discord-elevated` (or `discord-elevated-hover` for a slightly raised variant), no visible border, `px-4 py-2`.
- **Focus:** no distinct focus treatment observed on admin screens (relies on the browser default outline); a system-defined focus state is an open gap, not a confirmed decision.
- **Placeholder:** `text-discord-text-muted`.

### Chips / Pills (role IDs, filters, search, demo tokens)
- **Style:** same pill language as buttons/inputs — `bg-discord-elevated`, `rounded-full`, small `px-3 py-1.5` — with an adjacent icon-only `✕` pill for removal.
- **Channel tokens (landing):** mono link-blue channel names (`#raider-chat`) in `rounded-full bg-discord-elevated px-3 py-1.5` pills.

### Cards / Containers
- **Corner Style:** `rounded-xl` (12px) for primary panels/cards, `rounded-lg` (8px) for nested/secondary surfaces.
- **Background:** `bg-discord-elevated` on the `bg-discord-base` admin page; `bg-discord-base/90` + `backdrop-blur-sm` for arcade-register panels over the void.
- **Shadow Strategy:** none on admin screens (see Elevation & Depth) — separation comes from the base→elevated color step, not shadow; arcade panels may carry the arcade-float treatment.
- **Internal Padding:** `p-4` (16px) for compact cards, `p-6` (24px) for modals/dialogs and larger panels, up to `p-8`/`p-10` inside landing reel panels.

### Tables
- **Style:** borderless container (`bg-discord-elevated` or `bg-discord-base`, `rounded-xl`/`rounded-lg`, `overflow-auto`, capped height like `max-h-[70vh]`), sticky uppercase muted headers, rows divided only by `border-b border-black/10–20`, no zebra striping observed.

### Modals / Dialogs
- **Style:** native `<dialog>`, `rounded-xl`, `bg-discord-elevated`, `backdrop:bg-black/60`, action row right-aligned with neutral Cancel + danger/primary confirm as pill buttons.

### Navigation (Sidebar)
- **Style:** `w-56` fixed column, `bg-discord-sidebar`. Links: `rounded-lg` row, `text-sm`, muted by default, active/hover → `discord-elevated`/`discord-elevated-hover` background + full-contrast text. Section groups introduced by a bold uppercase `Label`-style heading and separated by a hairline `border-black/20` divider — never left to margin alone.

### Signature Component: Attract-Mode Landing
The landing (`/`) is the arcade register's flagship: the product sells itself on a loop while you stand in front of the cabinet. Structure, top to bottom:

- **Hero (`min-h-[78vh]`):** centered invader mark in a rail-colored circular badge (`h-16 w-16 rounded-full bg-discord-rail`, blurple glyph); `GUILDTHING` marquee in Silkscreen; bold hook line; muted subline naming the mechanism (role↔rank sync, channels by rank/class, one database behind app/bot/addon); pill CTA pair — blurple "Log in with Discord" (with pending/error states) beside an elevated "View source" GitHub link; a Share Tech Mono cue — "the demo reel starts below" — sitting at the foot of the viewport.
- **Demo-reel bands** (each wrapped in a one-shot `Reveal`, `py-20`):
  1. **Bot log card** — a Discord-message-style panel (`bg-discord-base/90`, arcade-float): header row with rail-badge invader avatar, Chakra Petch "guildthing" name, square blurple "BOT" tag, and a `DEMO DATA` tag; Share Tech Mono log lines with green `✓` ticks and link-blue role/channel tokens, interleaved with muted explanation lines; muted caption paragraph below the panel.
  2. **Channel mapping rows** — three before→after rows: Chakra Petch source chip ("Guild rank — Raider", `rounded-lg bg-discord-elevated`) → muted arrow → link-blue mono channel pills; a `DEMO DATA` tag sits beside the band heading. Rows stack vertically on mobile.
  3. **Database diagram** — "One database. Three ways in.": SurfaceNodes (`rounded-xl bg-discord-elevated`, Chakra Petch name + muted caption) for Web app / Discord bot / In-game addon, connected by hairline `white/10` connectors to the rail-colored "one database" node (mono uppercase blurple, `shadow-lg`). Stacks to a single column on mobile.
  4. **`Yours to run`** — a definition-list panel (arcade-float): Chakra Petch semibold terms (Self-hosted / Private by default / Free & open source) with muted details, hairline `border-black/20` dividers, closed by the GitHub + addon-download pill pair.
- **Footer:** slim muted row — Silkscreen wordmark, "MIT licensed · github.com/kinguskhaan/GuildThing" link, and a `Log in` anchor back to the hero.

**Demo-data grammar:** every piece of invented content (guild names, log lines, rank/class rules) carries a `DEMO DATA` tag — `rounded-full bg-discord-rail px-2 py-0.5 text-[10px] font-bold tracking-wider text-discord-text-muted` — placed in the panel header or beside the band heading. The tag is part of the reel's grammar, not a one-off label: no demo surface ships without it.

## Motion

The arcade register moves; admin screens don't.

- **Starfield:** a fixed full-screen canvas (`ParticlesBackground`, `z-index: -1`) over `arcade-void`: ~200 small white square particles drifting at speed 0.2, no direction, wrapping at edges.
- **Drifting pixel invaders:** four space-invader SVG variants spawn periodically, tinted to random hues via CSS filters, drifting slowly with rotation and a soft glow (`drop-shadow`), at ~0.7 opacity. Ambient and continuous — the attract-mode loop.
- **Scroll reveal (`Reveal`):** one orchestrated reveal per reel band — `translate-y-6 → translate-y-0` + `opacity-0 → opacity-100`, `duration-700`, `ease-out`. It fires **once** (IntersectionObserver, `threshold: 0.05`, disconnects after the first intersection) and never re-triggers on scroll-back. Under `prefers-reduced-motion: reduce` the component short-circuits: bands render visible immediately, no transform, no observer.
- **Hover/press:** background-color shifts only (brand→brand-hover, elevated→elevated-hover, elevated-hover→brand), `hover:underline` on text links — no transforms, no glows on interactive chrome.

## Do's and Don'ts

### Do:
- **Do** reuse Discord's exact palette and surface-tier hierarchy for every admin/Operate-mode screen — officers should never feel like they've left Discord's visual world.
- **Do** treat the attract-mode landing as the arcade register's flagship instance and extend the register (starfield, void ground, arcade type roles, one-shot reveals) to other low-frequency, high-emotion moments — empty states, first-run/onboarding, milestone screens — as those get designed.
- **Do** use flat color-tier separation (base → elevated → elevated-hover) as the default depth model on dense admin screens; reach for the arcade-float treatment (translucent panel + blur + `shadow-2xl`) only when a surface floats over the void, the way the landing's reel panels do.
- **Do** keep arcade motion honest: reveals fire once per band and respect `prefers-reduced-motion`; only the ambient layer (starfield, invaders) loops.
- **Do** label every piece of invented/demo content with the `DEMO DATA` rail tag — the reel's grammar depends on never passing demo data off as real.
- **Do** keep destructive actions behind the `ConfirmButton` dialog pattern (description + Cancel/neutral + danger-pill confirm) rather than firing destructive mutations directly from a row action.

### Don't:
- **Don't** bring the arcade register (starfield, void background, arcade fonts, blur/glow) into dense, high-frequency admin screens like the roster table, role-rule forms, or settings — it would fight the scanability those screens need.
- **Don't** introduce a second saturated brand hue into Operate-mode UI; blurple stays the one accent.
- **Don't** add colored borders or decorative outline-style strokes to admin controls — there, state is communicated by background-color shifts, not borders. The landing's link-blue `focus-visible` outline is the one sanctioned outline: a keyboard-accessibility treatment on the arcade surface, not a style to import into admin chrome.
- **Don't** resurrect a square-cornered CTA — the pill is the system's only button/CTA shape now (the 4px login-CTA outlier was eliminated in the landing build); square corners are reserved for micro-badges like the "BOT" tag that aren't clickable.
- **Don't** present demo content without its `DEMO DATA` tag, and don't re-trigger band reveals on every scroll pass — the reel plays once, like a proper attract mode.