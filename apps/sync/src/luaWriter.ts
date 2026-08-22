// Inverse of luaTable.ts's reader — this is the first thing apps/sync ever
// writes rather than reads. Small hand-rolled serializer, same "just
// enough for the data this actually needs to carry" philosophy as
// luaTable.ts's parser: literals and keyed/positional tables, nothing
// else. WoW's own SavedVariables writer always uses bracketed string keys
// (`["key"] = value`), so this matches that shape exactly rather than
// inventing a different-but-equivalent one — keeps the file readable by
// the same mental model as every other SavedVariables file, in case anyone
// ever opens it by hand.
function luaEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function serializeLuaValue(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return `"${luaEscape(value)}"`;
  if (Array.isArray(value)) {
    return `{\n${value.map((v) => `\t${serializeLuaValue(v)},`).join("\n")}\n}`;
  }
  const entries = Object.entries(value as Record<string, unknown>).map(
    ([k, v]) => `\t["${luaEscape(k)}"] = ${serializeLuaValue(v)},`,
  );
  return `{\n${entries.join("\n")}\n}`;
}

// Writes a SavedVariables-shaped file: GLOBAL_NAME = { ... }\n — the exact
// top-level shape WoW's own SavedVariables files use, so the addon's
// `## SavedVariables: GLOBAL_NAME` .toc declaration picks it up normally.
export function serializeSavedVariables(globalName: string, data: unknown): string {
  return `${globalName} = ${serializeLuaValue(data)}\n`;
}
