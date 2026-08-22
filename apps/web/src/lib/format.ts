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

// The 9 WoW class tokens, for anything that needs to offer/validate a class
// choice (e.g. onboarding question conditions) — reuses the same keys as
// CLASS_COLORS instead of hardcoding a second copy of the list, matching
// WOW_CLASS_CHOICES on the bot side.
export const WOW_CLASS_TOKENS = Object.keys(CLASS_COLORS);

// Coarse relative time for "last active" columns — doesn't need
// second-level precision, so this deliberately steps down through minutes
// / hours / days rather than pulling in a date library for it. Falls back
// to a plain date once it's old enough that "N days ago" stops being a
// useful unit.
export function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

// Exact local timestamp, YYYY-MM-DD HH:MM:SS — for logs (e.g. the audit
// log) where "7m ago" isn't precise enough to actually pin down when
// something happened, unlike relativeTime's "roughly how long ago" framing
// for glanceable UI like "last active".
export function absoluteTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
