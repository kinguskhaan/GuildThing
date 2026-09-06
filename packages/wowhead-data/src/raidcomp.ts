// Raid comp catalog: per-expansion classes, specs, and raid buff/debuff
// coverage data for the officer-only raid comp tool (guilds/[guildSlug]/
// admin/raid-comp). Source of truth for names/spec rosters/buff-debuff
// lists is wowtbc.gg's own raid comp planner (one page per expansion,
// e.g. https://wowtbc.gg/wotlk/raid-comp/) — the same tool this feature
// was modeled on. Icon slugs are bare filenames (no extension); the actual
// image bytes are downloaded once by scripts/fetch-icons.ts into
// apps/web/public/icons/wow/{slug}.jpg from their real sources (Wowhead's
// class-icon CDN for classes, wowtbc.gg's own icon CDN for specs/buffs —
// see fetch-icons.ts for the exact source URLs) so the shipped app never
// hotlinks a third party at runtime.

export type ExpansionId = "classic" | "tbc" | "wotlk" | "cata" | "mop";

export const EXPANSION_ORDER: ExpansionId[] = [
  "classic",
  "tbc",
  "wotlk",
  "cata",
  "mop",
];

export interface WowClass {
  /** Locale-independent token — matches the addon export / GuildRosterMember.class values. */
  token: string;
  label: string;
  color: string;
  icon: string;
}
export interface WowSpec {
  /** Stable token; suffixed with the class where the spec name alone is ambiguous. */
  token: string;
  label: string;
  classToken: string;
  icon: string;
  /** Combat role — drives the raid comp tool's role view. */
  role: "tank" | "healer" | "melee" | "ranged";
}

/** "raid" = affects every raid member regardless of group; "group" = only the caster's own 5-man party. */
export type BuffScope = "raid" | "group";

export interface BuffDef {
  id: string;
  label: string;
  icon: string;
  scope: BuffScope;
  kind: "buff" | "debuff";
  /** Source class when any spec of that class provides it. */
  classToken?: string;
  /** Source spec when only one specific spec provides it (overrides classToken for matching). */
  specToken?: string;
  /** Multiple specs provide the same effect (e.g. TBC Battle Shout from Arms OR Fury). */
  specTokens?: string[];
  /** Wowhead spell ID — same numeric ID across every Classic-progression
   * domain, used to build a real Wowhead tooltip link. Undefined when not
   * yet catalogued. */
  spellId?: number;
}

// Wowhead spell IDs, keyed by BuffDef id — verified directly against each
// id's actual Wowhead page. Mostly one evergreen ID reused across every
// expansion array a buff appears in (see `withSpellIds` below), EXCEPT
// where Cataclysm's 4.0.1 ability-pruning patch renumbered a baseline
// ability (confirmed for Thunder Clap: the pre-Cata rank ID 404s on the
// /cata/ domain) — those buffs get looked up separately for
// CATA_MOP_BUFFS_BASE via `CATA_MOP_SPELL_ID_OVERRIDES` below rather than
// trusting the shared map.
const SPELL_IDS: Record<string, number> = {
  "anti-magic-zone": 51052,
  "arcane-brilliance": 27127,
  "arcane-intellect": 27126,
  "battle-shout": 6673,
  "blessing-of-kings": 25898,
  "blessing-of-might": 27141,
  "blessing-of-salvation": 25895,
  "blessing-of-sanctuary": 27169,
  "blessing-of-wisdom": 27143,
  "blood-frenzy": 29859,
  "blood-pact": 27268,
  bloodlust: 2825,
  "commanding-shout": 469,
  "curse-of-the-elements": 27228,
  "demonic-pact": 47236,
  "demoralizing-shout": 47437,
  "devotion-aura": 27149,
  "divine-spirit": 25312,
  "earth-shield": 32594,
  "ebon-plaguebringer": 51161,
  "elemental-oath": 51470,
  "expose-armor": 8647,
  "expose-weakness": 34503,
  "faerie-fire": 27011,
  "ferocious-inspiration": 34460,
  hemorrhage: 26864,
  "horn-of-winter": 57623,
  "improved-demoralizing-shout": 12879,
  "improved-expose-armor": 14169,
  "improved-faerie-fire": 33602,
  "improved-healthstone": 18693,
  "improved-icy-talons": 55610,
  "improved-imp": 18696,
  "improved-mark-of-the-wild": 17055,
  "improved-scorch": 12873,
  "improved-seal-of-the-crusader": 20337,
  "improved-shadow-bolt": 17803,
  "improved-thunder-clap": 12666,
  innervate: 29166,
  "insect-swarm": 27013,
  "leader-of-the-pack": 17007,
  malediction: 32484,
  "mana-tide-totem": 16190,
  mangle: 33987,
  "mark-of-the-wild": 26990,
  "master-poisoner": 31227,
  "moonkin-form": 24907,
  "pain-suppression": 33206,
  "power-infusion": 10060,
  "power-word-barrier": 55689,
  "power-word-fortitude": 25389,
  "rallying-cry": 97462,
  "sanctity-aura": 20218,
  "scorpid-sting": 3043,
  "shadow-protection": 25433,
  "shadow-weaving": 15334,
  "spirit-link-totem": 98008,
  "stoneskin-totem": 78222,
  "strength-of-earth-totem": 25528,
  "sunder-armor": 7386,
  "thunder-clap": 47502,
  "totem-of-wrath": 30706,
  "tree-of-life": 33891,
  "trueshot-aura": 19506,
  "unleashed-rage": 30811,
  "vampiric-embrace": 15286,
  "windfury-totem": 8512,
  "winters-chill": 28595,
};

