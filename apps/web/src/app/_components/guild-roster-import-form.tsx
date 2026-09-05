"use client";

import { useMemo, useState } from "react";

import { ConfirmButton } from "~/app/_components/confirm-button";
import { api } from "~/trpc/react";

function formatTimestamp(value: Date | string) {
  return new Date(value).toLocaleString();
}

// Best-effort client-side preview of what a scan will change, so the confirm
// dialog can say something more useful than "this replaces the whole
// roster." The server re-validates and is the actual source of truth — if
// parsing fails here, the dialog just falls back to the generic warning and
// lets the server reject bad input on submit.
function previewDiff(raw: string, existingNames: string[]) {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { members?: unknown }).members)
    ) {
      return null;
    }
    const members = (parsed as { members: unknown[] }).members;
    const incomingNames = new Set(
      members
        .map((m) =>
          typeof m === "object" && m !== null && "name" in m
            ? String(m.name)
            : null,
        )
        .filter((n): n is string => n !== null),
    );
    const existing = new Set(existingNames);
    const added = [...incomingNames].filter((n) => !existing.has(n)).length;
    const removed = [...existing].filter((n) => !incomingNames.has(n)).length;
    const kept = incomingNames.size - added;
    return { total: incomingNames.size, added, kept, removed };
  } catch {
    return null;
  }
}

export function GuildRosterImportForm({
  guildId,
  existingMemberNames,
}: {
  guildId: string;
  /** Current roster member names, used only to preview the add/remove diff before confirming — the server re-validates independently. */
  existingMemberNames: string[];
}) {
  const [raw, setRaw] = useState("");
  const utils = api.useUtils();

  const diff = useMemo(
    () => previewDiff(raw, existingMemberNames),
    [raw, existingMemberNames],
  );
  const confirmDescription = diff
    ? `This scan found ${diff.total} member(s): ${diff.added} new, ${diff.kept} kept${
        diff.removed > 0
          ? `, and ${diff.removed} no longer present — they'll be removed from the roster`
          : ""
      }. Replace the roster with this scan?`
    : "This replaces the whole roster with whatever's pasted below — couldn't preview the exact changes from this input.";

  const status = api.guild.rosterImportStatus.useQuery({ guildId });

  const importRoster = api.guild.importRosterMembers.useMutation({
    onSuccess: async () => {
      setRaw("");
      await Promise.all([
        utils.guild.rosterMembers.invalidate({ guildId }),
        utils.guild.rosterImportStatus.invalidate({ guildId }),
      ]);
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-discord-text-muted">
        In-game, type <code>/gtr</code>, click &ldquo;Scan guild
        roster&rdquo;, then paste the export string here. This replaces the
        whole roster with whatever the scan found.
      </p>

      <p className="text-xs text-discord-text-muted">
        {status.data?.lastRosterImportedAt ? (
          <>
            Last imported {formatTimestamp(status.data.lastRosterImportedAt)}
            {status.data.lastRosterImportedByName
              ? ` by ${status.data.lastRosterImportedByName}`
              : ""}
          </>
        ) : (
          "Never imported yet."
        )}
      </p>

      <textarea
        className="h-40 rounded-lg bg-discord-base px-4 py-2 font-mono text-xs text-discord-text"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder='Paste the export string, e.g. {"guild":"...","members":[...]}'
      />

      {importRoster.error && (
        <p className="text-sm text-discord-red">
          {importRoster.error.message}
        </p>
      )}
      {importRoster.isSuccess && (
        <p className="text-sm text-discord-green">
          Imported {importRoster.data.count} member(s)!
        </p>
      )}

      <ConfirmButton
        label={importRoster.isPending ? "Importing..." : "Import"}
        confirmLabel="Replace roster"
        description={confirmDescription}
        onConfirm={() => importRoster.mutate({ guildId, exportString: raw })}
        disabled={importRoster.isPending || raw.trim() === ""}
        className="self-start rounded-full bg-discord-elevated-hover px-6 py-2 text-sm font-semibold transition hover:bg-discord-brand disabled:opacity-50"
      />
    </div>
  );
}
