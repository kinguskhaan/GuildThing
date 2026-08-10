// Application emoji IDs — uploaded once via the Discord API from the
// downloaded class icons (apps/web/public/class-icons/*.jpg, sourced from
// wow.zamimg.com), so they're usable as real Discord emoji in any server
// this bot is in, not just one guild's own emoji list. Hardcoded rather
// than re-uploaded on every start, same "stable, rarely-changes" spirit as
// CLASS_COLORS on the site (apps/web/src/lib/format.ts) — if these ever
// need to change, re-run the upload and update the ids here.
const CLASS_EMOJI_IDS: Record<string, string> = {
  WARRIOR: "1536441218890727494",
  PALADIN: "1536441221256577098",
  HUNTER: "1536441224570085376",
  ROGUE: "1536441227451306114",
  PRIEST: "1536441230165020722",
  SHAMAN: "1536441233151500298",
  MAGE: "1536441235739385887",
  WARLOCK: "1536441238717337670",
  DRUID: "1536441241556881419",
};

// Renders as the actual class icon when used in embed text (Discord parses
// <:name:id> tags there); returns null for an unknown/missing class so
// callers can fall back to plain text.
export function classEmojiTag(
  classToken: string | null | undefined,
): string | null {
  const id = classToken ? CLASS_EMOJI_IDS[classToken.toUpperCase()] : undefined;
  return id ? `<:${classToken!.toLowerCase()}:${id}>` : null;
}
