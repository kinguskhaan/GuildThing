import { readFileSync } from "node:fs";

import {
  asArray,
  asNumber,
  asObject,
  asString,
  parseLuaGlobals,
  type LuaValue,
} from "./luaTable";

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

// One guild's roster scan as stored in GuildThing.lua. `guild` is null for
// the legacy flat format, which never knew which guild it belonged to.
export interface GuildRoster {
  guild: string | null;
  lastScan: number;
  members: RosterMember[];
}

function mapMembers(roster: LuaValue[]): RosterMember[] {
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

// GuildThing.lua — since the addon began storing scans per guild (Core.lua's
// GT.ExportRoster): `GuildThingRosterDB.rosterByGuild = { ["<guild name>"] =
// { lastScan = ..., roster = {...} } }`, one entry per guild key. Older
// addon versions only wrote the legacy flat fields (`roster`/`lastScan`, the
// single most-recent-guild roster, with no guild identity) — when
// rosterByGuild is missing or empty, that flat roster is returned as the one
// entry with guild = null, which is what lets sync targets fall back to the
// old single-roster behavior.
export function parseGuildRosters(filePath: string): GuildRoster[] {
  const globals = parseLuaGlobals(readFileSync(filePath, "utf8"));
  const db = asObject(globals.GuildThingRosterDB);

  const entries: GuildRoster[] = [];
  if (db.rosterByGuild && !Array.isArray(db.rosterByGuild)) {
    for (const [guild, scan] of Object.entries(asObject(db.rosterByGuild))) {
      const s = asObject(scan);
      entries.push({
        guild,
        lastScan: typeof s.lastScan === "number" ? s.lastScan : 0,
        members: s.roster ? mapMembers(asArray(s.roster)) : [],
      });
    }
  }
  if (entries.length > 0) return entries;

  return [
    {
      guild: null,
      lastScan: typeof db.lastScan === "number" ? db.lastScan : 0,
      members: db.roster ? mapMembers(asArray(db.roster)) : [],
    },
  ];
}

// GuildThingRosterDB.syncRequestedAt — set by the addon's "Request sync"
// button (DiscordRolesUI.lua) to an epoch-seconds time() value. Read
// alongside the roster on every pass so index.ts can tell whether a new
// request has come in since it last acted on one (see syncState.ts) — a
// Discord-role sync trigger, not a roster re-scan, which happens on every
// pass regardless.
export function parseSyncRequestedAt(filePath: string): number | null {
  const globals = parseLuaGlobals(readFileSync(filePath, "utf8"));
  const db = asObject(globals.GuildThingRosterDB);
  return typeof db.syncRequestedAt === "number" ? db.syncRequestedAt : null;
}