// Cataclysm's 4.0.1 pre-expansion patch renumbered several baseline
// abilities when it pruned ranks and made class buffs raid-wide — a buff's
// SPELL_IDS entry (usually still correct for classic/tbc/wotlk) can be
// stale specifically for CATA_MOP_BUFFS_BASE. Every id here was confirmed
// broken on /cata/ (the SPELL_IDS value 404s or falls through to Wowhead's
// generic search page there) and replaced with the id that actually
// resolves on that domain. Ids not listed here checked out fine as-is.
const CATA_MOP_SPELL_ID_OVERRIDES: Record<string, number> = {
  "arcane-brilliance": 1459,
  "blessing-of-kings": 20217,
  "blessing-of-might": 19740,
  "blood-pact": 6307,
  "curse-of-the-elements": 1490,
  "demoralizing-shout": 1160,
  "devotion-aura": 465,
  "ebon-plaguebringer": 51160,
  "faerie-fire": 770,
  hemorrhage: 16511,
  "horn-of-winter": 57330,
  mangle: 33878,
  "mark-of-the-wild": 1126,
  "master-poisoner": 58410,
  "power-word-fortitude": 21562,
  "strength-of-earth-totem": 8075,
  "thunder-clap": 6343,
  "unleashed-rage": 30802,
};

function withCataSpellIds(buffs: BuffDef[]): BuffDef[] {
  return buffs.map((b) => ({
    ...b,
    spellId: CATA_MOP_SPELL_ID_OVERRIDES[b.id] ?? SPELL_IDS[b.id],
  }));
}

// Blessing of Sanctuary got a new spell id in Wrath despite the ability
// itself carrying over unchanged from TBC — confirmed via Wowhead's
// "Modified by" list (Protection's Stoicism talent) on the Wrath spell
// page. The shared SPELL_IDS value (27169) is TBC's id specifically.
const WOTLK_SPELL_ID_OVERRIDES: Record<string, number> = {
  "blessing-of-sanctuary": 20911,
};

function withWotlkSpellIds(buffs: BuffDef[]): BuffDef[] {
  return buffs.map((b) => ({
    ...b,
    spellId: WOTLK_SPELL_ID_OVERRIDES[b.id] ?? SPELL_IDS[b.id],
  }));
}

function withSpellIds(buffs: BuffDef[]): BuffDef[] {
  return buffs.map((b) => ({ ...b, spellId: SPELL_IDS[b.id] }));
}

// Wowhead's tooltip widget (wow.zamimg.com/js/tooltips.js) auto-detects the
// game version from the domain segment of a spell link's URL.
const WOWHEAD_DOMAIN: Record<ExpansionId, string> = {
  classic: "classic",
  tbc: "tbc",
  wotlk: "wotlk",
  cata: "cata",
  mop: "mop-classic",
};

export function wowheadDomain(expansion: ExpansionId): string {
  return WOWHEAD_DOMAIN[expansion];
}

export function wowheadSpellUrl(expansion: ExpansionId, spellId: number): string {
  return `https://www.wowhead.com/${wowheadDomain(expansion)}/spell=${spellId}`;
}

export interface ExpansionDef {
  id: ExpansionId;
  label: string;
  shortLabel: string;
  raidSize: number;
  groupSize: 5;
  hasSpecs: boolean;
  /** Level cap — raid comp planning only cares about characters at this level. */
  maxLevel: number;
  classes: WowClass[];
  specs: WowSpec[];
  buffs: BuffDef[];
}

// ---------------------------------------------------------------------------
// Classes — the 9 original tokens plus Death Knight (Wrath+) and Monk (MoP+).
// Colors are the client's own RAID_CLASS_COLORS; icons are Wowhead's
// standard "classicon_*" class-icon filenames.

const CLASS = {
  WARRIOR: { token: "WARRIOR", label: "Warrior", color: "#C79C6E", icon: "classicon_warrior" },
  PALADIN: { token: "PALADIN", label: "Paladin", color: "#F58CBA", icon: "classicon_paladin" },
  HUNTER: { token: "HUNTER", label: "Hunter", color: "#ABD473", icon: "classicon_hunter" },
  ROGUE: { token: "ROGUE", label: "Rogue", color: "#FFF569", icon: "classicon_rogue" },
  PRIEST: { token: "PRIEST", label: "Priest", color: "#FFFFFF", icon: "classicon_priest" },
  DEATHKNIGHT: { token: "DEATHKNIGHT", label: "Death Knight", color: "#C41E3A", icon: "classicon_deathknight" },
  SHAMAN: { token: "SHAMAN", label: "Shaman", color: "#0070DE", icon: "classicon_shaman" },
  MAGE: { token: "MAGE", label: "Mage", color: "#69CCF0", icon: "classicon_mage" },
  WARLOCK: { token: "WARLOCK", label: "Warlock", color: "#9482C9", icon: "classicon_warlock" },
  MONK: { token: "MONK", label: "Monk", color: "#00FF96", icon: "classicon_monk" },
  DRUID: { token: "DRUID", label: "Druid", color: "#FF7D0A", icon: "classicon_druid" },
} satisfies Record<string, WowClass>;

const CLASSES_9 = [
  CLASS.WARRIOR,
  CLASS.PALADIN,
  CLASS.HUNTER,
  CLASS.ROGUE,
  CLASS.PRIEST,
  CLASS.SHAMAN,
  CLASS.MAGE,
  CLASS.WARLOCK,
  CLASS.DRUID,
];
const CLASSES_10 = [...CLASSES_9, CLASS.DEATHKNIGHT];
const CLASSES_11 = [...CLASSES_10, CLASS.MONK];

// ---------------------------------------------------------------------------
// Specs — icon filenames verified against wowtbc.gg's own raid-comp pages
// (classic/tbc/wotlk share one icon set; cata/mop share a second, updated
// set — see fetch-icons.ts's two source folders). Tokens are suffixed with
// the class only where the plain label collides across classes (Holy,
// Protection, Restoration, Feral in MoP vs Feral Combat pre-MoP).

