import type { NextRequest } from "next/server";

import { resolveApiKey, unauthorizedResponse } from "~/server/api-key-auth";
import { db } from "~/server/db";
import { applyRosterImport, rosterExportSchema } from "~/server/wow-import";

// Same shape/semantics as the tRPC `guild.importRosterMembers` procedure
// (see wow-import.ts) — this is just the key-authenticated entry point for
// apps/sync, since a locally-run script has no Discord session to attach.
export async function POST(request: NextRequest) {
  const auth = await resolveApiKey(request);
  if (!auth) return unauthorizedResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = rosterExportSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Body doesn't match the expected roster export shape.",
        issues: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const result = await applyRosterImport(db, auth.guildId, null, parsed.data);
  return Response.json(result);
}
