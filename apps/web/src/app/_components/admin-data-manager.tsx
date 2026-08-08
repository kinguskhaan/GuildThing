"use client";

import { ConfirmButton } from "~/app/_components/confirm-button";
import { characterLabel } from "~/lib/format";
import { api } from "~/trpc/react";

export function AdminDataManager({ guildId }: { guildId: string }) {
  const utils = api.useUtils();
  const characters = api.guild.roster.useQuery({ guildId });

  const invalidate = () => utils.guild.roster.invalidate({ guildId });
  const deleteCharacter = api.guild.deleteCharacter.useMutation({
    onSuccess: invalidate,
  });
  const deleteProfession = api.guild.deleteProfession.useMutation({
    onSuccess: invalidate,
  });
  const deleteRecipe = api.guild.deleteRecipe.useMutation({
    onSuccess: invalidate,
  });

  if (characters.isLoading) {
    return <p className="text-discord-text-muted">Loading...</p>;
  }
  if (characters.error) {
    return <p className="text-discord-red">{characters.error.message}</p>;
  }
  if (!characters.data || characters.data.length === 0) {
    return (
      <p className="text-discord-text-muted">
        No characters imported in this guild yet.
      </p>
    );
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      {characters.data.map((character) => {
        const label = characterLabel(character.name, character.realm);
        const ownerLabel = character.user.nickname ?? character.user.name;
        return (
          <div
            key={character.id}
            className="flex flex-col gap-2 rounded-xl bg-discord-elevated p-4"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold">
                {label}
                <span className="ml-2 font-normal text-discord-text-muted">
                  {ownerLabel}
                </span>
              </span>
              <ConfirmButton
                label="Remove character"
                description={`Remove ${label} (${ownerLabel}) entirely? This deletes all of their professions and recipes. This can't be undone (though nothing is removed from the Wowhead catalog — it's just this character's data).`}
                onConfirm={() =>
                  deleteCharacter.mutate({ characterId: character.id })
                }
                className="text-sm text-discord-red underline"
              />
            </div>

            {character.professions.length > 0 && (
              <ul className="flex flex-col gap-1">
                {character.professions.map((profession) => (
                  <li key={profession.id} className="text-sm">
                    <span className="text-discord-text-muted">
                      {profession.name}:{" "}
                    </span>
                    {profession.recipes.map((recipe) => (
                      <span
                        key={recipe.id}
                        className="mr-2 inline-flex items-center gap-1"
                      >
                        {recipe.name}
                        <ConfirmButton
                          label="×"
                          description={`Remove "${recipe.name}" from ${label}? This only removes it from this character — the Wowhead catalog entry is untouched, and any other character who knows this recipe keeps it.`}
                          onConfirm={() =>
                            deleteRecipe.mutate({ recipeId: recipe.id })
                          }
                          className="text-discord-text-muted hover:text-discord-red"
                        />
                      </span>
                    ))}
                    <ConfirmButton
                      label="remove profession"
                      description={`Remove ${profession.name} (and all its recipes) from ${label}? This only affects this character — nothing is deleted from the Wowhead catalog, and other characters' ${profession.name} entries are untouched.`}
                      onConfirm={() =>
                        deleteProfession.mutate({ professionId: profession.id })
                      }
                      className="text-xs text-discord-text-muted underline hover:text-discord-red"
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
