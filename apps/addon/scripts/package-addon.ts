/**
 * Zips GuildThing/ into apps/web/public/downloads/GuildThing.zip so it's
 * servable as a static download from the running app. The zip's top-level
 * folder is named GuildThing, matching the .toc, so extracting it straight
 * into .../Interface/AddOns/ works as-is. Run with:
 *
 *   pnpm addon:package
 *
 * Re-run whenever GuildThing/*.lua changes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const addonDir = fileURLToPath(new URL("..", import.meta.url));
const outDir = fileURLToPath(
  new URL("../../web/public/downloads", import.meta.url),
);
const outFile = `${outDir}/GuildThing.zip`;

// apps/addon/GuildThing/SyncData.lua is gitignored (apps/sync overwrites
// it on every real run, and on this dev machine specifically the addon
// folder is symlinked into a live WoW install for testing — see the
// .gitignore comment) — so a fresh checkout won't have one. It's listed
// in GuildThing.toc's file list, so the addon needs SOME version of it to
// load without erroring; write the same empty-data stub apps/sync ships
// as the default until a real sync run overwrites it.
const syncDataPath = `${addonDir}GuildThing/SyncData.lua`;
if (!existsSync(syncDataPath)) {
  writeFileSync(
    syncDataPath,
    `-- Written by apps/sync, NOT by this addon and NOT via SavedVariables —
-- see syncAddonDataFile in apps/sync/src/index.ts. This default (empty)
-- stub ships with the addon so DiscordRolesUI.lua/AuditLogUI.lua have
-- something valid to read even before apps/sync has ever run.
GuildThingDiscordRolesDB = {
\t["members"] = {},
}
GuildThingAuditLogDB = {
\t["entries"] = {},
}
`,
  );
  console.log(`[package-addon] wrote stub ${syncDataPath}`);
}

mkdirSync(outDir, { recursive: true });
if (existsSync(outFile)) rmSync(outFile);

execFileSync(
  "zip",
  // -x excludes Claude Code's own per-project state (e.g. GuildThing/.claude/mind.mv2,
  // multiple MB of session memory) — it lands inside this folder only because
  // addon/GuildThing/ happens to be a working directory Claude Code has run in,
  // not addon content, and must never ship to end users.
  ["-r", outFile, "GuildThing", "-x", "GuildThing/.claude/*"],
  { cwd: addonDir, stdio: "inherit" },
);

console.log(`[package-addon] wrote ${outFile}`);
