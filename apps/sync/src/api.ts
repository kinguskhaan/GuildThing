import type { ImportedCharacter } from "./parseRecipes";
import type { RosterMember } from "./parseRoster";

async function post<T>(
  apiUrl: string,
  apiKey: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(new URL(path, apiUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function get<T>(apiUrl: string, apiKey: string, path: string): Promise<T> {
  const res = await fetch(new URL(path, apiUrl), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export function postRoster(apiUrl: string, apiKey: string, members: RosterMember[]) {
  return post<{ count: number }>(apiUrl, apiKey, "/api/v1/roster", {
    members,
  });
}

export function postCharacters(
  apiUrl: string,
  apiKey: string,
  characters: ImportedCharacter[],
) {
  return post<{
    imported: number;
    errors: { name: string; realm: string; message: string }[];
  }>(apiUrl, apiKey, "/api/v1/characters", { characters });
}

// Discord nick/account tag/role names per roster member (keyed by
// character name — the only identifier the addon itself has), for writing
// into a SavedVariables file the addon reads on its next login/reload. See
// discord-roles/route.ts.
export function getDiscordRoles(apiUrl: string, apiKey: string) {
  return get<{
    members: Record<string, { nick: string | null; tag: string | null; roleNames: string[] }>;
  }>(apiUrl, apiKey, "/api/v1/discord-roles");
}

// Unified rank-change + manual-Discord-role-change history, keyed by
// character name, for writing into a SavedVariables file the addon's Audit
// Log tab reads. See audit-log/route.ts.
export function getAuditLog(apiUrl: string, apiKey: string) {
  return get<{
    entries: {
      characterName: string;
      detail: string;
      detectedAt: number;
      discordNick: string | null;
      discordTag: string | null;
    }[];
  }>(apiUrl, apiKey, "/api/v1/audit-log");
}

// API-key-authenticated equivalent of the website's "Sync now" button —
// lets an in-game "Request sync" click (relayed through this script) nudge
// the bot's role resync sooner than the daily cron, without a Discord
// session. See request-sync/route.ts.
export function requestSync(apiUrl: string, apiKey: string) {
  return post<{ ok: boolean }>(apiUrl, apiKey, "/api/v1/request-sync", {});
}
