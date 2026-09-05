import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAuditLog, getDiscordRoles, getGuild, postCharacters, postRoster, requestSync } from "./api";
import { serializeSavedVariables } from "./luaWriter";
import {
  defaultWowWtfDir,
  listSavedVariablesFiles,
  resolveAddonInstallDir,
  resolveWtfDir,
} from "./paths";
import { parseRecipesFile } from "./parseRecipes";
import type { ImportedCharacter } from "./parseRecipes";
import { parseGuildRosters, parseSyncRequestedAt } from "./parseRoster";
import type { GuildRoster } from "./parseRoster";
import { hasActedOnSyncRequest, markSyncRequestActedOn } from "./syncState";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SyncTarget {
  name: string;
  apiUrl: string;
  apiKey: string;
  wtfDir: string;
}

// A config entry either spells out wtfDir directly, or gives wowDir +
// version and lets resolveWtfDir() work out the .../<version>_/WTF path —
// the latter is what most people should use; wtfDir stays available for
// non-standard installs (custom launcher, unusual folder layout).
interface RawTargetEntry {
  name?: string;
  apiUrl?: string;
  apiKey?: string;
  wtfDir?: string;
  wowDir?: string;
  version?: string;
}

function resolveTargetWtfDir(entry: RawTargetEntry, path: string, index: number): string {
  if (entry.wtfDir) return entry.wtfDir;
  if (entry.wowDir && entry.version) {
    try {
      return resolveWtfDir(entry.wowDir, entry.version);
    } catch (err) {
      console.error(`[sync] target #${index + 1} in ${path}:`, (err as Error).message);
      process.exit(1);
    }
  }
  console.error(
    `[sync] target #${index + 1} in ${path} needs either "wtfDir", or "wowDir" + "version" (one of: retail, classic, classic_era, anniversary).`,
  );
  process.exit(1);
}

