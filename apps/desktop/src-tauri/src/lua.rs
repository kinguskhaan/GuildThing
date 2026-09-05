//! A tiny recursive-descent parser for exactly the subset of Lua that WoW's
//! SavedVariables serializer produces: literals (strings, numbers, booleans,
//! nil) and table constructors, either positional (`{ {...}, {...} }`, an
//! array) or keyed (`{ ["name"] = ... }`, an object) — never a mix, and
//! always bracketed string keys, never bare `key = value` fields. That
//! narrowness is what makes a hand-rolled parser reasonable here instead of
//! pulling in a general Lua-language parser: this only ever has to parse
//! data, never code.
//!
//! Port of apps/sync/src/luaTable.ts (plus the inverse serializer from
//! luaWriter.ts) — keep the two in behavioral lockstep.

use serde_json::{Number, Value};
use std::collections::HashMap;


#[derive(Debug, Clone, PartialEq)]
pub enum LuaValue {
    Str(String),
    Num(f64),
    Bool(bool),
    Nil,
    Array(Vec<LuaValue>),
    Table(HashMap<String, LuaValue>),
}

impl LuaValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            LuaValue::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            LuaValue::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[LuaValue]> {
        match self {
            LuaValue::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_table(&self) -> Option<&HashMap<String, LuaValue>> {
        match self {
            LuaValue::Table(t) => Some(t),
            _ => None,
        }
    }
}

struct LuaParser<'a> {
    src: &'a [u8],
    pos: usize,
}

