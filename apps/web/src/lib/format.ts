// Realm is optional for manually-created characters (addon imports always
// have one) — skip the dash entirely rather than showing a trailing "-".
export function characterLabel(name: string, realm: string): string {
  return realm ? `${name}-${realm}` : name;
}

// Standard WoW class colors, same values as the client's own
// RAID_CLASS_COLORS — keyed by the locale-independent class token
// (e.g. "WARRIOR") the addon exports.
const CLASS_COLORS: Record<string, string> = {
  WARRIOR: "#C79C6E",
  PALADIN: "#F58CBA",
  HUNTER: "#ABD473",
  ROGUE: "#FFF569",
  PRIEST: "#FFFFFF",
  SHAMAN: "#0070DE",
  MAGE: "#69CCF0",
  WARLOCK: "#9482C9",
  DRUID: "#FF7D0A",
};

export function classColor(classToken: string | null | undefined): string {
  return (classToken && CLASS_COLORS[classToken.toUpperCase()]) ?? "#B9BBBE";
}