function specsForNineClasses(druidFeralIcon: string, druidFeralRole: "tank" | "melee"): WowSpec[] {
  return [
    { token: "ARMS", label: "Arms", classToken: "WARRIOR", icon: "arms_warrior", role: "melee" },
    { token: "FURY", label: "Fury", classToken: "WARRIOR", icon: "fury_warrior", role: "melee" },
    { token: "PROTECTION_WARRIOR", label: "Protection", classToken: "WARRIOR", icon: "protection_warrior", role: "tank" },
    { token: "HOLY_PALADIN", label: "Holy", classToken: "PALADIN", icon: "holy_paladin", role: "healer" },
    { token: "PROTECTION_PALADIN", label: "Protection", classToken: "PALADIN", icon: "protection_paladin", role: "tank" },
    { token: "RETRIBUTION", label: "Retribution", classToken: "PALADIN", icon: "retribution_paladin", role: "melee" },
    { token: "BEAST_MASTERY", label: "Beast Mastery", classToken: "HUNTER", icon: "beast_mastery_hunter", role: "ranged" },
    { token: "MARKSMANSHIP", label: "Marksmanship", classToken: "HUNTER", icon: "marksmanship_hunter", role: "ranged" },
    { token: "SURVIVAL", label: "Survival", classToken: "HUNTER", icon: "survival_hunter", role: "ranged" },
    { token: "ASSASSINATION", label: "Assassination", classToken: "ROGUE", icon: "assassination_rogue", role: "melee" },
    { token: "COMBAT", label: "Combat", classToken: "ROGUE", icon: "combat_rogue", role: "melee" },
    { token: "SUBTLETY", label: "Subtlety", classToken: "ROGUE", icon: "subtlety_rogue", role: "melee" },
    { token: "DISCIPLINE", label: "Discipline", classToken: "PRIEST", icon: "discipline_priest", role: "healer" },
    { token: "HOLY_PRIEST", label: "Holy", classToken: "PRIEST", icon: "holy_priest", role: "healer" },
    { token: "SHADOW", label: "Shadow", classToken: "PRIEST", icon: "shadow_priest", role: "ranged" },
    { token: "ELEMENTAL", label: "Elemental", classToken: "SHAMAN", icon: "elemental_shaman", role: "ranged" },
    { token: "ENHANCEMENT", label: "Enhancement", classToken: "SHAMAN", icon: "enhancement_shaman", role: "melee" },
    { token: "RESTORATION_SHAMAN", label: "Restoration", classToken: "SHAMAN", icon: "restoration_shaman", role: "healer" },
    { token: "ARCANE", label: "Arcane", classToken: "MAGE", icon: "arcane_mage", role: "ranged" },
    { token: "FIRE", label: "Fire", classToken: "MAGE", icon: "fire_mage", role: "ranged" },
    { token: "FROST_MAGE", label: "Frost", classToken: "MAGE", icon: "frost_mage", role: "ranged" },
    { token: "AFFLICTION", label: "Affliction", classToken: "WARLOCK", icon: "affliction_warlock", role: "ranged" },
    { token: "DEMONOLOGY", label: "Demonology", classToken: "WARLOCK", icon: "demonology_warlock", role: "ranged" },
    { token: "DESTRUCTION", label: "Destruction", classToken: "WARLOCK", icon: "destruction_warlock", role: "ranged" },
    { token: "BALANCE", label: "Balance", classToken: "DRUID", icon: "balance_druid", role: "ranged" },
    // Classic/TBC Feral is the druid's bear tank first (cat DPS second);
    // WotLK/Cata Feral is cat DPS first with bear tanking as the off-role.
    { token: "FERAL_DRUID", label: "Feral", classToken: "DRUID", icon: druidFeralIcon, role: druidFeralRole },
    { token: "RESTORATION_DRUID", label: "Restoration", classToken: "DRUID", icon: "restoration_druid", role: "healer" },
  ];
}
const DEATH_KNIGHT_SPECS: WowSpec[] = [
  { token: "BLOOD", label: "Blood", classToken: "DEATHKNIGHT", icon: "blood_death_knight", role: "tank" },
  { token: "FROST_DK", label: "Frost", classToken: "DEATHKNIGHT", icon: "frost_death_knight", role: "melee" },
  { token: "UNHOLY", label: "Unholy", classToken: "DEATHKNIGHT", icon: "unholy_death_knight", role: "melee" },
];

const MONK_SPECS: WowSpec[] = [
  { token: "BREWMASTER", label: "Brewmaster", classToken: "MONK", icon: "brewmaster_monk", role: "tank" },
  { token: "MISTWEAVER", label: "Mistweaver", classToken: "MONK", icon: "mistweaver_monk", role: "healer" },
  { token: "WINDWALKER", label: "Windwalker", classToken: "MONK", icon: "windwalker_monk", role: "melee" },
];

const GUARDIAN_DRUID_SPEC: WowSpec = {
  token: "GUARDIAN",
  label: "Guardian",
  classToken: "DRUID",
  icon: "guardian_druid",
  role: "tank",
};

const SPECS_CLASSIC = specsForNineClasses("feral_druid", "tank");
const SPECS_TBC = specsForNineClasses("feral_druid", "tank");
const SPECS_WOTLK = [...specsForNineClasses("feral_druid", "melee"), ...DEATH_KNIGHT_SPECS];
const SPECS_CATA = [...specsForNineClasses("feral_druid", "melee"), ...DEATH_KNIGHT_SPECS];
// MoP split Druid's single Feral tree into Feral (cat, dps) and Guardian
// (bear, tank) and gave Feral a new icon — see fetch-icons.ts's MoP source
const SPECS_MOP: WowSpec[] = [
  ...specsForNineClasses("feral_druid-2", "melee").filter((s) => s.token !== "FERAL_DRUID"),
  { token: "FERAL_DRUID", label: "Feral", classToken: "DRUID", icon: "feral_druid-2", role: "melee" },
  GUARDIAN_DRUID_SPEC,
  ...DEATH_KNIGHT_SPECS,
  ...MONK_SPECS,
];

