// The 9 WoW class tokens used across the project — copied from the bot's
// WOW_CLASS_CHOICES (apps/bot/src/onboarding.ts), which matches the class
// tokens the GuildThing Roster addon itself exports and the list the
// site's CLASS_COLORS keys off. Shared here so the DB package (e.g.
// onboardingMigration.ts building the class question) and the bot both
// use one canonical list.
export type WowClass = { id: string; label: string };

export const WOW_CLASS_TOKENS: WowClass[] = [
  { id: "WARRIOR", label: "Warrior" },
  { id: "PALADIN", label: "Paladin" },
  { id: "HUNTER", label: "Hunter" },
  { id: "ROGUE", label: "Rogue" },
  { id: "PRIEST", label: "Priest" },
  { id: "SHAMAN", label: "Shaman" },
  { id: "MAGE", label: "Mage" },
  { id: "WARLOCK", label: "Warlock" },
  { id: "DRUID", label: "Druid" },
];