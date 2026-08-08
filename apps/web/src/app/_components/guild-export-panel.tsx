"use client";

import { useState } from "react";

import { api } from "~/trpc/react";

function formatTimestamp(value: Date | string) {
  return new Date(value).toLocaleString();
}

export function GuildExportPanel({ guildId }: { guildId: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const utils = api.useUtils();

  const status = api.guild.exportStatus.useQuery(
    { guildId },
    { enabled: open },
  );
  const exportRoster = api.guild.exportRoster.useMutation({
    onSuccess: async () => {
      await utils.guild.exportStatus.invalidate({ guildId });
    },
  });

  return (
    <div className="w-full max-w-xl rounded-xl bg-discord-elevated">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-6 py-3 text-left text-sm font-semibold"
      >
        <span>{open ? "▾" : "▸"}</span>
        Export guild data for addon
      </button>

      {open && (
        <div className="flex flex-col gap-3 px-6 pb-6">
          <p className="text-sm text-discord-text-muted">
            Paste this into the GuildThing addon in-game to see who can craft
            what.
          </p>

          <p className="text-xs text-discord-text-muted">
            {status.data?.lastExportedAt ? (
              <>
                Last exported {formatTimestamp(status.data.lastExportedAt)}
                {status.data.lastExportedByName
                  ? ` by ${status.data.lastExportedByName}`
                  : ""}
              </>
            ) : (
              "Never exported yet."
            )}
          </p>

          <button
            type="button"
            onClick={() => exportRoster.mutate({ guildId })}
            disabled={exportRoster.isPending}
            className="self-start rounded-full bg-discord-elevated px-6 py-2 text-sm font-semibold transition hover:bg-discord-elevated-hover"
          >
            {exportRoster.isPending ? "Generating..." : "Generate export"}
          </button>

          {exportRoster.error && (
            <p className="text-sm text-discord-red">
              {exportRoster.error.message}
            </p>
          )}

          {exportRoster.data && (
            <>
              <textarea
                readOnly
                value={exportRoster.data}
                onFocus={(e) => e.currentTarget.select()}
                className="h-32 w-full resize-none rounded-lg bg-discord-base p-3 font-mono text-xs text-discord-text"
              />
              <button
                type="button"
                onClick={() => {
                  const data = exportRoster.data;
                  void navigator.clipboard.writeText(data).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  });
                }}
                className="self-start rounded-full bg-discord-elevated px-6 py-2 text-sm font-semibold transition hover:bg-discord-elevated-hover"
              >
                {copied ? "Copied!" : "Copy to clipboard"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