// Multiple targets can share the same wtfDir (e.g. several guilds you're in
// on the same WoW install, each with its own API key) — SavedVariables are
// only read once per unique wtfDir per sync, then pushed to every target
// that uses it.
// Windows paths use backslashes, which most people pasting one in (e.g.
// from Explorer's address bar) won't think to double up for JSON — a bare
// "C:\Program Files\..." fails to parse with a cryptic "bad escaped
// character" error. This doubles up any backslash that isn't already part
// of a real JSON escape sequence, so raw Windows paths just work;
// correctly-escaped JSON (or forward-slash paths) passes through
// unchanged. Matching (and thus consuming) whole escape sequences first is
// what makes this safe on an already-escaped "\\" pair — matching each
// backslash independently would double the second one too.
function tolerateWindowsPaths(text: string): string {
  return text.replace(/\\u[0-9a-fA-F]{4}|\\["\\/bfnrt]|\\/g, (m) =>
    m.length > 1 ? m : "\\\\",
  );
}

function loadConfigFile(path: string): SyncTarget[] {
  let raw: unknown;
  try {
    raw = JSON.parse(tolerateWindowsPaths(readFileSync(path, "utf8")));
  } catch (err) {
    console.error(`[sync] couldn't read/parse config file ${path}:`, err);
    process.exit(1);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    console.error(`[sync] ${path} must be a JSON array with at least one target.`);
    process.exit(1);
  }

  return raw.map((entry, i) => {
    const e = entry as RawTargetEntry;
    if (!e.apiUrl || !e.apiKey) {
      console.error(`[sync] target #${i + 1} in ${path} is missing apiUrl or apiKey.`);
      process.exit(1);
    }
    return {
      name: e.name ?? `target-${i + 1}`,
      apiUrl: e.apiUrl,
      apiKey: e.apiKey,
      wtfDir: resolveTargetWtfDir(e, path, i),
    };
  });
}

function loadLegacyEnvConfig(): SyncTarget {
  const apiUrl = process.env.GUILDTHING_API_URL;
  const apiKey = process.env.GUILDTHING_API_KEY;
  if (!apiUrl || !apiKey) {
    console.error(
      "No sync.config.json found, and GUILDTHING_API_URL/GUILDTHING_API_KEY aren't set.\n" +
        "For a single guild: copy .env.example to .env and fill it in.\n" +
        "For multiple guilds/WoW installs: copy sync.config.example.json to sync.config.json and list your targets there.",
    );
    process.exit(1);
  }

  const wtfDir = defaultWowWtfDir();
  if (!wtfDir) {
    console.error(
      "Couldn't guess your WoW install path (this is normal on Linux/Steam Proton) — set WOW_WTF_DIR in apps/sync/.env to the folder that contains 'Account' (e.g. .../World of Warcraft/_anniversary_/WTF).",
    );
    process.exit(1);
  }

  return { name: "default", apiUrl, apiKey, wtfDir };
}

const CONFIG_PATH =
  process.env.GUILDTHING_SYNC_CONFIG ?? join(__dirname, "..", "sync.config.json");
// Sits next to the config, not in-memory only — this script runs as often
// as a fresh process every 30 minutes via cron (pnpm start:once) as it does
// a long-lived watch-mode session, and a cron invocation has no memory of
// the last one. See syncState.ts.
const STATE_PATH = join(dirname(CONFIG_PATH), "sync.state.json");

function loadConfig(): SyncTarget[] {
  if (existsSync(CONFIG_PATH)) return loadConfigFile(CONFIG_PATH);
  return [loadLegacyEnvConfig()];
}

function groupByWtfDir(targets: SyncTarget[]): Map<string, SyncTarget[]> {
  const groups = new Map<string, SyncTarget[]>();
  for (const target of targets) {
    const group = groups.get(target.wtfDir) ?? [];
    group.push(target);
    groups.set(target.wtfDir, group);
  }
  return groups;
}

interface RosterData {
  guildRosters: GuildRoster[];
  characters: ImportedCharacter[];
  // Set by the addon's "Request sync" button (DiscordRolesUI.lua) — see
  // relaySyncRequest below. Null means no request pending (the common
  // case). Several accounts can share one install, and any of them may
  // have pressed the button — the newest request across all of them is
  // what gets acted on.
  syncRequestedAt: number | null;
}

function readWtfDir(wtfDir: string): RosterData {
  // Every ACCOUNT's SavedVariables are read — one install can hold several
  // Battle.net accounts, and each contributes its own guild scans (and
  // characters) to every target sharing this install. GuildThing.lua is
  // required, so none at all is still a hard error.
  const rosterFiles = listSavedVariablesFiles(wtfDir, "GuildThing.lua");
  if (rosterFiles.length === 0) {
    throw new Error(
      `Couldn't find GuildThing.lua under ${join(wtfDir, "Account")}/*/SavedVariables — make sure the addon is installed and you've logged in at least once since installing it.`,
    );
  }
  // OurRecipes is optional — only GuildThing (/gtr) is required, so no
  // recipes file under any account just means no character/profession
  // data this run, not a failed sync.
  const recipesFiles = listSavedVariablesFiles(wtfDir, "OurRecipes.lua");

  const guildRosters = rosterFiles.flatMap((file) => parseGuildRosters(file));
  const characters = mergeCharacters(
    recipesFiles.flatMap((file) => parseRecipesFile(file)),
  );

  let syncRequestedAt: number | null = null;
  for (const file of rosterFiles) {
    const at = parseSyncRequestedAt(file);
    if (at !== null && (syncRequestedAt === null || at > syncRequestedAt)) {
      syncRequestedAt = at;
    }
  }
  return { guildRosters, characters, syncRequestedAt };
}

// The same "<Name>-<Realm>" can appear in more than one account's
// OurRecipes.lua (one person playing on two Battle.net accounts, or
// entries relayed in through OurRecipes' own P2P mesh). Characters carry
// no guild identity, so the install pushes one UNION of every account's
// file: the first copy wins the identity fields, later copies only
// contribute recipes not already present.
function mergeCharacters(all: ImportedCharacter[]): ImportedCharacter[] {
  const byKey: Record<string, ImportedCharacter> = {};
  for (const c of all) {
    const key = `${c.name}-${c.realm}`;
    const existing = byKey[key];
    if (!existing) {
      byKey[key] = { ...c, professions: { ...c.professions } };
      continue;
    }
    if (existing.class === undefined && c.class !== undefined) {
      existing.class = c.class;
    }
    for (const [profession, recipes] of Object.entries(c.professions)) {
      const merged = (existing.professions[profession] ??= []);
      for (const recipe of recipes) {
        if (
          !merged.some(
            (r) =>
              r.name === recipe.name &&
              r.spellID === recipe.spellID &&
              r.itemID === recipe.itemID,
          )
        ) {
          merged.push(recipe);
        }
      }
    }
  }
  return Object.values(byKey);
}

async function syncTarget(target: SyncTarget, data: RosterData): Promise<void> {
  // The API key IS the guild identity on the site side — resolve it per
  // target so each guild gets the roster of ITS guild. A failed lookup is
  // treated as an unknown guild: roster picking then falls back to the
  // legacy guild-less roster below, and characters push either way.
  let guild: { name: string } | null = null;
  try {
    guild = await getGuild(target.apiUrl, target.apiKey);
  } catch (err) {
    console.error(
      `[sync:${target.name}] guild lookup failed: ${(err as Error).message}`,
    );
  }

  // Exact guild-name match, newest scan winning when several accounts have
  // scanned the same guild. The ONLY fallback is a legacy guild-less
  // roster — pushing another guild's scan would overwrite the site's
  // membership with the wrong guild's members.
  const matching = guild
    ? data.guildRosters.filter((r) => r.guild === guild?.name)
    : [];
  const legacy = data.guildRosters.find((r) => r.guild === null);

  if (matching.length > 0) {
    const best = matching.reduce((a, b) => (b.lastScan > a.lastScan ? b : a));
    const rosterResult = await postRoster(
      target.apiUrl,
      target.apiKey,
      best.members,
    );
    console.log(
      `[sync:${target.name}] roster: pushed ${rosterResult.count} member(s) for guild "${guild?.name}"`,
    );
  } else if (legacy) {
    const rosterResult = await postRoster(
      target.apiUrl,
      target.apiKey,
      legacy.members,
    );
    console.log(
      `[sync:${target.name}] roster: pushed ${rosterResult.count} member(s) (legacy guild-less roster)`,
    );
  } else {
    console.error(
      `[sync:${target.name}] no roster scan for guild "${guild?.name ?? "<guild lookup failed>"}" under this install — skipping roster push (characters still sync)`,
    );
  }

  const charResult = await postCharacters(target.apiUrl, target.apiKey, data.characters);
  console.log(
    `[sync:${target.name}] characters: imported ${charResult.imported}/${data.characters.length}`,
  );
  for (const err of charResult.errors) {
    console.error(`[sync:${target.name}]   ${err.name}-${err.realm}: ${err.message}`);
  }
}

// Pulls current Discord role names AND the unified audit log down for
// every target sharing this wtfDir, and writes them together into ONE
// plain addon-code file (SyncData.lua) in the addon's own install folder —
// deliberately NOT a SavedVariables file. WoW only ever "owns" (loads once,
// then saves the current in-memory state back over on every reload/logout)
// files declared under an addon's `## SavedVariables:` — every other file
// in its `.toc` file list is just re-read fresh from disk on every single
// addon load, the same as any other addon's code. Writing plain
// `GLOBAL = {...}` assignments into a file on that list, instead of into
// GuildThing.lua's SavedVariables, means a write that lands while the
// client is running is never at risk of being clobbered by the client's
// own save-on-teardown — there's nothing for WoW to "save back" here, so
// even a plain /reload (not a full client restart) picks it up correctly.
// See GuildThing.toc for the matching file-list entry.
//
// Both globals are written together in one file (rather than reusing the
// old per-global write-and-overwrite pattern) because this file has no
// existing content worth preserving between runs — unlike the old
// merge-into-GuildThing.lua approach, there's no roster data living
// alongside these two, so a plain full overwrite is correct and simpler.
// Targets sharing a wtfDir just merge/concatenate — different guilds'
// members/entries don't collide in practice, and duplicate audit rows
// across two guild-keys on the same install are harmless.
//
// Best-effort as a whole: a failure here never affects the roster/
// character push in syncTarget, which already succeeded independently —
// the addon's Discord Roles/Audit Log tabs just show stale (or no) data
// until the next successful run.
async function syncAddonDataFile(wtfDir: string, targets: SyncTarget[]): Promise<void> {
  const members: Record<
    string,
    { nick: string | null; tag: string | null; roleNames: string[] }
  > = {};
  for (const target of targets) {
    try {
      const result = await getDiscordRoles(target.apiUrl, target.apiKey);
      Object.assign(members, result.members);
    } catch (err) {
      console.error(`[sync:${target.name}] failed to fetch Discord roles:`, err);
    }
  }

  const entries: Awaited<ReturnType<typeof getAuditLog>>["entries"] = [];
  for (const target of targets) {
    try {
      const result = await getAuditLog(target.apiUrl, target.apiKey);
      entries.push(...result.entries);
    } catch (err) {
      console.error(`[sync:${target.name}] failed to fetch audit log:`, err);
    }
  }
  entries.sort((a, b) => b.detectedAt - a.detectedAt);

  try {
    const addonDir = resolveAddonInstallDir(wtfDir);
    const writePath = join(addonDir, "SyncData.lua");
    writeFileSync(
      writePath,
      serializeSavedVariables("GuildThingDiscordRolesDB", { members }) +
        serializeSavedVariables("GuildThingAuditLogDB", { entries }),
    );
    console.log(
      `[sync] wrote Discord roles for ${Object.keys(members).length} member(s) and ${entries.length} audit log entrie(s) into ${writePath}`,
    );
  } catch (err) {
    console.error(`[sync] failed to write SyncData.lua for ${wtfDir}:`, err);
  }
}

// Relays an in-game "Request sync" click to each target this install
// serves — NOT live: the flag only reaches this script once the player
// has logged out or /reload'd (SavedVariables only flush to disk then),
// and from there it's bounded by this script's own poll cadence. See
// GuildThingRosterDB.syncRequestedAt (DiscordRolesUI.lua) and syncState.ts
// for why "already acted on this value" has to be persisted, not just
// remembered in memory.
async function relaySyncRequest(
  wtfDir: string,
  targets: SyncTarget[],
  syncRequestedAt: number | null,
): Promise<void> {
  if (syncRequestedAt == null) return;
  for (const target of targets) {
    if (hasActedOnSyncRequest(STATE_PATH, target.name, syncRequestedAt)) continue;
    try {
      await requestSync(target.apiUrl, target.apiKey);
      markSyncRequestActedOn(STATE_PATH, target.name, syncRequestedAt);
      console.log(`[sync:${target.name}] relayed in-game sync request`);
    } catch (err) {
      console.error(`[sync:${target.name}] failed to relay sync request:`, err);
    }
  }
}

// Targets sharing a wtfDir get one read of that install's SavedVariables,
// fanned out to each target's own API key.
async function syncGroup(wtfDir: string, targets: SyncTarget[]): Promise<void> {
  let data: RosterData;
  try {
    data = readWtfDir(wtfDir);
  } catch (err) {
    console.error(`[sync] failed reading ${wtfDir}:`, err);
    return;
  }

  for (const target of targets) {
    try {
      await syncTarget(target, data);
    } catch (err) {
      console.error(`[sync:${target.name}] failed:`, err);
    }
  }

  await syncAddonDataFile(wtfDir, targets);
  await relaySyncRequest(wtfDir, targets, data.syncRequestedAt);
}

async function syncAll(targets: SyncTarget[]): Promise<void> {
  for (const [wtfDir, group] of groupByWtfDir(targets)) {
    await syncGroup(wtfDir, group);
  }
}

const POLL_INTERVAL_MS = 15_000;
// WoW writes several addons' SavedVariables files close together on
// logout/reload — wait for things to settle before syncing, so a run
// doesn't fire mid-write or fire twice for one logout.
const DEBOUNCE_MS = 5_000;

function watch(targets: SyncTarget[]): void {
  const groups = groupByWtfDir(targets);
  console.log(
    `[sync] watching ${groups.size} WoW install(s), ${targets.length} target(s) total, for SavedVariables changes (Ctrl+C to stop)...`,
  );

  const lastMtimes = new Map<string, { roster: number; recipes: number }>();
  const pendingSyncs = new Map<string, NodeJS.Timeout>();

  const checkDir = (wtfDir: string, group: SyncTarget[]) => {
    let rosterMtime: number;
    let recipesMtime: number;
    try {
      // Every account's SavedVariables copy is watched — any account's
      // file changing means this install's data changed (readWtfDir
      // unions them all). No files at all yields 0, the same
      // "never seen an update" sentinel as before, which never matches
      // a later mtime.
      const newest = (files: string[]) =>
        files.reduce((max, file) => Math.max(max, statSync(file).mtimeMs), 0);
      rosterMtime = newest(listSavedVariablesFiles(wtfDir, "GuildThing.lua"));
      recipesMtime = newest(listSavedVariablesFiles(wtfDir, "OurRecipes.lua"));
    } catch (err) {
      console.error(`[sync] couldn't check SavedVariables files in ${wtfDir}:`, err);
      return;
    }

    const last = lastMtimes.get(wtfDir);
    if (last?.roster === rosterMtime && last.recipes === recipesMtime) return;
    lastMtimes.set(wtfDir, { roster: rosterMtime, recipes: recipesMtime });

    const existing = pendingSyncs.get(wtfDir);
    if (existing) clearTimeout(existing);
    pendingSyncs.set(
      wtfDir,
      setTimeout(() => {
        syncGroup(wtfDir, group).catch((err: unknown) => {
          console.error(`[sync] failed for ${wtfDir}:`, err);
        });
      }, DEBOUNCE_MS),
    );
  };

  const checkAll = () => {
    for (const [wtfDir, group] of groups) checkDir(wtfDir, group);
  };

  checkAll();
  setInterval(checkAll, POLL_INTERVAL_MS);
}

const targets = loadConfig();
if (process.argv.includes("--once")) {
  syncAll(targets)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error("[sync] failed:", err);
      process.exit(1);
    });
} else {
  watch(targets);
}
