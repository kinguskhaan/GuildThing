//! SavedVariables readers for the two addons this app syncs — ports of
//! parseRoster.ts / parseRecipes.ts. Field shapes match
//! rosterExportSchema.members and wowImportSchema on the web side (see
//! apps/web/src/server/wow-import.ts) field-for-field.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use crate::lua::{as_array, as_number, as_object, as_string, parse_lua_globals, LuaValue};
use crate::paths;

#[derive(Debug, Clone, Serialize)]
pub struct RosterMember {
    pub name: String,
    pub rank: String,
    pub level: f64,
    pub class: Option<String>,
    pub note: Option<String>,
    pub officernote: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecipeEntry {
    pub name: String,
    pub item_id: Option<f64>,
    pub spell_id: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedCharacter {
    pub name: String,
    pub realm: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    pub professions: BTreeMap<String, Vec<RecipeEntry>>,
}

/// Result of reading one WoW install's SavedVariables.
pub struct RosterData {
    /// One entry per guild found across every account's GuildThing.lua,
    /// plus a legacy `guild: None` entry when an old addon version stored
    /// a single flat roster. Targets match on their own guild name.
    pub guild_rosters: Vec<GuildRoster>,
    pub characters: Vec<ImportedCharacter>,
    /// Set by the addon's "Request sync" button (DiscordRolesUI.lua).
    /// None means no request pending (the common case).
    pub sync_requested_at: Option<f64>,
}

/// One guild's roster scan out of GuildThingRosterDB. `guild` is None for
/// the legacy flat fields (rosterByGuild's predecessor), which carried no
/// guild name — the addon only ever scanned the player's current guild.
#[derive(Debug, Clone, Serialize)]
pub struct GuildRoster {
    pub guild: Option<String>,
    pub last_scan: f64,
    pub members: Vec<RosterMember>,
}

/// GuildThing.lua's `GuildThingRosterDB`. Newer addon versions key rosters
/// per guild — `rosterByGuild = { ["Guild Name"] = { lastScan = ...,
/// roster = {...} } }` — while old ones stored one flat roster
/// (`lastScan = ..., roster = {...}`, the player's current guild, name
/// unknown). See apps/addon/GuildThing/Core.lua's GT.ExportRoster.
pub fn read_guild_rosters(path: &Path) -> Result<Vec<GuildRoster>, String> {
    let src = std::fs::read_to_string(path)
        .map_err(|e| format!("couldn't read {}: {e}", path.display()))?;
    let globals = parse_lua_globals(&src)?;
    let db = as_object(globals.get("GuildThingRosterDB").unwrap_or(&LuaValue::Nil));

    let mut rosters = Vec::new();
    if let Some(by_guild) = db
        .get("rosterByGuild")
        .map(as_object)
        .filter(|m| !m.is_empty())
    {
        for (guild_name, entry) in by_guild {
            let entry = as_object(entry);
            rosters.push(GuildRoster {
                guild: Some(guild_name.clone()),
                last_scan: as_number(entry.get("lastScan").unwrap_or(&LuaValue::Nil)),
                members: parse_roster_members(as_array(
                    entry.get("roster").unwrap_or(&LuaValue::Nil),
                )),
            });
        }
        return Ok(rosters);
    }

    // Legacy flat fields — one un-guilded roster, possibly absent entirely
    // on an account that never scanned. Callers fall back to this (old
    // single-guild behavior) whenever no per-guild data exists.
    rosters.push(GuildRoster {
        guild: None,
        last_scan: db.get("lastScan").and_then(LuaValue::as_f64).unwrap_or(0.0),
        members: db
            .get("roster")
            .map(|roster| parse_roster_members(as_array(roster)))
            .unwrap_or_default(),
    });
    Ok(rosters)
}

fn parse_roster_members(roster: &[LuaValue]) -> Vec<RosterMember> {
    roster
        .iter()
        .map(|entry| {
            let m = as_object(entry);
            RosterMember {
                name: as_string(m.get("name").unwrap_or(&LuaValue::Nil)),
                rank: as_string(m.get("rank").unwrap_or(&LuaValue::Nil)),
                level: as_number(m.get("level").unwrap_or(&LuaValue::Nil)),
                class: m.get("class").and_then(LuaValue::as_str).map(String::from),
                note: m.get("note").and_then(LuaValue::as_str).map(String::from),
                officernote: m
                    .get("officernote")
                    .and_then(LuaValue::as_str)
                    .map(String::from),
            }
        })
        .collect()
}

/// Every account's OurRecipes.lua, unioned — characters are account-wide
/// (no guild identity), so every account on the install contributes.
pub fn read_recipes(wtf_dir: &Path) -> Result<Vec<ImportedCharacter>, String> {
    let mut characters = Vec::new();
    for path in paths::list_saved_variables_files(wtf_dir, "OurRecipes.lua") {
        characters.append(&mut read_recipes_file(&path)?);
    }
    Ok(characters)
}
/// OurRecipes.lua: `GuildThingDB = { p2pSettings = {...}, ..., ["Name-Realm"]
/// = { name = "Name", class = "WARRIOR", professions = {...} }, ... }` —
/// every character on the account is a top-level key shaped
/// "<Name>-<Realm>", sitting alongside a handful of fixed bookkeeping keys.
/// Rather than hardcode that exact list of non-character keys (fragile if
/// the addon adds more), this keeps whichever top-level entries have a
/// `professions` field — every real character entry has one, none of the
/// bookkeeping ones do. Optional file: a miss just means no recipe data.

fn read_recipes_file(path: &Path) -> Result<Vec<ImportedCharacter>, String> {
    let src = std::fs::read_to_string(path)
        .map_err(|e| format!("couldn't read {}: {e}", path.display()))?;
    let globals = parse_lua_globals(&src)?;
    let db = as_object(globals.get("GuildThingDB").unwrap_or(&LuaValue::Nil));

    let mut characters = Vec::new();
    for (key, value) in db {
        let Some(fields) = value.as_table() else {
            continue;
        };
        let Some(professions_raw) = fields.get("professions") else {
            continue; // bookkeeping key, not a character
        };

        // Character names never contain a hyphen; realm names sometimes do
        // (e.g. "Area-52") — so split on the FIRST hyphen, not the last.
        let Some(dash) = key.find('-') else {
            continue;
        };
        let name = &key[..dash];
        let realm = &key[dash + 1..];

        let mut professions: BTreeMap<String, Vec<RecipeEntry>> = BTreeMap::new();
        for (profession_name, recipes_raw) in as_object(professions_raw) {
            let recipes = as_array(recipes_raw)
                .iter()
                .map(|r| {
                    let recipe = as_object(r);
                    RecipeEntry {
                        name: as_string(recipe.get("name").unwrap_or(&LuaValue::Nil)),
                        item_id: recipe.get("itemID").and_then(LuaValue::as_f64),
                        spell_id: recipe.get("spellID").and_then(LuaValue::as_f64),
                    }
                })
                .collect();
            professions.insert(profession_name.clone(), recipes);
        }

        characters.push(ImportedCharacter {
            name: name.to_owned(),
            realm: realm.to_owned(),
            class: fields.get("class").and_then(LuaValue::as_str).map(String::from),
            professions,
        });
    }
    Ok(characters)
}

/// One read of a WoW install's SavedVariables, fanned out to every target
/// sharing it (ports readWtfDir in index.ts) — now across ALL accounts:
/// each account folder's GuildThing.lua contributes its guild rosters,
/// characters are unioned, syncRequestedAt is the max seen.
pub fn read_wtf_dir(wtf_dir: &Path) -> Result<RosterData, String> {
    // GuildThing.lua is required — a miss anywhere is a failed read (same
    // error the single-account version produced), but every account's copy
    // contributes its own rosters and syncRequestedAt.
    let roster_files = paths::list_saved_variables_files(wtf_dir, "GuildThing.lua");
    if roster_files.is_empty() {
        // Same friendly error the single-account version gave when the
        // addon isn't installed (or the WTF folder is wrong).
        paths::find_saved_variables_file(wtf_dir, "GuildThing.lua")?;
    }
    let mut guild_rosters = Vec::new();
    let mut sync_requested_at: Option<f64> = None;
    for path in roster_files {
        guild_rosters.append(&mut read_guild_rosters(&path)?);
        let requested_at = read_sync_requested_at_from(&path);
        if requested_at.is_some_and(|t| sync_requested_at.is_none_or(|last| t > last)) {
            sync_requested_at = requested_at;
        }
    }

    let characters = read_recipes(wtf_dir).unwrap_or_else(|e| {
        eprintln!("[sync] recipes read failed (ignored): {e}");
        Vec::new()
    });
    Ok(RosterData {
        guild_rosters,
        characters,
        sync_requested_at,
    })
}

/// GuildThingRosterDB.syncRequestedAt — epoch-seconds time() set by the
/// addon's "Request sync" button. A missing field is the normal
/// no-request-pending case, not an error.
fn read_sync_requested_at_from(path: &Path) -> Option<f64> {
    let src = std::fs::read_to_string(path).ok()?;
    let globals = parse_lua_globals(&src).ok()?;
    let db = as_object(globals.get("GuildThingRosterDB").unwrap_or(&LuaValue::Nil));
    db.get("syncRequestedAt").and_then(LuaValue::as_f64)
}