// ---------------------------------------------------------------------------
// Buffs & debuffs. Scope reflects real game mechanics, not wowtbc.gg's UI
// grouping (which sorts by offense/defense in Cata+, not by radius):
// classic/tbc/wotlk class utility (shouts, blessings, auras, totems, marks)
// only ever reached the caster's own 5-man party — "group" scope — while
// Bloodlust's radius genuinely covers everyone stacked nearby, modeled as
// "raid". Cataclysm's pre-patch buff consolidation (4.0.1) made almost
// every class buff and totem raid-wide outright, and Mists kept that model
// — both modeled as "raid" throughout (Mists shares Cataclysm's list; the
// mechanic didn't change further).
//
// Source attribution follows what each spec is expected to bring, per
// wowtbc.gg's lists and the talent trees: spec-locked effects carry
// specToken (TBC Prot warrior is expected to shout Commanding Shout, Arms/
// Fury Battle Shout), class-wide effects carry classToken.

const CLASSIC_BUFFS: BuffDef[] = [
  { id: "arcane-intellect", label: "Arcane Intellect", icon: "arcane-intellect", scope: "group", kind: "buff", classToken: "MAGE" },
  // Battle Shout is a trainer-taught base ability (any spec, no talent) —
  // verified on Wowhead: "Requires Warrior", "Requires level 1", no talent
  // prerequisite. Not spec-locked to Arms/Fury.
  { id: "battle-shout", label: "Battle Shout", icon: "battle-shout", scope: "group", kind: "buff", classToken: "WARRIOR" },
  { id: "blessing-of-kings", label: "Blessing of Kings", icon: "blessing-of-kings", scope: "group", kind: "buff", specToken: "PROTECTION_PALADIN" },
  { id: "blessing-of-sanctuary", label: "Blessing of Sanctuary", icon: "blessing-of-sanctuary", scope: "group", kind: "buff", specToken: "PROTECTION_PALADIN" },
  { id: "devotion-aura", label: "Devotion Aura", icon: "devotion-aura", scope: "group", kind: "buff", classToken: "PALADIN" },
  { id: "divine-spirit", label: "Divine Spirit", icon: "divine-spirit", scope: "group", kind: "buff", classToken: "PRIEST" },
  // Improved Healthstone / Improved MotW have no own icon file on the
  // source CDN (verified) — they reuse the base spell's icon, which is
  // also how the in-game client renders improved ranks.
  { id: "improved-healthstone", label: "Improved Healthstone", icon: "healthstone", scope: "group", kind: "buff", classToken: "WARLOCK" },
  { id: "improved-mark-of-the-wild", label: "Improved Mark of the Wild", icon: "mark-of-the-wild", scope: "group", kind: "buff", specToken: "RESTORATION_DRUID" },
  { id: "innervate", label: "Innervate", icon: "innervate", scope: "group", kind: "buff", classToken: "DRUID" },
  { id: "leader-of-the-pack", label: "Leader of the Pack", icon: "leader-of-the-pack", scope: "group", kind: "buff", specToken: "FERAL_DRUID" },
  { id: "mana-tide-totem", label: "Mana Tide Totem", icon: "mana-tide-totem", scope: "group", kind: "buff", specToken: "RESTORATION_SHAMAN" },
  { id: "mark-of-the-wild", label: "Mark of the Wild", icon: "mark-of-the-wild", scope: "group", kind: "buff", classToken: "DRUID" },
  { id: "moonkin-form", label: "Moonkin Form", icon: "moonkin-form", scope: "group", kind: "buff", specToken: "BALANCE" },
  { id: "power-infusion", label: "Power Infusion", icon: "power-infusion", scope: "group", kind: "buff", specToken: "DISCIPLINE" },
  { id: "power-word-fortitude", label: "Power Word: Fortitude", icon: "power-word-fortitude", scope: "group", kind: "buff", classToken: "PRIEST" },
  { id: "sanctity-aura", label: "Sanctity Aura", icon: "sanctity-aura", scope: "group", kind: "buff", specToken: "RETRIBUTION" },
  { id: "shadow-protection", label: "Shadow Protection", icon: "shadow-protection", scope: "group", kind: "buff", classToken: "PRIEST" },
  { id: "trueshot-aura", label: "Trueshot Aura", icon: "trueshot-aura", scope: "group", kind: "buff", specToken: "MARKSMANSHIP" },
  { id: "blood-pact", label: "Blood Pact", icon: "blood-pact", scope: "group", kind: "buff", classToken: "WARLOCK" },

  { id: "faerie-fire", label: "Faerie Fire", icon: "faerie-fire", scope: "group", kind: "debuff", classToken: "DRUID" },
  { id: "hemorrhage", label: "Hemorrhage", icon: "hemorrhage", scope: "group", kind: "debuff", specToken: "SUBTLETY" },
  { id: "improved-demoralizing-shout", label: "Improved Demoralizing Shout", icon: "improved-demoralizing-shout", scope: "group", kind: "debuff", specToken: "PROTECTION_WARRIOR" },
  { id: "improved-expose-armor", label: "Improved Expose Armor", icon: "improved-expose-armor", scope: "group", kind: "debuff", specToken: "COMBAT" },
  { id: "improved-scorch", label: "Improved Scorch", icon: "improved-scorch", scope: "group", kind: "debuff", specToken: "FIRE" },
  { id: "improved-shadow-bolt", label: "Improved Shadow Bolt", icon: "improved-shadow-bolt", scope: "group", kind: "debuff", specToken: "DESTRUCTION" },
  { id: "insect-swarm", label: "Insect Swarm", icon: "insect-swarm", scope: "group", kind: "debuff", specToken: "BALANCE" },
  { id: "scorpid-sting", label: "Scorpid Sting", icon: "scorpid-sting", scope: "group", kind: "debuff", classToken: "HUNTER" },
  { id: "shadow-weaving", label: "Shadow Weaving", icon: "shadow-weaving", scope: "group", kind: "debuff", specToken: "SHADOW" },
  { id: "vampiric-embrace", label: "Vampiric Embrace", icon: "vampiric-embrace", scope: "group", kind: "debuff", specToken: "SHADOW" },
  { id: "winters-chill", label: "Winter's Chill", icon: "frostbite", scope: "group", kind: "debuff", specToken: "FROST_MAGE" },
];

