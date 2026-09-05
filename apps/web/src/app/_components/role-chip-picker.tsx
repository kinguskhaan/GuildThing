"use client";

export function toggleRoleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((r) => r !== id) : [...list, id];
}

/** Merges a bot-fetched named role list with whichever role IDs are
 * currently selected — a selected ID missing from the fetched list (role
 * deleted in Discord since, or the bot's view is stale) still gets a chip,
 * just labeled by its raw ID instead of silently disappearing. */
export function mergeRolesWithSelected(
  known: { id: string; name: string }[],
  selectedIds: string[],
): { id: string; name: string }[] {
  const knownIds = new Set(known.map((r) => r.id));
  const unknown = selectedIds
    .filter((id) => !knownIds.has(id))
    .map((id) => ({ id, name: id }));
  return [...known, ...unknown];
}

export function RoleChipGroup({
  roles,
  selected,
  onToggle,
}: {
  roles: { id: string; name: string }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {roles.map((role) => (
        <button
          key={role.id}
          type="button"
          onClick={() => onToggle(role.id)}
          className={`schem-mono schem-chip text-xs ${
            selected.includes(role.id) ? "schem-chip-hot" : ""
          }`}
        >
          {role.name}
        </button>
      ))}
    </div>
  );
}
