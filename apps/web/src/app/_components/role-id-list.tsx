"use client";

export function RoleIdList({
  roleIds,
  onChange,
  label = "Required role IDs (any of these grants access)",
  addLabel = "+ Add role",
  allowEmpty = false,
}: {
  roleIds: string[];
  onChange: (roleIds: string[]) => void;
  label?: string;
  addLabel?: string;
  /** When true, all rows (including the last) can be removed, and rows aren't required. */
  allowEmpty?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm">{label}</span>
      {roleIds.map((roleId, i) => (
        <div key={i} className="flex gap-2">
          <input
            className="flex-1 rounded-full bg-discord-elevated px-4 py-2 text-discord-text"
            value={roleId}
            onChange={(e) => {
              const next = [...roleIds];
              next[i] = e.target.value;
              onChange(next);
            }}
            placeholder="Role ID (e.g. 'guildie')"
            required={!allowEmpty}
          />
          {(allowEmpty || roleIds.length > 1) && (
            <button
              type="button"
              onClick={() => onChange(roleIds.filter((_, j) => j !== i))}
              className="rounded-full bg-discord-elevated px-3 text-sm hover:bg-discord-elevated-hover"
            >
              ✕
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...roleIds, ""])}
        className="self-start rounded-full bg-discord-elevated px-4 py-1 text-sm hover:bg-discord-elevated-hover"
      >
        {addLabel}
      </button>
    </div>
  );
}