const TBC_BUFFS: BuffDef[] = [
  { id: "arcane-intellect", label: "Arcane Intellect", icon: "arcane-intellect", scope: "group", kind: "buff", classToken: "MAGE" },
  // Battle Shout and Commanding Shout are both trainer-taught base warrior
  // abilities (verified on Wowhead: "Requires Warrior", no talent
  // prerequisite) — any spec can cast either, they're just mutually
  // exclusive in-game (one shout active at a time), not spec-locked.
  { id: "battle-shout", label: "Battle Shout", icon: "battle-shout", scope: "group", kind: "buff", classToken: "WARRIOR" },
  { id: "blessing-of-kings", label: "Blessing of Kings", icon: "blessing-of-kings", scope: "group", kind: "buff", classToken: "PALADIN" },
  { id: "blessing-of-might", label: "Blessing of Might", icon: "blessing-of-might", scope: "group", kind: "buff", classToken: "PALADIN" },
  // wowtbc.gg's own icon set has no "Blessing of Light" asset (unlike every
  // other Blessing) — it's the one Blessing raid-comp tools conventionally
  // skip tracking, being rarely the optimal choice over the others.
  { id: "blessing-of-salvation", label: "Blessing of Salvation", icon: "salvation", scope: "group", kind: "buff", classToken: "PALADIN" },
  // Requires the Protection tree's "Sanctuary" talent — unlike the other
  // Blessings, not castable by just any Paladin.
  { id: "blessing-of-sanctuary", label: "Blessing of Sanctuary", icon: "blessing-of-sanctuary", scope: "group", kind: "buff", specToken: "PROTECTION_PALADIN" },
  { id: "blessing-of-wisdom", label: "Blessing of Wisdom", icon: "blessing-of-wisdom", scope: "group", kind: "buff", classToken: "PALADIN" },
  { id: "bloodlust", label: "Bloodlust", icon: "bloodlust", scope: "raid", kind: "buff", classToken: "SHAMAN" },
  { id: "commanding-shout", label: "Commanding Shout", icon: "commanding-shout", scope: "group", kind: "buff", classToken: "WARRIOR" },
  { id: "devotion-aura", label: "Devotion Aura", icon: "devotion-aura", scope: "group", kind: "buff", classToken: "PALADIN" },
  { id: "divine-spirit", label: "Divine Spirit", icon: "divine-spirit", scope: "group", kind: "buff", classToken: "PRIEST" },
  { id: "earth-shield", label: "Earth Shield", icon: "earth-shield", scope: "group", kind: "buff", specToken: "RESTORATION_SHAMAN" },
  { id: "ferocious-inspiration", label: "Ferocious Inspiration", icon: "ferocious-inspiration", scope: "group", kind: "buff", specToken: "BEAST_MASTERY" },
  { id: "improved-healthstone", label: "Improved Healthstone", icon: "healthstone", scope: "group", kind: "buff", classToken: "WARLOCK" },
  { id: "improved-imp", label: "Improved Imp", icon: "improved-imp", scope: "group", kind: "buff", specToken: "DEMONOLOGY" },
  { id: "improved-mark-of-the-wild", label: "Improved Mark of the Wild", icon: "mark-of-the-wild", scope: "group", kind: "buff", specToken: "RESTORATION_DRUID" },
  { id: "innervate", label: "Innervate", icon: "innervate", scope: "group", kind: "buff", classToken: "DRUID" },
  { id: "leader-of-the-pack", label: "Leader of the Pack", icon: "leader-of-the-pack", scope: "group", kind: "buff", specToken: "FERAL_DRUID" },
  { id: "mana-tide-totem", label: "Mana Tide Totem", icon: "mana-tide-totem", scope: "group", kind: "buff", specToken: "RESTORATION_SHAMAN" },
  { id: "mark-of-the-wild", label: "Mark of the Wild", icon: "mark-of-the-wild", scope: "group", kind: "buff", classToken: "DRUID" },
  { id: "moonkin-form", label: "Moonkin Form", icon: "moonkin-form", scope: "group", kind: "buff", specToken: "BALANCE" },
  { id: "pain-suppression", label: "Pain Suppression", icon: "pain-suppression", scope: "group", kind: "buff", specToken: "DISCIPLINE" },
  { id: "power-word-fortitude", label: "Power Word: Fortitude", icon: "power-word-fortitude", scope: "group", kind: "buff", classToken: "PRIEST" },
  { id: "sanctity-aura", label: "Sanctity Aura", icon: "sanctity-aura", scope: "group", kind: "buff", specToken: "RETRIBUTION" },
  { id: "shadow-protection", label: "Shadow Protection", icon: "shadow-protection", scope: "group", kind: "buff", classToken: "PRIEST" },
  { id: "totem-of-wrath", label: "Totem of Wrath", icon: "totem-of-wrath", scope: "group", kind: "buff", specToken: "ELEMENTAL" },
  { id: "tree-of-life", label: "Tree of Life", icon: "tree-of-life", scope: "group", kind: "buff", specToken: "RESTORATION_DRUID" },
  { id: "trueshot-aura", label: "Trueshot Aura", icon: "trueshot-aura", scope: "group", kind: "buff", specToken: "SURVIVAL" },
  { id: "unleashed-rage", label: "Unleashed Rage", icon: "unleashed-rage", scope: "group", kind: "buff", specToken: "ENHANCEMENT" },

  { id: "blood-frenzy", label: "Blood Frenzy", icon: "blood-frenzy", scope: "group", kind: "debuff", specToken: "ARMS" },
  { id: "expose-weakness", label: "Expose Weakness", icon: "expose-weakness", scope: "group", kind: "debuff", specToken: "SURVIVAL" },
  // Both base abilities (no talent requirement) — omitted from the original
  // TBC list even though present in every later expansion's; every raid
  // brings a warrior tank regardless, but track them for completeness.
  { id: "sunder-armor", label: "Sunder Armor", icon: "sunder-armor", scope: "group", kind: "debuff", classToken: "WARRIOR" },
  { id: "expose-armor", label: "Expose Armor", icon: "expose-armor", scope: "group", kind: "debuff", classToken: "ROGUE" },
  { id: "faerie-fire", label: "Faerie Fire", icon: "faerie-fire", scope: "group", kind: "debuff", classToken: "DRUID" },
  { id: "hemorrhage", label: "Hemorrhage", icon: "hemorrhage", scope: "group", kind: "debuff", specToken: "SUBTLETY" },
  { id: "improved-demoralizing-shout", label: "Improved Demoralizing Shout", icon: "improved-demoralizing-shout", scope: "group", kind: "debuff", specToken: "PROTECTION_WARRIOR" },
  { id: "improved-expose-armor", label: "Improved Expose Armor", icon: "improved-expose-armor", scope: "group", kind: "debuff", specToken: "COMBAT" },
  { id: "improved-faerie-fire", label: "Improved Faerie Fire", icon: "improved-faerie-fire", scope: "group", kind: "debuff", specToken: "BALANCE" },
  { id: "improved-scorch", label: "Improved Scorch", icon: "improved-scorch", scope: "group", kind: "debuff", specToken: "FIRE" },
  { id: "improved-seal-of-the-crusader", label: "Improved Seal of the Crusader", icon: "improved-seal-of-the-crusader", scope: "group", kind: "debuff", specToken: "RETRIBUTION" },
  { id: "improved-shadow-bolt", label: "Improved Shadow Bolt", icon: "improved-shadow-bolt", scope: "group", kind: "debuff", specToken: "DESTRUCTION" },
  { id: "improved-thunder-clap", label: "Improved Thunder Clap", icon: "improved-thunder-clap", scope: "group", kind: "debuff", specToken: "PROTECTION_WARRIOR" },
  { id: "insect-swarm", label: "Insect Swarm", icon: "insect-swarm", scope: "group", kind: "debuff", specToken: "BALANCE" },
  { id: "malediction", label: "Malediction", icon: "malediction", scope: "group", kind: "debuff", specToken: "AFFLICTION" },
  { id: "mangle", label: "Mangle", icon: "mangle", scope: "group", kind: "debuff", specToken: "FERAL_DRUID" },
  { id: "scorpid-sting", label: "Scorpid Sting", icon: "scorpid-sting", scope: "group", kind: "debuff", classToken: "HUNTER" },
  { id: "shadow-weaving", label: "Shadow Weaving", icon: "shadow-weaving", scope: "group", kind: "debuff", specToken: "SHADOW" },
  { id: "winters-chill", label: "Winter's Chill", icon: "frostbite", scope: "group", kind: "debuff", specToken: "FROST_MAGE" },
];

