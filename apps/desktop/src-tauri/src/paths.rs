//! WTF-folder and SavedVariables path resolution — port of
//! apps/sync/src/paths.ts.

use std::path::{Path, PathBuf};

pub const VERSION_FOLDERS: &[(&str, &str)] = &[
    ("retail", "_retail_"),
    ("classic", "_classic_"),
    ("classic_era", "_classic_era_"),
    ("anniversary", "_anniversary_"),
];

pub fn version_folder(version: &str) -> Option<&'static str> {
    VERSION_FOLDERS
        .iter()
        .find(|(name, _)| *name == version)
        .map(|(_, folder)| *folder)
}

/// Lets a sync target say wowDir + version instead of spelling out the full
/// .../_classic_era_/WTF path by hand.
pub fn resolve_wtf_dir(wow_dir: &Path, version: &str) -> Result<PathBuf, String> {
    let folder = version_folder(version).ok_or_else(|| {
        format!(
            "Unknown WoW version \"{version}\" — expected one of: {}.",
            VERSION_FOLDERS
                .iter()
                .map(|(n, _)| *n)
                .collect::<Vec<_>>()
                .join(", ")
        )
    })?;
    Ok(wow_dir.join(folder).join("WTF"))
}

/// The WTF folder's default location on Windows. Steam Proton installs on
/// Linux can't be guessed (per-title compatdata id) — the user picks it in
/// the wizard there.
pub fn default_wow_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        Some(PathBuf::from(
            r"C:\Program Files (x86)\World of Warcraft",
        ))
    } else {
        None
    }
}

/// Both addons write account-wide (not per-character) SavedVariables, under
/// WTF/Account/<ACCOUNT>/SavedVariables/<addon-file>.lua — the account
/// folder name isn't knowable in advance, so this checks every account
/// under WTF/Account. Multiple WoW accounts on one install each hold their
/// own copy, so callers reading roster data want ALL of them, sorted for
/// deterministic ordering.
pub fn list_saved_variables_files(wtf_dir: &Path, filename: &str) -> Vec<PathBuf> {
    let accounts_dir = wtf_dir.join("Account");
    let Ok(entries) = std::fs::read_dir(&accounts_dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path().join("SavedVariables").join(filename))
        .filter(|candidate| candidate.exists())
        .collect();
    files.sort();
    files
}

/// First hit of list_saved_variables_files — the single-account behavior
/// the Node script had before it learned about multiple WoW accounts.
pub fn find_saved_variables_file_optional(wtf_dir: &Path, filename: &str) -> Option<PathBuf> {
    list_saved_variables_files(wtf_dir, filename).into_iter().next()
}

/// Only GuildThing.lua (the roster/`/gtr` addon) is required — OurRecipes is
/// optional, so callers wanting it use find_saved_variables_file_optional()
/// and treat a miss as "no recipe data" rather than an error.
pub fn find_saved_variables_file(wtf_dir: &Path, filename: &str) -> Result<PathBuf, String> {
    if let Some(found) = find_saved_variables_file_optional(wtf_dir, filename) {
        return Ok(found);
    }
    let accounts_dir = wtf_dir.join("Account");
    if !accounts_dir.exists() {
        return Err(format!(
            "No Account folder found under {} — check that the folder you picked is your WTF folder.",
            wtf_dir.display()
        ));
    }
    Err(format!(
        "Couldn't find {filename} under {}/*/SavedVariables — make sure the addon is installed and you've logged in at least once since installing it.",
        accounts_dir.display()
    ))
}

/// The GuildThing addon's own install folder — Interface/AddOns/GuildThing,
/// a sibling of WTF under the same version folder (.../_classic_era_/WTF
/// and .../_classic_era_/Interface/AddOns/GuildThing). Unlike SavedVariables
/// (per-account, under WTF/Account/<ACCOUNT>/...), an addon's own files are
/// ONE copy shared by every account on this install. Used for writing
/// plain addon-code files (SyncData.lua) rather than SavedVariables globals,
/// so they're re-read fresh from disk on every addon load instead of being
/// subject to WoW's save-current-state-first-then-reload behavior.
pub fn resolve_addon_install_dir(wtf_dir: &Path) -> Result<PathBuf, String> {
    let dir = wtf_dir
        .parent()
        .ok_or("WTF folder has no parent — bad path")?
        .join("Interface")
        .join("AddOns")
        .join("GuildThing");
    if !dir.exists() {
        return Err(format!(
            "Couldn't find the GuildThing addon's install folder at {} — make sure the addon is installed there (this is derived from your WTF folder's location).",
            dir.display()
        ));
    }
    Ok(dir)
}

/// Which of the known version folders exist directly under a WoW root —
/// used by the wizard to auto-pick a version after the user chooses the
/// game folder.
pub fn detected_versions(wow_dir: &Path) -> Vec<String> {
    VERSION_FOLDERS
        .iter()
        .filter(|(_, folder)| wow_dir.join(folder).is_dir())
        .map(|(name, _)| name.to_string())
        .collect()
}