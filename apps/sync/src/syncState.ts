import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Remembers the last GuildThingRosterDB.syncRequestedAt value each target
// has already acted on (POSTed to /api/v1/request-sync for), so a repeat
// sight of the same unchanged flag doesn't re-trigger a request every
// pass. Has to be a FILE, not just an in-memory Map — this script is as
// often run fresh via cron every-30-minutes (pnpm start:once) as it is a
// long-lived watch-mode process, and a cron invocation has no memory of
// the previous one.
type State = Record<string, { lastSyncRequestedAt: number }>;

function readState(path: string): State {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as State;
  } catch {
    return {};
  }
}

export function hasActedOnSyncRequest(
  statePath: string,
  targetName: string,
  syncRequestedAt: number,
): boolean {
  const state = readState(statePath);
  return (state[targetName]?.lastSyncRequestedAt ?? 0) >= syncRequestedAt;
}

export function markSyncRequestActedOn(
  statePath: string,
  targetName: string,
  syncRequestedAt: number,
): void {
  const state = readState(statePath);
  state[targetName] = { lastSyncRequestedAt: syncRequestedAt };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