const WOTLK_BUFFS: BuffDef[] = [
  { id: "arcane-intellect", label: "Arcane Intellect", icon: "arcane-intellect", scope: "group", kind: "buff", classToken: "MAGE" },
  { id: "battle-shout", label: "Battle Shout", icon: "battle-shout", scope: "group", kind: "buff", classToken: "WARRIOR" },
  { id: "blessing-of-kings", label: "Blessing of Kings", icon: "blessing-of-kings", scope: "group", kind: "buff", classToken: "PALADIN" },
  // Still requires the Protection "Sanctuary" talent in Wrath, same as TBC —
  // confirmed via Wowhead's "Modified by" list (Stoicism, a Protection
  // talent). Uses its own spellId (see WOTLK_SPELL_ID_OVERRIDES) since
  // Wrath's version has a different id than TBC's.
  { id: "blessing-of-sanctuary", label: "Blessing of Sanctuary", icon: "blessing-of-sanctuary", scope: "group", kind: "buff", specToken: "PROTECTION_PALADIN" },
  { id: "devotion-aura", label: "Devotion Aura", icon: "devotion-aura", scope: "group", kind: "buff", classToken: "PALADIN" },
  { id: "divine-spirit", label: "Divine Spirit", icon: "divine-spirit", scope: "group", kind: "buff", classToken: "PRIEST" },
  { id: "power-word-fortitude", label: "Power Word: Fortitude", icon: "power-word-fortitude", scope: "group", kind: "buff", classToken: "PRIEST" },
  { id: "shadow-protection", label: "Shadow Protection", icon: "shadow-protection", scope: "group", kind: "buff", classToken: "PRIEST" },
  { id: "mark-of-the-wild", label: "Mark of the Wild", icon: "mark-of-the-wild", scope: "group", kind: "buff", classToken: "DRUID" },
  { id: "moonkin-form", label: "Moonkin Form", icon: "moonkin-form", scope: "group", kind: "buff", specToken: "BALANCE" },
  { id: "leader-of-the-pack", label: "Leader of the Pack", icon: "leader-of-the-pack", scope: "group", kind: "buff", specToken: "FERAL_DRUID" },
  { id: "tree-of-life", label: "Tree of Life", icon: "tree-of-life", scope: "group", kind: "buff", specToken: "RESTORATION_DRUID" },
  { id: "innervate", label: "Innervate", icon: "innervate", scope: "group", kind: "buff", classToken: "DRUID" },
  { id: "mana-tide-totem", label: "Mana Tide Totem", icon: "mana-tide-totem", scope: "group", kind: "buff", specToken: "RESTORATION_SHAMAN" },
  { id: "totem-of-wrath", label: "Totem of Wrath", icon: "totem-of-wrath", scope: "group", kind: "buff", specToken: "ELEMENTAL" },
  // Marksmanship talent in Wrath, same tree as TBC — confirmed via
  // Wowhead's talent-tree tag on the spell page.
  { id: "trueshot-aura", label: "Trueshot Aura", icon: "trueshot-aura", scope: "group", kind: "buff", specToken: "MARKSMANSHIP" },
  { id: "unleashed-rage", label: "Unleashed Rage", icon: "unleashed-rage", scope: "group", kind: "buff", specToken: "ENHANCEMENT" },
  { id: "blood-pact", label: "Blood Pact", icon: "blood-pact", scope: "group", kind: "buff", classToken: "WARLOCK" },
  { id: "bloodlust", label: "Bloodlust", icon: "bloodlust", scope: "raid", kind: "buff", classToken: "SHAMAN" },
  // Discipline talent, still present and unchanged in Wrath — was missing
  // from this list entirely despite existing in TBC's.
  { id: "pain-suppression", label: "Pain Suppression", icon: "pain-suppression", scope: "group", kind: "buff", specToken: "DISCIPLINE" },
  { id: "commanding-shout", label: "Commanding Shout", icon: "commanding-shout", scope: "group", kind: "buff", classToken: "WARRIOR" },
  { id: "vampiric-embrace", label: "Vampiric Embrace", icon: "vampiric-embrace", scope: "group", kind: "buff", specToken: "SHADOW" },
  { id: "sanctity-aura", label: "Sanctity Aura", icon: "sanctity-aura", scope: "group", kind: "buff", specToken: "RETRIBUTION" },

  { id: "faerie-fire", label: "Faerie Fire", icon: "faerie-fire", scope: "group", kind: "debuff", classToken: "DRUID" },
  { id: "sunder-armor", label: "Sunder Armor", icon: "sunder-armor", scope: "group", kind: "debuff", classToken: "WARRIOR" },
  { id: "expose-armor", label: "Expose Armor", icon: "expose-armor", scope: "group", kind: "debuff", classToken: "ROGUE" },
  { id: "demoralizing-shout", label: "Demoralizing Shout", icon: "demoralizing-shout", scope: "group", kind: "debuff", classToken: "WARRIOR" },
  { id: "insect-swarm", label: "Insect Swarm", icon: "insect-swarm", scope: "group", kind: "debuff", specToken: "BALANCE" },
  { id: "scorpid-sting", label: "Scorpid Sting", icon: "scorpid-sting", scope: "group", kind: "debuff", classToken: "HUNTER" },
  { id: "improved-scorch", label: "Improved Scorch", icon: "improved-scorch", scope: "group", kind: "debuff", specToken: "FIRE" },
  { id: "improved-shadow-bolt", label: "Improved Shadow Bolt", icon: "improved-shadow-bolt", scope: "group", kind: "debuff", specToken: "DESTRUCTION" },
  { id: "mangle", label: "Mangle", icon: "mangle", scope: "group", kind: "debuff", specToken: "FERAL_DRUID" },
  { id: "hemorrhage", label: "Hemorrhage", icon: "hemorrhage", scope: "group", kind: "debuff", specToken: "SUBTLETY" },
  { id: "curse-of-the-elements", label: "Curse of the Elements", icon: "curse-of-the-elements", scope: "group", kind: "debuff", classToken: "WARLOCK" },
];

