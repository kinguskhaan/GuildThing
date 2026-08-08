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
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const addonDir = fileURLToPath(new URL("..", import.meta.url));
const outDir = fileURLToPath(
  new URL("../../web/public/downloads", import.meta.url),
);
const outFile = `${outDir}/GuildThing.zip`;

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
