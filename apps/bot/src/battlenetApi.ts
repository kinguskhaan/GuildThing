// Battle.net Game Data API client — used during onboarding to tell apart a
// typo'd/nickname-typed character name (doesn't exist), a real character in
// a DIFFERENT guild, and a real character in THIS guild that just hasn't
// been (re-)imported into the local roster yet. See Guild.wowRegion etc. in
// schema.prisma and matchRosterAndApply in roleLogic.ts for where this
// plugs in. A guild with no armory config set never calls any of this.
//
// Credentials: BNET_CLIENT_ID / BNET_CLIENT_SECRET (client-credentials
// OAuth app created at develop.battle.net), same plain process.env pattern
// as DISCORD_BOT_TOKEN in index.ts — no config-loader abstraction here.

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cachedToken: CachedToken | null = null;

async function getAccessToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const clientId = process.env.BNET_CLIENT_ID;
  const clientSecret = process.env.BNET_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch("https://oauth.battle.net/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      console.error(
        `[bot] Battle.net token request failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
      return null;
    }
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    // Refresh a couple minutes early rather than racing the exact expiry.
    cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 120) * 1000,
    };
    return cachedToken.accessToken;
  } catch (err) {
    console.error("[bot] Battle.net token request errored:", err);
    return null;
  }
}

export type CharacterLookupResult =
  | { status: "not_found" }
  | { status: "unavailable" }
  | {
      status: "matches_expected_guild" | "wrong_guild" | "unguilded";
      // Battle.net's canonical spelling/casing of the name — useful even
      // for callers that don't care about guild membership (e.g. PUG
      // verification), since it's the correct display form regardless.
      name: string;
      level: number;
      class: string | null;
      // Only set when status is "wrong_guild" — null otherwise.
      actualGuildName: string | null;
    };

interface CharacterProfileResponse {
  name: string;
  level: number;
  character_class?: { name: string };
  guild?: { name: string };
}

// Looks up one character by exact name. `expectedGuildName` is compared
// case-insensitively against the character's current in-game guild (if
// any) to tell "this guild" from "a different guild".
export async function lookupCharacter(
  region: string,
  realmSlug: string,
  name: string,
  namespaceFlavor: string,
  expectedGuildName: string,
): Promise<CharacterLookupResult> {
  const token = await getAccessToken();
  if (!token) return { status: "unavailable" };

  const nameSlug = name.toLowerCase();
  const url =
    `https://${region}.api.blizzard.com/profile/wow/character/${realmSlug}/${nameSlug}` +
    `?namespace=profile-${namespaceFlavor}-${region}&locale=en_US`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return { status: "not_found" };
    if (!res.ok) {
      console.error(
        `[bot] Battle.net character lookup for "${name}" failed: ${res.status}`,
      );
      return { status: "unavailable" };
    }
    const data = (await res.json()) as CharacterProfileResponse;
    const level = data.level;
    const characterClass = data.character_class?.name ?? null;

    if (!data.guild) {
      return {
        status: "unguilded",
        name: data.name,
        level,
        class: characterClass,
        actualGuildName: null,
      };
    }
    if (data.guild.name.toLowerCase() === expectedGuildName.toLowerCase()) {
      return {
        status: "matches_expected_guild",
        name: data.name,
        level,
        class: characterClass,
        actualGuildName: null,
      };
    }
    return {
      status: "wrong_guild",
      name: data.name,
      level,
      class: characterClass,
      actualGuildName: data.guild.name,
    };
  } catch (err) {
    console.error(`[bot] Battle.net character lookup for "${name}" errored:`, err);
    return { status: "unavailable" };
  }
}
