//! GuildThing Sync — Tauri command surface. Thin wrapper: all sync logic
//! lives in the `engine` module, all site I/O in `api`, all file-format
//! knowledge in `lua`/`parsers`, all path resolution in `paths`.

mod api;
mod config;
mod engine;
mod lua;
mod parsers;
mod paths;

use std::path::Path;

use serde::Serialize;
use tauri::Manager;

use config::{Config, Target};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    wtf_dir: String,
    addon_dir: Option<String>,
    accounts: Vec<String>,
    roster_found: bool,
    recipes_found: bool,
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Result<Option<Config>, String> {
    config::load(&config::config_path(&app)?)
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, config: Config) -> Result<(), String> {
    if config.targets.is_empty() {
        return Err("At least one guild target is required.".into());
    }
    for target in &config.targets {
        engine::resolve_target_wtf_dir(target)?;
    }
    config::save(&config::config_path(&app)?, &config)
}

/// Validates a candidate target and reports what the app can see in the
/// chosen WoW folder — used live by the wizard as the user picks paths.
#[tauri::command]
fn detect_install(target: Target) -> Result<Detection, String> {
    let wtf_dir = engine::resolve_target_wtf_dir(&target)?;
    let wtf = Path::new(&wtf_dir);

    let mut accounts = Vec::new();
    if let Ok(entries) = std::fs::read_dir(wtf.join("Account")) {
        for entry in entries.filter_map(Result::ok) {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                accounts.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }
    accounts.sort();

    let addon_dir = paths::resolve_addon_install_dir(wtf)
        .map(|p| p.to_string_lossy().into_owned())
        .ok();
    let roster_found = paths::find_saved_variables_file_optional(wtf, "GuildThing.lua").is_some();
    let recipes_found =
        paths::find_saved_variables_file_optional(wtf, "OurRecipes.lua").is_some();

    Ok(Detection {
        wtf_dir,
        addon_dir,
        accounts,
        roster_found,
        recipes_found,
    })
}

/// Which known version folders exist under a WoW root — the wizard
/// auto-picks if there's exactly one. Empty wow_dir reports the platform
/// default instead, for prefilling the wizard's folder field.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDetection {
    default_wow_dir: Option<String>,
    versions: Vec<String>,
}

#[tauri::command]
fn detect_versions(wow_dir: Option<String>) -> VersionDetection {
    let dir = wow_dir
        .filter(|s| !s.trim().is_empty())
        .or_else(|| paths::default_wow_dir().map(|p| p.to_string_lossy().into_owned()));
    match dir {
        Some(dir) => VersionDetection {
            default_wow_dir: Some(dir.clone()),
            versions: paths::detected_versions(Path::new(&dir)),
        },
        None => VersionDetection {
            default_wow_dir: None,
            versions: Vec::new(),
        },
    }
}

/// Cheap API-key validation for the wizard — the roster POST would push
/// data, so this uses the roles GET (any authorized endpoint works).
#[tauri::command]
async fn test_connection(api_url: String, api_key: String) -> Result<String, String> {
    let roles = api::get_discord_roles(&api_url, &api_key).await?;
    Ok(format!("OK — {} members with a linked Discord account", roles.members.len()))
}

/// Is watch mode currently running? The dashboard polls this on startup
/// (event stream only starts after the page loads, so state must be
/// queryable, not just pushable).
#[tauri::command]
fn watch_status(app: tauri::AppHandle) -> bool {
    app.state::<engine::WatcherHandle>()
        .0
        .lock()
        .as_ref()
        .is_some_and(|w| w.is_running())
}

#[tauri::command]
async fn sync_now(app: tauri::AppHandle) -> Result<(), String> {
    let config: Config =
        config::load(&config::config_path(&app)?)?.ok_or("no configuration saved")?;
    let state_path = config::state_path(&app)?;
    engine::sync_all(&app, &config.targets, &state_path).await;
    Ok(())
}

#[tauri::command]
fn start_watch(app: tauri::AppHandle) -> Result<(), String> {
    let config: Config =
        config::load(&config::config_path(&app)?)?.ok_or("no configuration saved")?;
    let state_path = config::state_path(&app)?;
    let watcher = engine::Watcher::start(app.clone(), config.targets, state_path)?;
    let handle = app.state::<engine::WatcherHandle>();
    *handle.0.lock() = Some(watcher);
    Ok(())
}

#[tauri::command]
fn stop_watch(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.state::<engine::WatcherHandle>();
    if let Some(watcher) = handle.0.lock().take() {
        watcher.stop();
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(engine::WatcherHandle::new())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            detect_install,
            watch_status,
            detect_versions,
            test_connection,
            sync_now,
            start_watch,
            stop_watch,
        ])
        .run(tauri::generate_context!())
        .expect("fel vid start av GuildThing Sync");
}