impl<'a> LuaParser<'a> {
    fn new(src: &'a str) -> Self {
        Self {
            src: src.as_bytes(),
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        loop {
            let Some(&c) = self.src.get(self.pos) else {
                return;
            };
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                self.pos += 1;
            } else if c == b'-' && self.src.get(self.pos + 1) == Some(&b'-') {
                // Line comment.
                while self.pos < self.src.len() && self.src[self.pos] != b'\n' {
                    self.pos += 1;
                }
            } else {
                return;
            }
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.src.get(self.pos).copied()
    }

    fn expect(&mut self, ch: u8) -> Result<(), String> {
        self.skip_ws();
        if self.src.get(self.pos) != Some(&ch) {
            let near: String = self.src[self.pos.min(self.src.len())..]
                .iter()
                .take(30)
                .map(|&b| b as char)
                .collect();
            return Err(format!(
                "Expected '{}' at offset {}, near: {near}",
                ch as char, self.pos
            ));
        }
        self.pos += 1;
        Ok(())
    }

    fn parse_identifier(&mut self) -> Result<String, String> {
        self.skip_ws();
        let start = self.pos;
        while self
            .src
            .get(self.pos)
            .is_some_and(|&c| c.is_ascii_alphanumeric() || c == b'_')
        {
            self.pos += 1;
        }
        if self.pos == start {
            return Err(format!("Expected an identifier at offset {start}"));
        }
        Ok(String::from_utf8_lossy(&self.src[start..self.pos]).into_owned())
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.skip_ws();
        let quote = self
            .src
            .get(self.pos)
            .copied()
            .filter(|&c| c == b'"' || c == b'\'')
            .ok_or(format!("Expected a string at offset {}", self.pos))?;
        self.pos += 1;
        let mut out = String::new();
        while self.pos < self.src.len() && self.src[self.pos] != quote {
            let c = self.src[self.pos];
            if c == b'\\' {
                let next = self.src.get(self.pos + 1).copied().unwrap_or(b'\\');
                // Rust source escape first, then fall back to the literal
                // char — same "unknown escape passes through" rule as the
                // TS version's `ESCAPES[next] ?? next`.
                let mapped = match next as char {
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    other => other,
                };
                out.push(mapped);
                self.pos += 2;
            } else {
                // SavedVariables files are UTF-8; copy through verbatim.
                let len = utf8_len(c);
                out.push_str(&String::from_utf8_lossy(
                    &self.src[self.pos..(self.pos + len).min(self.src.len())],
                ));
                self.pos += len;
            }
        }
        self.pos += 1; // closing quote
        Ok(out)
    }

    fn parse_number(&mut self) -> Result<f64, String> {
        self.skip_ws();
        let start = self.pos;
        if self.src.get(self.pos) == Some(&b'-') {
            self.pos += 1;
        }
        while self
            .src
            .get(self.pos)
            .is_some_and(|&c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-'))
        {
            self.pos += 1;
        }
        let text = String::from_utf8_lossy(&self.src[start..self.pos]);
        text.parse::<f64>()
            .map_err(|_| format!("Invalid number '{text}' at offset {start}"))
    }

    fn parse_value(&mut self) -> Result<LuaValue, String> {
        match self.peek() {
            Some(b'{') => self.parse_table(),
            Some(b'"') | Some(b'\'') => self.parse_string().map(LuaValue::Str),
            Some(b'-') => self.parse_number().map(LuaValue::Num),
            Some(c) if c.is_ascii_digit() => self.parse_number().map(LuaValue::Num),
            _ => {
                let start = self.pos;
                let word = self.parse_identifier()?;
                match word.as_str() {
                    "true" => Ok(LuaValue::Bool(true)),
                    "false" => Ok(LuaValue::Bool(false)),
                    "nil" => Ok(LuaValue::Nil),
                    _ => Err(format!("Unexpected token '{word}' at offset {start}")),
                }
            }
        }
    }

    fn parse_table(&mut self) -> Result<LuaValue, String> {
        self.expect(b'{')?;
        let mut array_items: Vec<LuaValue> = Vec::new();
        let mut object_fields: HashMap<String, LuaValue> = HashMap::new();
        let mut is_object = false;

        while self.peek() != Some(b'}') {
            if self.peek() == Some(b'[') {
                self.expect(b'[')?;
                let key = self.parse_string()?;
                self.expect(b']')?;
                self.expect(b'=')?;
                let value = self.parse_value()?;
                object_fields.insert(key, value);
                is_object = true;
            } else {
                array_items.push(self.parse_value()?);
            }

            if self.peek() == Some(b',') {
                self.pos += 1;
            } else {
                break;
            }
        }
        self.expect(b'}')?;

        Ok(if is_object {
            LuaValue::Table(object_fields)
        } else {
            LuaValue::Array(array_items)
        })
    }

    /// Parses the whole file as a sequence of top-level `IDENT = value`
    /// statements (what every SavedVariables file is) and returns every one
    /// found, keyed by identifier.
    fn parse_globals(&mut self) -> Result<HashMap<String, LuaValue>, String> {
        let mut globals = HashMap::new();
        loop {
            self.skip_ws();
            if self.pos >= self.src.len() {
                return Ok(globals);
            }
            let name = self.parse_identifier()?;
            self.expect(b'=')?;
            let value = self.parse_value()?;
            globals.insert(name, value);
        }
    }
}

fn utf8_len(first_byte: u8) -> usize {
    match first_byte {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

pub fn parse_lua_globals(source: &str) -> Result<HashMap<String, LuaValue>, String> {
    LuaParser::new(source).parse_globals()
}

// ---------------------------------------------------------------------------
// asX helpers — ports of luaTable.ts's asObject/asArray/asString/asNumber.
// ---------------------------------------------------------------------------

pub fn as_object(value: &LuaValue) -> &HashMap<String, LuaValue> {
    use std::sync::LazyLock;
    static EMPTY: LazyLock<HashMap<String, LuaValue>> = LazyLock::new(HashMap::new);
    value.as_table().unwrap_or(&EMPTY)
}

pub fn as_array(value: &LuaValue) -> &[LuaValue] {
    use std::sync::LazyLock;
    static EMPTY: LazyLock<Vec<LuaValue>> = LazyLock::new(Vec::new);
    value.as_array().unwrap_or(&EMPTY)
}

pub fn as_string(value: &LuaValue) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

pub fn as_number(value: &LuaValue) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// Serializer — port of luaWriter.ts.
// ---------------------------------------------------------------------------

fn lua_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n")
}

pub fn serialize_lua_value(value: &Value) -> String {
    match value {
        Value::Null => "nil".into(),
        Value::Bool(b) => if *b { "true" } else { "false" }.into(),
        Value::Number(n) => number_to_lua(n),
        Value::String(s) => format!("\"{}\"", lua_escape(s)),
        Value::Array(items) => {
            let inner: Vec<String> = items
                .iter()
                .map(|v| format!("\t{},", serialize_lua_value(v)))
                .collect();
            format!("{{\n{}\n}}", inner.join("\n"))
        }
        Value::Object(map) => {
            let inner: Vec<String> = map
                .iter()
                .map(|(k, v)| format!("\t[\"{}\"] = {},", lua_escape(k), serialize_lua_value(v)))
                .collect();
            format!("{{\n{}\n}}", inner.join("\n"))
        }
    }
}

/// Lua numbers are doubles; keep integers integer-formatted so the file
/// stays human-readable the same way WoW's own writer produces it.
fn number_to_lua(n: &Number) -> String {
    let s = n.to_string();
    if s.contains('.') || s.contains('e') || s.contains('E') {
        s
    } else {
        // Already integer-formatted by serde_json.
        s
    }
}

/// Writes a SavedVariables-shaped string: `GLOBAL_NAME = { ... }\n` — the
/// exact top-level shape WoW's own SavedVariables files use.
pub fn serialize_saved_variables(global_name: &str, data: &Value) -> String {
    format!("{global_name} = {}\n", serialize_lua_value(data))
}
