import type { NextRequest } from "next/server";
import { z } from "zod";

import { resolveApiKey, unauthorizedResponse } from "~/server/api-key-auth";
import { db } from "~/server/db";
import { applyCharacterImport, wowImportSchema } from "~/server/wow-import";

// Batch of one — apps/sync's OurRecipes.lua read naturally produces every
// alt on the account in one go, so this takes an array rather than one
// character per request. Each entry is applied independently (see
// applyCharacterImport in wow-import.ts) so one malformed/conflicting alt
// doesn't fail the whole push.
const bodySchema = z.object({
  characters: z.array(wowImportSchema).max(50),
});

export async function POST(request: NextRequest) {
  const auth = await resolveApiKey(request);
  if (!auth) return unauthorizedResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Body doesn't match the expected character export shape.",
        issues: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  let imported = 0;
  const errors: { name: string; realm: string; message: string }[] = [];

  for (const character of parsed.data.characters) {
    try {
      await applyCharacterImport(db, auth.guildId, null, character);
      imported++;
    } catch (err) {
      errors.push({
        name: character.name,
        realm: character.realm,
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return Response.json({ imported, errors });
}
