"use client";

import { useMemo, useState } from "react";

import {
  getWowheadEntry,
  tbcProfessionRecipes,
  wowheadIconUrl,
  wowheadUrl,
} from "@guildthing/wowhead-data";
import { characterLabel } from "~/lib/format";
import { api } from "~/trpc/react";

interface RecipeRow {
  name: string;
  crafters: { characterId: string; name: string; realm: string }[];
}

export function ProfessionRecipeBrowser({
  guildId,
  professionName,
}: {
  guildId: string;
  professionName: string;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const recipes = api.guild.professionRecipes.useQuery({
    guildId,
    professionName,
  });

  // Search the full Wowhead catalog for this profession, not just what's
  // actually been imported — a recipe nobody in the guild knows yet should
  // still show up (clearly marked as such) instead of looking like a typo.
  const combined = useMemo<RecipeRow[]>(() => {
    const craftersByName = new Map(recipes.data?.map((r) => [r.name, r]));
    const names = new Set(tbcProfessionRecipes[professionName] ?? []);
    for (const name of craftersByName.keys()) names.add(name);

    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => craftersByName.get(name) ?? { name, crafters: [] });
  }, [professionName, recipes.data]);

  const filtered = combined.filter((r) =>
    r.name.toLowerCase().includes(query.toLowerCase()),
  );

  const selectedRecipe = combined.find((r) => r.name === selected);

  return (
    <div className="flex w-full max-w-4xl gap-6">
      <div className="flex w-72 shrink-0 flex-col gap-3">
        <input
          className="rounded-full bg-discord-elevated px-4 py-2 text-discord-text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search recipes..."
        />

        {recipes.isLoading && (
          <p className="px-2 text-sm text-discord-text-muted">Loading...</p>
        )}
        {recipes.error && (
          <p className="px-2 text-sm text-discord-red">{recipes.error.message}</p>
        )}
        {query && filtered.length === 0 && (
          <p className="px-2 text-sm text-discord-text-muted">No matching recipes.</p>
        )}

        <ul className="flex max-h-[32rem] flex-col overflow-y-auto rounded-xl bg-discord-elevated">
          {filtered.map((recipe) => {
            const entry = getWowheadEntry(recipe.name);
            const active = recipe.name === selected;
            const craftable = recipe.crafters.length > 0;
            return (
              <li key={recipe.name}>
                <button
                  onClick={() => setSelected(recipe.name)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
                    active
                      ? "bg-discord-elevated-hover text-discord-text"
                      : craftable
                        ? "text-discord-text hover:bg-discord-elevated"
                        : "text-discord-text-muted opacity-60 hover:bg-discord-elevated hover:opacity-100"
                  }`}
                >
                  {entry && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={wowheadIconUrl(entry)}
                      alt=""
                      className="h-6 w-6 shrink-0 rounded"
                    />
                  )}
                  <span className="flex-1 truncate">{recipe.name}</span>
                  <span className="shrink-0 text-xs text-discord-text-muted">
                    {craftable ? recipe.crafters.length : "no one can craft this"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex-1 rounded-xl bg-discord-elevated p-6">
        {!selectedRecipe ? (
          <p className="text-discord-text-muted">
            Select a recipe to see who can craft it.
          </p>
        ) : (
          <RecipeDetail recipe={selectedRecipe} />
        )}
      </div>
    </div>
  );
}

function RecipeDetail({ recipe }: { recipe: RecipeRow }) {
  const entry = getWowheadEntry(recipe.name);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {entry && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={wowheadIconUrl(entry)}
            alt=""
            className="h-10 w-10 rounded"
          />
        )}
        <div>
          {entry ? (
            <a
              href={wowheadUrl(entry)}
              target="_blank"
              rel="noreferrer"
              className="text-lg font-bold text-discord-link hover:underline"
            >
              {recipe.name}
            </a>
          ) : (
            <h3 className="text-lg font-bold">{recipe.name}</h3>
          )}
        </div>
      </div>

      {entry?.description && (
        <p className="text-sm text-discord-text">{entry.description}</p>
      )}

      {entry?.reagents && entry.reagents.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-discord-text-muted">Reagents:</h4>
          <ul className="flex flex-col gap-2">
            {entry.reagents.map((reagent) => {
              const reagentEntry = getWowheadEntry(reagent.name);
              return (
                <li
                  key={reagent.name}
                  className="flex items-center gap-2 rounded-lg bg-discord-elevated px-3 py-2 text-sm"
                >
                  {reagentEntry && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={wowheadIconUrl(reagentEntry)}
                      alt=""
                      className="h-6 w-6 shrink-0 rounded"
                    />
                  )}
                  {reagentEntry ? (
                    <a
                      href={wowheadUrl(reagentEntry)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-discord-link hover:underline"
                    >
                      {reagent.name}
                    </a>
                  ) : (
                    <span>{reagent.name}</span>
                  )}
                  <span className="text-discord-text-muted">({reagent.quantity})</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold text-discord-text-muted">
          Can be crafted by:
        </h4>
        {recipe.crafters.length === 0 ? (
          <p className="rounded-lg bg-discord-elevated px-4 py-2 text-sm text-discord-text-muted italic">
            No one in this guild can craft this yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recipe.crafters.map((c) => (
              <li
                key={c.characterId}
                className="rounded-lg bg-discord-elevated px-4 py-2 text-sm"
              >
                {characterLabel(c.name, c.realm)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
