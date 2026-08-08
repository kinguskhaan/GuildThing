"use client";

import { useMemo, useState } from "react";

import type { WowheadEntry } from "@guildthing/wowhead-data";
import { getWowheadEntry, wowheadIconUrl, wowheadUrl } from "@guildthing/wowhead-data";

const ALL_CATEGORY = "All";
const OTHER_CATEGORY = "Other (reagents/materials)";

export function AdminRecipeCatalog({
  entries,
  professionRecipes,
}: {
  entries: [string, WowheadEntry][];
  professionRecipes: Record<string, string[]>;
}) {
  const [category, setCategory] = useState(ALL_CATEGORY);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const professionNames = useMemo(
    () => Object.keys(professionRecipes).sort((a, b) => a.localeCompare(b)),
    [professionRecipes],
  );

  const nameToProfessions = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [profession, names] of Object.entries(professionRecipes)) {
      for (const name of names) {
        map.set(name, [...(map.get(name) ?? []), profession]);
      }
    }
    return map;
  }, [professionRecipes]);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    counts.set(ALL_CATEGORY, entries.length);
    for (const profession of professionNames) counts.set(profession, 0);
    counts.set(OTHER_CATEGORY, 0);

    for (const [name] of entries) {
      const belongsTo = nameToProfessions.get(name);
      if (belongsTo) {
        for (const profession of belongsTo) {
          counts.set(profession, (counts.get(profession) ?? 0) + 1);
        }
      } else {
        counts.set(OTHER_CATEGORY, (counts.get(OTHER_CATEGORY) ?? 0) + 1);
      }
    }

    return [ALL_CATEGORY, ...professionNames, OTHER_CATEGORY].map((name) => ({
      name,
      count: counts.get(name) ?? 0,
    }));
  }, [entries, professionNames, nameToProfessions]);

  const categoryFiltered = useMemo(() => {
    if (category === ALL_CATEGORY) return entries;
    if (category === OTHER_CATEGORY) {
      return entries.filter(([name]) => !nameToProfessions.has(name));
    }
    return entries.filter(([name]) =>
      nameToProfessions.get(name)?.includes(category),
    );
  }, [entries, category, nameToProfessions]);

  const filtered = categoryFiltered.filter(([name]) =>
    name.toLowerCase().includes(query.toLowerCase()),
  );
  const selectedEntry = selected ? getWowheadEntry(selected) : undefined;

  return (
    <div className="flex w-full max-w-6xl gap-6">
      <div className="flex w-48 shrink-0 flex-col gap-1">
        {categories.map(({ name, count }) => (
          <button
            key={name}
            onClick={() => {
              setCategory(name);
              setSelected(null);
            }}
            className={`flex items-center justify-between rounded-lg px-2 py-2 text-left text-sm transition ${
              category === name
                ? "bg-discord-elevated-hover text-discord-text"
                : "text-discord-text-muted hover:bg-discord-elevated hover:text-discord-text"
            }`}
          >
            <span className="truncate">{name}</span>
            <span className="shrink-0 text-xs text-discord-text-muted">{count}</span>
          </button>
        ))}
      </div>

      <div className="flex w-72 shrink-0 flex-col gap-3">
        <input
          className="rounded-full bg-discord-elevated px-4 py-2 text-discord-text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search catalog..."
        />

        <p className="px-2 text-xs text-discord-text-muted">
          {filtered.length} of {categoryFiltered.length} entries
        </p>

        <ul className="flex max-h-[32rem] flex-col overflow-y-auto rounded-xl bg-discord-elevated">
          {filtered.map(([name, entry]) => {
            const active = name === selected;
            return (
              <li key={name}>
                <button
                  onClick={() => setSelected(name)}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
                    active ? "bg-discord-elevated-hover text-discord-text" : "text-discord-text hover:bg-discord-elevated"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={wowheadIconUrl(entry)}
                    alt=""
                    className="h-6 w-6 shrink-0 rounded"
                  />
                  <span className="flex-1 truncate">{name}</span>
                  <span className="shrink-0 text-xs text-discord-text-muted">
                    {entry.kind}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex-1 rounded-xl bg-discord-elevated p-6">
        {!selectedEntry ? (
          <p className="text-discord-text-muted">Select an entry to see its details.</p>
        ) : (
          <EntryDetail name={selected!} entry={selectedEntry} />
        )}
      </div>
    </div>
  );
}

function EntryDetail({ name, entry }: { name: string; entry: WowheadEntry }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={wowheadIconUrl(entry)} alt="" className="h-10 w-10 rounded" />
        <div>
          <a
            href={wowheadUrl(entry)}
            target="_blank"
            rel="noreferrer"
            className="text-lg font-bold text-discord-link hover:underline"
          >
            {name}
          </a>
          <p className="text-xs text-discord-text-muted">
            {entry.kind} #{entry.id}
            {entry.quality != null ? ` · quality ${entry.quality}` : ""}
          </p>
        </div>
      </div>

      {entry.description && (
        <p className="text-sm text-discord-text">{entry.description}</p>
      )}

      {entry.reagents && entry.reagents.length > 0 && (
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
    </div>
  );
}
