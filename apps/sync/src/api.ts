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