const WOTLK_ONLY_BUFFS: BuffDef[] = [
  { id: "horn-of-winter", label: "Horn of Winter", icon: "horn-of-winter", scope: "group", kind: "buff", classToken: "DEATHKNIGHT" },
  { id: "improved-icy-talons", label: "Improved Icy Talons", icon: "improved-icy-talons", scope: "group", kind: "buff", specToken: "FROST_DK" },
  { id: "ebon-plaguebringer", label: "Ebon Plaguebringer", icon: "ebon-plaguebringer", scope: "group", kind: "debuff", specToken: "UNHOLY" },
];

const CATA_MOP_BUFFS_BASE: BuffDef[] = [
  { id: "arcane-brilliance", label: "Arcane Brilliance", icon: "arcane-brilliance", scope: "raid", kind: "buff", classToken: "MAGE" },
  { id: "battle-shout", label: "Battle Shout", icon: "battle-shout", scope: "raid", kind: "buff", classToken: "WARRIOR" },
  { id: "power-word-fortitude", label: "Power Word: Fortitude", icon: "power-word-fortitude", scope: "raid", kind: "buff", classToken: "PRIEST" },
  { id: "mark-of-the-wild", label: "Mark of the Wild", icon: "mark-of-the-wild", scope: "raid", kind: "buff", classToken: "DRUID" },
  { id: "blessing-of-kings", label: "Blessing of Kings", icon: "blessing-of-kings", scope: "raid", kind: "buff", classToken: "PALADIN" },
  { id: "blessing-of-might", label: "Blessing of Might", icon: "blessing-of-might", scope: "raid", kind: "buff", classToken: "PALADIN" },
  { id: "devotion-aura", label: "Devotion Aura", icon: "devotion-aura", scope: "raid", kind: "buff", classToken: "PALADIN" },
  { id: "horn-of-winter", label: "Horn of Winter", icon: "horn-of-winter", scope: "raid", kind: "buff", classToken: "DEATHKNIGHT" },
  { id: "strength-of-earth-totem", label: "Strength of Earth Totem", icon: "strength-of-earth-totem", scope: "raid", kind: "buff", classToken: "SHAMAN" },
  // Cata Quick Facts: plain "Requires Shaman", trainer-taught — not
  // Enhancement-locked (unlike unleashed-rage below, which genuinely is).
  { id: "windfury-totem", label: "Windfury Totem", icon: "windfury-totem", scope: "raid", kind: "buff", classToken: "SHAMAN" },
  { id: "bloodlust", label: "Bloodlust", icon: "bloodlust", scope: "raid", kind: "buff", classToken: "SHAMAN" },
  { id: "unleashed-rage", label: "Unleashed Rage", icon: "unleashed-rage", scope: "raid", kind: "buff", specToken: "ENHANCEMENT" },
  { id: "trueshot-aura", label: "Trueshot Aura", icon: "trueshot-aura", scope: "raid", kind: "buff", classToken: "HUNTER" },
  { id: "leader-of-the-pack", label: "Leader of the Pack", icon: "leader-of-the-pack", scope: "raid", kind: "buff", specToken: "FERAL_DRUID" },
  { id: "moonkin-form", label: "Moonkin Form", icon: "moonkin-form", scope: "raid", kind: "buff", specToken: "BALANCE" },
  { id: "elemental-oath", label: "Elemental Oath", icon: "elemental-oath", scope: "raid", kind: "buff", specToken: "ELEMENTAL" },
  { id: "demonic-pact", label: "Demonic Pact", icon: "demonic-pact", scope: "raid", kind: "buff", specToken: "DEMONOLOGY" },
  { id: "blood-pact", label: "Blood Pact", icon: "blood-pact", scope: "raid", kind: "buff", classToken: "WARLOCK" },
  { id: "commanding-shout", label: "Commanding Shout", icon: "commanding-shout", scope: "raid", kind: "buff", classToken: "WARRIOR" },
  { id: "stoneskin-totem", label: "Stoneskin Totem", icon: "stoneskin-totem", scope: "raid", kind: "buff", classToken: "SHAMAN" },
  { id: "rallying-cry", label: "Rallying Cry", icon: "rallying-cry", scope: "raid", kind: "buff", classToken: "WARRIOR" },
  { id: "power-word-barrier", label: "Power Word: Barrier", icon: "power-word-barrier", scope: "raid", kind: "buff", specToken: "DISCIPLINE" },
  { id: "spirit-link-totem", label: "Spirit Link Totem", icon: "spirit-link-totem", scope: "raid", kind: "buff", specToken: "RESTORATION_SHAMAN" },
  { id: "anti-magic-zone", label: "Anti-Magic Zone", icon: "anti-magic-zone", scope: "raid", kind: "buff", specToken: "BLOOD" },

  { id: "expose-armor", label: "Expose Armor", icon: "expose-armor", scope: "raid", kind: "debuff", classToken: "ROGUE" },
  { id: "sunder-armor", label: "Sunder Armor", icon: "sunder-armor", scope: "raid", kind: "debuff", classToken: "WARRIOR" },
  { id: "faerie-fire", label: "Faerie Fire", icon: "faerie-fire", scope: "raid", kind: "debuff", classToken: "DRUID" },
  { id: "curse-of-the-elements", label: "Curse of the Elements", icon: "curse-of-the-elements", scope: "raid", kind: "debuff", classToken: "WARLOCK" },
  { id: "ebon-plaguebringer", label: "Ebon Plaguebringer", icon: "ebon-plaguebringer", scope: "raid", kind: "debuff", specToken: "UNHOLY" },
  { id: "demoralizing-shout", label: "Demoralizing Shout", icon: "demoralizing-shout", scope: "raid", kind: "debuff", classToken: "WARRIOR" },
  { id: "mangle", label: "Mangle", icon: "mangle", scope: "raid", kind: "debuff", specToken: "FERAL_DRUID" },
  { id: "hemorrhage", label: "Hemorrhage", icon: "hemorrhage", scope: "raid", kind: "debuff", specToken: "SUBTLETY" },
  { id: "master-poisoner", label: "Master Poisoner", icon: "master-poisoner", scope: "raid", kind: "debuff", specToken: "ASSASSINATION" },
  { id: "thunder-clap", label: "Thunder Clap", icon: "thunder-clap", scope: "raid", kind: "debuff", classToken: "WARRIOR" },
];

