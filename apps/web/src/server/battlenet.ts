// Battle.net Game Data API client for the raid comp tool's spec sync —
// mirrors apps/bot/src/battlenetApi.ts's token-cache pattern (separate
// cache: web and bot are different processes/deployables). Only the
// specializations lookup lives here; character existence/guild-membership
// lookup stays bot-side (onboarding's concern, not the raid comp tool's).
//
// Credentials: BNET_CLIENT_ID / BNET_CLIENT_SECRET (env.js) — a guild with
// no Battle.net armory config (Guild.wowRegion/wowRealmSlug/
// wowNamespaceFlavor) or an instance with no BNET credentials never calls
// any of this; callers check bnetConfigured (see guild.get) first.

import { env } from "~/env";

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let cachedToken: CachedToken | null = null;

async function getAccessToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const clientId = env.BNET_CLIENT_ID;
  const clientSecret = env.BNET_CLIENT_SECRET;
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
        `[web] Battle.net token request failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
      return null;
    }
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 120) * 1000,
    };
    return cachedToken.accessToken;
  } catch (err) {
    console.error("[web] Battle.net token request errored:", err);
    return null;
  }
}

export type SpecializationLookupResult =
  | { status: "not_configured" }
  | { status: "unavailable" }
  | { status: "not_found" }
  | { status: "ok"; specializationName: string };

interface NameIdKey {
  name?: string;
  id?: number;
}

// Only the fields this lookup reads — the real response carries far more
// (talents, glyphs, spell tooltips) that the raid comp tool has no use for.
interface CharacterSpecializationsSummaryResponse {
  active_specialization?: NameIdKey;
  specialization_groups?: Array<{
    is_active?: boolean;
    specializations?: Array<{
      specialization_name?: string;
      spent_points?: number;
    }>;
  }>;
}

// Resolves one character's current talent specialization by display name
// ("Restoration", "Elemental", ...) — the caller maps that name plus the
// roster's known class onto a catalog spec token (see raidComp.ts's
// syncSpec), since this client has no opinion on the expansion's spec
// catalog. `namespaceFlavor` is Guild.wowNamespaceFlavor (e.g.
// "classicann"); classic (vanilla, no in-game specs) should never call
// this — callers check expansion.hasSpecs first.
export async function lookupCharacterSpecialization(
  region: string,
  realmSlug: string,
  name: string,
  namespaceFlavor: string,
): Promise<SpecializationLookupResult> {
  const token = await getAccessToken();
  if (!token) return { status: "not_configured" };

  const nameSlug = name.toLowerCase();
  const url =
    `https://${region}.api.blizzard.com/profile/wow/character/${realmSlug}/${nameSlug}/specializations` +
    `?namespace=profile-${namespaceFlavor}-${region}&locale=en_US`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return { status: "not_found" };
    if (!res.ok) {
      console.error(
        `[web] Battle.net specialization lookup for "${name}" failed: ${res.status}`,
      );
      return { status: "unavailable" };
    }
    const data = (await res.json()) as CharacterSpecializationsSummaryResponse;

    if (data.active_specialization?.name) {
      return { status: "ok", specializationName: data.active_specialization.name };
    }

    // No single "active" spec reported (some classic-era responses omit
    // it) — fall back to whichever group is flagged active, then its
    // highest-invested tree, matching how the in-game talent UI decides
    // "your spec" when Blizzard's own summary doesn't say so directly.
    const activeGroup =
      data.specialization_groups?.find((g) => g.is_active) ??
      data.specialization_groups?.[0];
    const topSpec = activeGroup?.specializations
      ?.filter((s) => s.specialization_name)
      .sort((a, b) => (b.spent_points ?? 0) - (a.spent_points ?? 0))[0];
    if (topSpec?.specialization_name) {
      return { status: "ok", specializationName: topSpec.specialization_name };
    }

    return { status: "unavailable" };
  } catch (err) {
    console.error(
      `[web] Battle.net specialization lookup for "${name}" errored:`,
      err,
    );
    return { status: "unavailable" };
  }
}