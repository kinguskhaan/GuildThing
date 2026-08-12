"use client";

import { useState } from "react";

import { ConfirmButton } from "~/app/_components/confirm-button";
import { api } from "~/trpc/react";

function formatTimestamp(value: Date | string) {
  return new Date(value).toLocaleString();
}

export function GuildApiKeys({ guildId }: { guildId: string }) {
  const utils = api.useUtils();
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);

  const keys = api.guild.listApiKeys.useQuery({ guildId });
  const createKey = api.guild.createApiKey.useMutation({
    onSuccess: async () => {
      setName("");
      await utils.guild.listApiKeys.invalidate({ guildId });
    },
  });
  const revokeKey = api.guild.revokeApiKey.useMutation({
    onSuccess: async () => utils.guild.listApiKeys.invalidate({ guildId }),
  });

  return (
    <div className="flex w-full max-w-xl flex-col gap-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          createKey.mutate({ guildId, name });
        }}
        className="flex gap-2"
      >
        <input
          className="flex-1 rounded-full bg-discord-base px-4 py-2 text-discord-text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Label, e.g. 'Tankkingen's PC'"
          required
        />
        <button
          type="submit"
          disabled={createKey.isPending}
          className="rounded-full bg-discord-elevated-hover px-4 py-2 text-sm font-semibold"
        >
          {createKey.isPending ? "Creating..." : "Create key"}
        </button>
      </form>
      {createKey.error && (
        <p className="text-sm text-discord-red">{createKey.error.message}</p>
      )}

      {createKey.data && (
        <div className="flex flex-col gap-2 rounded-xl bg-discord-elevated p-4">
          <p className="text-sm font-semibold">
            &quot;{createKey.data.name}&quot; created — copy this key now,
            you won&apos;t see it again.
          </p>
          <div className="flex gap-2">
            <code className="flex-1 overflow-x-auto rounded-lg bg-discord-base p-3 text-xs">
              {createKey.data.rawKey}
            </code>
            <button
              type="button"
              onClick={() => {
                const value = createKey.data.rawKey;
                void navigator.clipboard.writeText(value).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="shrink-0 rounded-full bg-discord-base px-4 text-sm font-semibold hover:bg-discord-elevated-hover"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      )}

      {keys.isLoading && (
        <p className="text-sm text-discord-text-muted">Loading...</p>
      )}
      {keys.data?.length === 0 && (
        <p className="text-sm text-discord-text-muted">
          No keys yet — create one above and use it with apps/sync to push
          roster and character data automatically.
        </p>
      )}

      {keys.data && keys.data.length > 0 && (
        <ul className="flex flex-col gap-2">
          {keys.data.map((key) => (
            <li
              key={key.id}
              className="flex items-center justify-between gap-2 rounded-xl bg-discord-elevated p-4"
            >
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold">
                  {key.name}
                  {key.revokedAt && (
                    <span className="ml-2 text-xs font-normal text-discord-red">
                      Revoked
                    </span>
                  )}
                </span>
                <span className="text-xs text-discord-text-muted">
                  {key.prefix}… · created {formatTimestamp(key.createdAt)} ·{" "}
                  {key.lastUsedAt
                    ? `last used ${formatTimestamp(key.lastUsedAt)}`
                    : "never used"}
                </span>
              </div>
              {!key.revokedAt && (
                <ConfirmButton
                  label="Revoke"
                  confirmLabel="Revoke key"
                  description={`"${key.name}" will stop working immediately. Any script using it will need a new key.`}
                  onConfirm={() => revokeKey.mutate({ guildId, id: key.id })}
                  className="shrink-0 rounded-full bg-discord-base px-3 py-1.5 text-sm hover:bg-discord-elevated-hover"
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
