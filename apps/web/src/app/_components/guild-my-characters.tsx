"use client";

import { useState } from "react";

import { ConfirmButton } from "~/app/_components/confirm-button";
import { RecipeCombobox } from "~/app/_components/recipe-combobox";
import { characterLabel } from "~/lib/format";
import { api } from "~/trpc/react";

export function GuildMyCharacters({ guildId }: { guildId: string }) {
  const utils = api.useUtils();
  const characters = api.guild.myCharacters.useQuery({ guildId });
  const deleteCharacter = api.guild.deleteCharacter.useMutation({
    onSuccess: async () => {
      await utils.guild.myCharacters.invalidate({ guildId });
    },
  });

  if (!characters.data || characters.data.length === 0) return null;

  return (
    <div className="flex w-full max-w-xl flex-col gap-2 rounded-xl bg-discord-elevated p-6">
      <h2 className="text-xl font-bold">Your imported characters</h2>
      <ul className="flex flex-col gap-3">
        {characters.data.map((character) => (
          <li
            key={character.id}
            className="flex flex-col gap-2 rounded-lg bg-discord-elevated px-4 py-3"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold">
                {characterLabel(character.name, character.realm)}
              </span>
              <ConfirmButton
                label="Remove"
                description={`Remove ${characterLabel(character.name, character.realm)} entirely? This deletes all of their professions and recipes. This can't be undone (though nothing is removed from the Wowhead catalog — it's just this character's data).`}
                onConfirm={() =>
                  deleteCharacter.mutate({ characterId: character.id })
                }
                className="text-sm text-discord-red underline"
              />
            </div>

            <ul className="flex flex-col gap-1">
              {character.professions.map((profession) => (
                <li key={profession.id} className="text-sm">
                  <span className="text-discord-text-muted">
                    {profession.name}:{" "}
                  </span>
                  {profession.recipes.map((recipe) => (
                    <RecipeChip
                      key={recipe.id}
                      recipeId={recipe.id}
                      name={recipe.name}
                      characterLabel={characterLabel(character.name, character.realm)}
                      guildId={guildId}
                    />
                  ))}
                  <RemoveProfessionButton
                    professionId={profession.id}
                    professionName={profession.name}
                    characterLabel={characterLabel(character.name, character.realm)}
                    guildId={guildId}
                  />
                </li>
              ))}
            </ul>

            <AddRecipeForm characterId={character.id} guildId={guildId} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecipeChip({
  recipeId,
  name,
  characterLabel,
  guildId,
}: {
  recipeId: string;
  name: string;
  characterLabel: string;
  guildId: string;
}) {
  const utils = api.useUtils();
  const deleteRecipe = api.guild.deleteRecipe.useMutation({
    onSuccess: async () => {
      await utils.guild.myCharacters.invalidate({ guildId });
    },
  });

  return (
    <span className="mr-2 inline-flex items-center gap-1">
      {name}
      <ConfirmButton
        label="×"
        description={`Remove "${name}" from ${characterLabel}? This only removes it from this character — the Wowhead catalog entry (icon, reagents, description) is untouched, and any other character who knows this recipe keeps it.`}
        onConfirm={() => deleteRecipe.mutate({ recipeId })}
        className="text-discord-text-muted hover:text-discord-red"
      />
    </span>
  );
}

function RemoveProfessionButton({
  professionId,
  professionName,
  characterLabel,
  guildId,
}: {
  professionId: string;
  professionName: string;
  characterLabel: string;
  guildId: string;
}) {
  const utils = api.useUtils();
  const deleteProfession = api.guild.deleteProfession.useMutation({
    onSuccess: async () => {
      await utils.guild.myCharacters.invalidate({ guildId });
    },
  });

  return (
    <ConfirmButton
      label="remove profession"
      description={`Remove ${professionName} (and all its recipes) from ${characterLabel}? This only affects this character — nothing is deleted from the Wowhead catalog, and other characters' ${professionName} entries are untouched.`}
      onConfirm={() => deleteProfession.mutate({ professionId })}
      className="text-xs text-discord-text-muted underline hover:text-discord-red"
    />
  );
}

function AddRecipeForm({
  characterId,
  guildId,
}: {
  characterId: string;
  guildId: string;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<{
    name: string;
    professionName: string;
  } | null>(null);
  const utils = api.useUtils();

  const addRecipe = api.guild.addRecipe.useMutation({
    onSuccess: async () => {
      setSelected(null);
      await utils.guild.myCharacters.invalidate({ guildId });
    },
  });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="self-start text-sm text-discord-link hover:underline"
      >
        + Add recipe manually
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!selected) return;
        addRecipe.mutate({
          characterId,
          professionName: selected.professionName,
          recipeName: selected.name,
        });
      }}
      className="flex flex-wrap items-center gap-2"
    >
      {selected ? (
        <span className="flex items-center gap-1 rounded-full bg-discord-elevated-hover px-3 py-1 text-sm">
          {selected.name}
          <span className="text-discord-text-muted">
            ({selected.professionName})
          </span>
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="text-discord-text-muted hover:text-discord-red"
          >
            ×
          </button>
        </span>
      ) : (
        <RecipeCombobox onSelect={setSelected} />
      )}
      <button
        type="submit"
        disabled={!selected || addRecipe.isPending}
        className="rounded-full bg-discord-elevated-hover px-3 py-1 text-sm font-semibold hover:bg-discord-brand disabled:opacity-50"
      >
        Add
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="text-sm text-discord-text-muted hover:underline"
      >
        Done
      </button>
      {addRecipe.error && (
        <p className="w-full text-sm text-discord-red">
          {addRecipe.error.message}
        </p>
      )}
    </form>
  );
}
