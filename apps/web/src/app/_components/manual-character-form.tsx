"use client";

import { useState } from "react";

import { api } from "~/trpc/react";

export function ManualCharacterForm({ guildId }: { guildId: string }) {
  const [name, setName] = useState("");
  const utils = api.useUtils();

  const createCharacter = api.guild.createCharacter.useMutation({
    onSuccess: async () => {
      setName("");
      await utils.guild.myCharacters.invalidate({ guildId });
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        createCharacter.mutate({ guildId, name });
      }}
      className="flex w-full max-w-xl flex-col gap-3 rounded-xl bg-discord-elevated p-6"
    >
      <h2 className="text-xl font-bold">Add a character manually</h2>
      <p className="text-sm text-discord-text-muted">
        Not using the addon? Register a character here, then add recipes to
        it below.
      </p>
      <input
        className="rounded-full bg-discord-elevated-hover px-4 py-2 text-discord-text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Character name"
        required
      />
      {createCharacter.error && (
        <p className="text-sm text-discord-red">
          {createCharacter.error.message}
        </p>
      )}
      <button
        type="submit"
        className="self-start rounded-full bg-discord-elevated-hover px-6 py-2 font-semibold transition hover:bg-discord-brand"
        disabled={createCharacter.isPending}
      >
        {createCharacter.isPending ? "Adding..." : "Add character"}
      </button>
    </form>
  );
}
