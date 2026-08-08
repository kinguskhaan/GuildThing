"use client";

import { useState } from "react";

import { api, type RouterInputs } from "~/trpc/react";

type ImportedCharacter = RouterInputs["guild"]["importCharacter"]["character"];

export function GuildImportForm({ guildId }: { guildId: string }) {
  const [raw, setRaw] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const utils = api.useUtils();

  const importCharacter = api.guild.importCharacter.useMutation({
    onSuccess: async () => {
      setRaw("");
      setParseError(null);
      await utils.guild.myCharacters.invalidate({ guildId });
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setParseError(null);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          setParseError("Invalid JSON — paste the whole blob from the addon.");
          return;
        }
        importCharacter.mutate({
          guildId,
          character: parsed as ImportedCharacter,
        });
      }}
      className="flex w-full max-w-xl flex-col gap-3 rounded-xl bg-discord-elevated p-6"
    >
      <h2 className="text-xl font-bold">Import character</h2>
      <textarea
        className="h-40 rounded-lg bg-discord-elevated px-4 py-2 font-mono text-xs text-discord-text"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder='Paste the JSON from the addon, e.g. {"name":"Tankkingen","realm":"Spineshatter",...}'
        required
      />
      {parseError && <p className="text-sm text-discord-red">{parseError}</p>}
      {importCharacter.error && (
        <p className="text-sm text-discord-red">
          {importCharacter.error.message}
        </p>
      )}
      {importCharacter.isSuccess && (
        <p className="text-sm text-discord-green">Imported!</p>
      )}
      <button
        type="submit"
        className="rounded-full bg-discord-elevated px-6 py-2 font-semibold transition hover:bg-discord-elevated-hover"
        disabled={importCharacter.isPending}
      >
        {importCharacter.isPending ? "Importing..." : "Import"}
      </button>
    </form>
  );
}
