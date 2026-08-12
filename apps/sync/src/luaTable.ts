// A tiny recursive-descent parser for exactly the subset of Lua that WoW's
// SavedVariables serializer produces: literals (strings, numbers, booleans,
// nil) and table constructors, either positional (`{ {...}, {...} }`, an
// array) or keyed (`{ ["name"] = ... }`, an object) — never a mix, and
// always bracketed string keys, never bare `key = value` fields. That
// narrowness is what makes a hand-rolled parser reasonable here instead of
// pulling in a general Lua-language parser: this only ever has to parse
// data, never code.
export type LuaValue =
  | string
  | number
  | boolean
  | null
  | LuaValue[]
  // Deliberately a literal index signature, not `Record<string, LuaValue>`
  // — TS reports "LuaValue circularly references itself" for the Record
  // form here, but not for this one.
  | { [key: string]: LuaValue };

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  '"': '"',
  "'": "'",
  "\\": "\\",
};

class LuaParser {
  private pos = 0;

  constructor(private readonly src: string) {}

  private skipWs() {
    for (;;) {
      const c = this.src[this.pos];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.pos++;
      } else if (c === "-" && this.src[this.pos + 1] === "-") {
        while (this.pos < this.src.length && this.src[this.pos] !== "\n") {
          this.pos++;
        }
      } else {
        return;
      }
    }
  }

  private peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? "";
  }

  private expect(ch: string) {
    this.skipWs();
    if (this.src[this.pos] !== ch) {
      throw new Error(
        `Expected '${ch}' at offset ${this.pos}, near: ${this.src.slice(this.pos, this.pos + 30)}`,
      );
    }
    this.pos++;
  }

  private parseIdentifier(): string {
    this.skipWs();
    const start = this.pos;
    while (/[A-Za-z0-9_]/.test(this.src[this.pos] ?? "")) this.pos++;
    if (this.pos === start) {
      throw new Error(`Expected an identifier at offset ${start}`);
    }
    return this.src.slice(start, this.pos);
  }

  private parseString(): string {
    this.skipWs();
    const quote = this.src[this.pos];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Expected a string at offset ${this.pos}`);
    }
    this.pos++;
    let out = "";
    while (this.pos < this.src.length && this.src[this.pos] !== quote) {
      const c = this.src[this.pos];
      if (c === "\\") {
        const next = this.src[this.pos + 1] ?? "";
        out += ESCAPES[next] ?? next;
        this.pos += 2;
      } else {
        out += c ?? "";
        this.pos++;
      }
    }
    this.pos++; // closing quote
    return out;
  }

  private parseNumber(): number {
    this.skipWs();
    const start = this.pos;
    if (this.src[this.pos] === "-") this.pos++;
    while (/[0-9.eE+-]/.test(this.src[this.pos] ?? "")) this.pos++;
    const text = this.src.slice(start, this.pos);
    const n = Number(text);
    if (Number.isNaN(n)) {
      throw new Error(`Invalid number '${text}' at offset ${start}`);
    }
    return n;
  }

  private parseValue(): LuaValue {
    const c = this.peek();
    if (c === "{") return this.parseTable();
    if (c === '"' || c === "'") return this.parseString();
    if (c === "-" || (c >= "0" && c <= "9")) return this.parseNumber();

    const start = this.pos;
    const word = this.parseIdentifier();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "nil") return null;
    throw new Error(`Unexpected token '${word}' at offset ${start}`);
  }

  private parseTable(): LuaValue {
    this.expect("{");
    const arrayItems: LuaValue[] = [];
    const objectFields: Record<string, LuaValue> = {};
    let isObject = false;

    while (this.peek() !== "}") {
      if (this.peek() === "[") {
        this.expect("[");
        const key = this.parseString();
        this.expect("]");
        this.skipWs();
        this.expect("=");
        objectFields[key] = this.parseValue();
        isObject = true;
      } else {
        arrayItems.push(this.parseValue());
      }

      this.skipWs();
      if (this.src[this.pos] === ",") {
        this.pos++;
      } else {
        break;
      }
    }
    this.expect("}");

    return isObject ? objectFields : arrayItems;
  }

  // Parses the whole file as a sequence of top-level `IDENT = value`
  // statements (what every SavedVariables file is) and returns every one
  // found, keyed by identifier.
  parseGlobals(): Record<string, LuaValue> {
    const result: Record<string, LuaValue> = {};
    this.skipWs();
    while (this.pos < this.src.length) {
      const name = this.parseIdentifier();
      this.skipWs();
      this.expect("=");
      result[name] = this.parseValue();
      this.skipWs();
    }
    return result;
  }
}

export function parseLuaGlobals(source: string): Record<string, LuaValue> {
  return new LuaParser(source).parseGlobals();
}

export function asObject(
  value: LuaValue | undefined,
): Record<string, LuaValue> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  // An empty Lua table (`{}`) is genuinely ambiguous between an empty array
  // and an empty object — the parser has no field to tell it apart, so it
  // defaults to `[]`. Treat that case as an empty object here rather than
  // erroring, since that's what every real "no data yet" field (e.g. a
  // character with no professions scanned) actually means.
  if (Array.isArray(value) && value.length === 0) {
    return {};
  }
  throw new Error("Expected a Lua table (object), got something else");
}

export function asArray(value: LuaValue | undefined): LuaValue[] {
  if (Array.isArray(value)) return value;
  throw new Error("Expected a Lua array, got something else");
}

export function asString(value: LuaValue | undefined): string {
  if (typeof value === "string") return value;
  throw new Error("Expected a string, got something else");
}

export function asNumber(value: LuaValue | undefined): number {
  if (typeof value === "number") return value;
  throw new Error("Expected a number, got something else");
}
