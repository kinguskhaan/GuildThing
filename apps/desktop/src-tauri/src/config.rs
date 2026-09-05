//! App config, persisted in the OS app-config dir (not next to the exe —
//! installed apps can't write next to their binary on Windows).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub name: String,
    pub api_url: String,
    pub api_key: String,
    /// Either wowDir + version (what most people use) or wtfDir directly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wow_dir: Option<String>,
    /// retail | classic | classic_era | anniversary
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wtf_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub targets: Vec<Target>,
}

/// Remembers the last GuildThingRosterDB.syncRequestedAt value each target
/// has already acted on — a FILE, not just an in-memory map: a fresh app
/// launch must not re-relay a request it already handled before restarting.
/// Port of syncState.ts.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    pub last_sync_requested_at: std::collections::HashMap<String, f64>,
}

pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("config.json"))
        .map_err(|e| format!("couldn't determine config folder: {e}"))
}

pub fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("sync.state.json"))
        .map_err(|e| format!("couldn't determine config folder: {e}"))
}

pub fn load<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path).map_err(|e| format!("couldn't read {}: {e}", path.display()))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| format!("invalid content in {}: {e}", path.display()))
}

pub fn save<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| format!("couldn't write {}: {e}", path.display()))
}

pub fn load_state(path: &Path) -> SyncState {
    load::<SyncState>(path).ok().flatten().unwrap_or_default()
}

pub fn save_state(path: &Path, state: &SyncState) -> Result<(), String> {
    save(path, state)
}