// ---------------------------------------------------------------------------

export const EXPANSIONS: Record<ExpansionId, ExpansionDef> = {
  classic: {
    id: "classic",
    label: "Classic",
    shortLabel: "Classic",
    raidSize: 40,
    groupSize: 5,
    hasSpecs: true,
    maxLevel: 60,
    classes: CLASSES_9,
    specs: SPECS_CLASSIC,
    buffs: withSpellIds(CLASSIC_BUFFS),
  },
  tbc: {
    id: "tbc",
    label: "The Burning Crusade",
    shortLabel: "TBC",
    raidSize: 25,
    groupSize: 5,
    hasSpecs: true,
    maxLevel: 70,
    classes: CLASSES_9,
    specs: SPECS_TBC,
    buffs: withSpellIds(TBC_BUFFS),
  },
  wotlk: {
    id: "wotlk",
    label: "Wrath of the Lich King",
    shortLabel: "WotLK",
    raidSize: 25,
    groupSize: 5,
    hasSpecs: true,
    maxLevel: 80,
    classes: CLASSES_10,
    specs: SPECS_WOTLK,
    buffs: withWotlkSpellIds([...WOTLK_BUFFS, ...WOTLK_ONLY_BUFFS]),
  },
  cata: {
    id: "cata",
    label: "Cataclysm",
    shortLabel: "Cata",
    raidSize: 25,
    groupSize: 5,
    hasSpecs: true,
    maxLevel: 85,
    classes: CLASSES_10,
    specs: SPECS_CATA,
    buffs: withCataSpellIds(CATA_MOP_BUFFS_BASE),
  },
  mop: {
    id: "mop",
    label: "Mists of Pandaria",
    shortLabel: "MoP",
    raidSize: 25,
    groupSize: 5,
    hasSpecs: true,
    maxLevel: 90,
    classes: CLASSES_11,
    specs: SPECS_MOP,
    buffs: withCataSpellIds(CATA_MOP_BUFFS_BASE),
  },
};

export function getExpansion(id: string): ExpansionDef | null {
  return (EXPANSION_ORDER as string[]).includes(id)
    ? EXPANSIONS[id as ExpansionId]
    : null;
}

export function getSpec(expansion: ExpansionId, specToken: string): WowSpec | null {
  return EXPANSIONS[expansion].specs.find((s) => s.token === specToken) ?? null;
}

export function specLabel(
  classToken: string | null | undefined,
  specToken: string | null | undefined,
): string | null {
  if (!specToken) return null;
  for (const expansion of Object.values(EXPANSIONS)) {
    const spec = expansion.specs.find((s) => s.token === specToken);
    if (spec && (!classToken || spec.classToken === classToken)) {
      const cls = expansion.classes.find((c) => c.token === spec.classToken);
      return cls ? `${spec.label} ${cls.label}` : spec.label;
    }
  }
  return null;
}

export function wowIconUrl(slug: string): string {
  return `/icons/wow/${slug}.jpg`;
}