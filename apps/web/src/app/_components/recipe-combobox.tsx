"use client";

import Fuse from "fuse.js";
import { useMemo, useState } from "react";

import { tbcProfessionRecipes } from "@guildthing/wowhead-data";

interface RecipeIndexEntry {
  name: string;
  professions: string[];
}

const RECIPE_INDEX: RecipeIndexEntry[] = (() => {
  const map = new Map<string, string[]>();
  for (const [profession, names] of Object.entries(tbcProfessionRecipes)) {
    for (const name of names) {
      map.set(name, [...(map.get(name) ?? []), profession]);
    }
  }
  return [...map.entries()].map(([name, professions]) => ({ name, professions }));
})();

const fuse = new Fuse(RECIPE_INDEX, {
  keys: ["name"],
  threshold: 0.4,
  ignoreLocation: true,
});

export function RecipeCombobox({
  onSelect,
}: {
  onSelect: (recipe: { name: string; professionName: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);

  const results = useMemo(
    () => (query.trim() ? fuse.search(query.trim(), { limit: 8 }).map((r) => r.item) : []),
    [query],
  );

  function select(entry: RecipeIndexEntry) {
    onSelect({ name: entry.name, professionName: entry.professions[0]! });
    setQuery("");
    setOpen(false);
    setHighlighted(0);
  }

  return (
    <div className="relative">
      <input
        className="rounded-full bg-discord-elevated-hover px-3 py-1 text-sm text-discord-text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlighted(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 100)}
        onKeyDown={(e) => {
          if (!open || results.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlighted((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlighted((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            select(results[highlighted]!);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder="Search recipe name..."
      />

      {open && results.length > 0 && (
        <ul className="absolute top-full left-0 z-10 mt-1 w-64 overflow-hidden rounded-lg bg-discord-elevated-hover shadow-lg">
          {results.map((entry, i) => (
            <li key={entry.name}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(entry)}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                  i === highlighted ? "bg-discord-brand text-discord-text" : "text-discord-text"
                }`}
              >
                <span>{entry.name}</span>
                <span className="text-xs text-discord-text-muted">
                  {entry.professions.join(", ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
