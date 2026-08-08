"use client";

import { useState } from "react";

import { api } from "~/trpc/react";

function formatTimestamp(value: Date | string) {
  return new Date(value).toLocaleString();
}

export function GuildRosterImportForm({ guildId }: { guildId: string }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const utils = api.useUtils();

  const status = api.guild.rosterImportStatus.useQuery(
    { guildId },
    { enabled: open },
  );

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
    <div className="w-full max-w-xl rounded-xl bg-discord-elevated">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-6 py-3 text-left text-sm font-semibold"
      >
        <span>{open ? "▾" : "▸"}</span>
        Import roster from addon
      </button>

      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            importRoster.mutate({ guildId, exportString: raw });
          }}
          className="flex flex-col gap-3 px-6 pb-6"
        >
          <p className="text-sm text-discord-text-muted">
            In-game, type <code>/gtr</code>, click &ldquo;Scan guild
            roster&rdquo;, then paste the export string here. This replaces
            the whole roster with whatever the scan found.
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
            required
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

          <button
            type="submit"
            className="self-start rounded-full bg-discord-elevated px-6 py-2 text-sm font-semibold transition hover:bg-discord-elevated-hover"
            disabled={importRoster.isPending}
          >
            {importRoster.isPending ? "Importing..." : "Import"}
          </button>
        </form>
      )}
    </div>
  );
}
