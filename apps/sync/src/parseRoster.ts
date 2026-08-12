import { readFileSync } from "node:fs";

import { asArray, asNumber, asObject, asString, parseLuaGlobals } from "./luaTable";

// Matches rosterExportSchema.members on the web side (see
// apps/web/src/server/wow-import.ts) field-for-field.
export interface RosterMember {
  name: string;
  rank: string;
  level: number;
  class: string | null;
  note: string | null;
  officernote: string | null;
}

// GuildThing.lua: `GuildThingRosterDB = { lastScan = ..., roster = { {...},
// {...} } }` — see apps/addon/GuildThing/Core.lua's GT.ExportRoster, which
// builds the same shape by hand for the in-game /gtr export this mirrors.
export function parseRosterFile(filePath: string): RosterMember[] {
  const globals = parseLuaGlobals(readFileSync(filePath, "utf8"));
  const db = asObject(globals.GuildThingRosterDB);
  const roster = asArray(db.roster);

  return roster.map((entry) => {
    const m = asObject(entry);
    return {
      name: asString(m.name),
      rank: asString(m.rank),
      level: asNumber(m.level),
      class: typeof m.class === "string" ? m.class : null,
      note: typeof m.note === "string" ? m.note : null,
      officernote: typeof m.officernote === "string" ? m.officernote : null,
    };
  });
}
