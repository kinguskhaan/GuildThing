//! The sync engine — port of the core of apps/sync/src/index.ts: read a WoW
//! install's SavedVariables, push roster/characters to the site, pull
//! Discord roles + audit log back down into SyncData.lua, relay in-game
//! sync requests. Runs on a background thread with mtime polling (same
//! approach as the Node script's watch mode — fs watchers are unreliable on
//! network/proton mounts and WoW writes several files on logout).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::api;
use crate::config::{self, SyncState, Target};
use crate::parsers;
use crate::lua::serialize_saved_variables;
use parking_lot::Mutex;
use crate::paths;
/// Watch polls mtimes this often. Cheap stat calls; 5 s feels live in a GUI
/// while still being negligible.
const POLL_INTERVAL_MS: u64 = 5_000;
/// WoW writes several addons' SavedVariables files close together on
/// logout/reload — wait for things to settle before syncing, so a run
/// doesn't fire mid-write or fire twice for one logout.
const DEBOUNCE_MS: u64 = 5_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEvent {
    pub kind: String, // "started" | "info" | "error" | "done" | "watching"
    pub target: Option<String>,
    pub message: String,
    pub ts: u64,
}

pub fn emit_event(app: &AppHandle, kind: &str, target: Option<&str>, message: impl Into<String>) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let event = SyncEvent {
        kind: kind.to_owned(),
        target: target.map(String::from),
        message: message.into(),
        ts,
    };
    let _ = app.emit("sync-event", &event);
}

pub fn resolve_target_wtf_dir(target: &Target) -> Result<String, String> {
    if let Some(wtf_dir) = &target.wtf_dir {
        return Ok(wtf_dir.clone());
    }
    let wow_dir = target
        .wow_dir
        .as_deref()
        .ok_or("target has neither wtfDir nor wowDir")?;
    let version = target
        .version
        .as_deref()
        .ok_or("target with wowDir must also have version")?;
    paths::resolve_wtf_dir(Path::new(wow_dir), version).map(|p| p.to_string_lossy().into_owned())
}

/// All targets sharing one wtfDir, grouped by path string. SavedVariables
/// are only read once per unique wtfDir per sync, then pushed to every
/// target that uses it.
fn group_by_wtf_dir(targets: &[Target]) -> Result<HashMap<String, Vec<Target>>, String> {
    let mut groups: HashMap<String, Vec<Target>> = HashMap::new();
    for target in targets {
        let wtf_dir = resolve_target_wtf_dir(target)?;
        groups.entry(wtf_dir).or_default().push(target.clone());
    }
    Ok(groups)
}

/// Picks the roster a target should push. Guild matching is by name
/// (exact), newest scan wins among duplicates. The legacy fallback (one
/// un-guilded roster) preserves the old single-guild behavior for old
/// addon versions — but a known guild with no matching scan never gets
/// another guild's roster pushed.
fn pick_roster<'a>(
    rosters: &'a [parsers::GuildRoster],
    guild: Option<&api::GuildInfo>,
) -> Result<&'a parsers::GuildRoster, String> {
    let newest = |rosters: Vec<&'a parsers::GuildRoster>| {
        rosters
            .into_iter()
            .max_by(|a, b| a.last_scan.total_cmp(&b.last_scan))
    };
    if let Some(info) = guild {
        if let Some(roster) = newest(
            rosters
                .iter()
                .filter(|r| r.guild.as_deref() == Some(info.name.as_str()))
                .collect(),
        ) {
            return Ok(roster);
        }
    }
    // Guild lookup failed (treated as unknown), or the target's guild has
    // no scan on this install — a legacy roster is the only safe fallback.
    if let Some(roster) = newest(rosters.iter().filter(|r| r.guild.is_none()).collect()) {
        return Ok(roster);
    }
    match guild {
        Some(info) => Err(format!(
            "no roster scan found for guild \"{}\" — log in to that guild in WoW and /reload so the addon can scan it",
            info.name
        )),
        None => Err(
            "couldn't resolve which guild this API key belongs to and no legacy roster was found".to_string(),
        ),
    }
}

async fn sync_target(
    app: &AppHandle,
    target: &Target,
    data: &parsers::RosterData,
) -> Result<(), String> {
    // Which guild this API key belongs to. A failure here (bad key, site
    // down) just means "unknown" — pick_roster's legacy fallback still
    // applies, and the error surfaces on the roster POST instead.
    let guild = api::get_guild(&target.api_url, &target.api_key).await.ok();

    match pick_roster(&data.guild_rosters, guild.as_ref()) {
        Ok(roster) => {
            let pushed = api::post_roster(&target.api_url, &target.api_key, &roster.members).await?;
            match &roster.guild {
                Some(guild_name) => emit_event(
                    app,
                    "info",
                    Some(&target.name),
                    format!("roster: pushed {} members for guild \"{guild_name}\"", pushed.count),
                ),
                None => emit_event(
                    app,
                    "info",
                    Some(&target.name),
                    format!("roster: pushed {} members (legacy roster)", pushed.count),
                ),
            }
        }
        // Roster problem only — characters below are guild-independent and
        // still push.
        Err(err) => emit_event(app, "error", Some(&target.name), format!("roster: skipped — {err}")),
    }

    let chars = api::post_characters(&target.api_url, &target.api_key, &data.characters).await?;
    emit_event(
        app,
        "info",
        Some(&target.name),
        format!(
            "characters: imported {}/{}",
            chars.imported,
            data.characters.len()
        ),
    );
    for err in &chars.errors {
        emit_event(
            app,
            "error",
            Some(&target.name),
            format!("{}-{}: {}", err.name, err.realm, err.message),
        );
    }
    Ok(())
}

/// Pulls current Discord role names AND the unified audit log down for
/// every target sharing this wtfDir, and writes them together into ONE
/// plain addon-code file (SyncData.lua) in the addon's own install folder —
/// deliberately NOT a SavedVariables file. WoW only ever "owns" (loads once,
/// then saves the current in-memory state back over on every reload/logout)
/// files declared under an addon's `## SavedVariables:` — every other file
/// in its `.toc` file list is just re-read fresh from disk on every single
/// addon load. Writing into a file on that list means a write that lands
/// while the client is running is never at risk of being clobbered by the
/// client's own save-on-teardown, and even a plain /reload picks it up.
///
/// Targets sharing a wtfDir merge/concatenate. members (Discord roles) is
/// harmless because DiscordRolesUI.lua's GetCombinedRows joins it against
/// the *current* guild's own roster scan by character name. entries (audit
/// log) has no such join, so each entry carries guildId/guildName from the
/// server precisely so AuditLogUI.lua can filter to the player's current
/// guild.
///
/// Best-effort as a whole: a failure here never affects the roster/
/// character push, which already succeeded independently.
async fn sync_addon_data_file(app: &AppHandle, wtf_dir: &str, targets: &[Target]) {
    let mut members: HashMap<String, api::DiscordRoleMember> = HashMap::new();
    for target in targets {
        match api::get_discord_roles(&target.api_url, &target.api_key).await {
            Ok(result) => members.extend(result.members),
            Err(err) => emit_event(
                app,
                "error",
                Some(&target.name),
                format!("failed to fetch Discord roles: {err}"),
            ),
        }
    }

    let mut entries: Vec<api::AuditEntry> = Vec::new();
    for target in targets {
        match api::get_audit_log(&target.api_url, &target.api_key).await {
            Ok(result) => entries.extend(result.entries),
            Err(err) => emit_event(
                app,
                "error",
                Some(&target.name),
                format!("failed to fetch audit log: {err}"),
            ),
        }
    }
    entries.sort_by(|a, b| b.detected_at.total_cmp(&a.detected_at));

    let members_json: serde_json::Map<String, serde_json::Value> = members
        .iter()
        .map(|(name, member)| {
            (
                name.clone(),
                serde_json::json!({
                    "nick": member.nick,
                    "tag": member.tag,
                    "roleNames": member.role_names,
                }),
            )
        })
        .collect();
    let entries_json: Vec<serde_json::Value> = entries
        .iter()
        .map(|e| {
            serde_json::json!({
                "characterName": e.character_name,
                "detail": e.detail,
                "detectedAt": e.detected_at,
                "discordNick": e.discord_nick,
                "discordTag": e.discord_tag,
                "guildId": e.guild_id,
                "guildName": e.guild_name,
            })
        })
        .collect();

    let payload = serde_json::json!({ "members": members_json });
    let audit = serde_json::json!({ "entries": entries_json });

    let result = paths::resolve_addon_install_dir(Path::new(wtf_dir)).and_then(|addon_dir| {
        let write_path = addon_dir.join("SyncData.lua");
        let content = serialize_saved_variables("GuildThingDiscordRolesDB", &payload)
            + &serialize_saved_variables("GuildThingAuditLogDB", &audit);
        std::fs::write(&write_path, content)
            .map_err(|e| format!("kunde skriva {}: {e}", write_path.display()))?;
        Ok(write_path)
    });

    match result {
        Ok(write_path) => emit_event(
            app,
            "info",
            None,
            format!(
                "wrote Discord roles for {} members and {} audit entries to {}",
                members.len(),
                entries.len(),
                write_path.display()
            ),
        ),
        Err(err) => emit_event(
            app,
            "error",
            None,
            format!("failed to write SyncData.lua for {wtf_dir}: {err}"),
        ),
    }
}

/// Relays an in-game "Request sync" click to each target this install
/// serves — NOT live: the flag only reaches this app once the player has
/// logged out or /reload'd (SavedVariables only flush to disk then), and
/// from there it's bounded by this app's own poll cadence.
async fn relay_sync_request(
    app: &AppHandle,
    state_path: &Path,
    state: &mut SyncState,
    targets: &[Target],
    sync_requested_at: Option<f64>,
) {
    let Some(requested_at) = sync_requested_at else {
        return;
    };
    for target in targets {
        let acted = state
            .last_sync_requested_at
            .get(&target.name)
            .is_some_and(|&last| last >= requested_at);
        if acted {
            continue;
        }
        match api::request_sync(&target.api_url, &target.api_key).await {
            Ok(_) => {
                state
                    .last_sync_requested_at
                    .insert(target.name.clone(), requested_at);
                if let Err(err) = config::save_state(state_path, state) {
                    emit_event(
                        app,
                        "error",
                        Some(&target.name),
                        format!("failed to save sync state: {err}"),
                    );
                }
                emit_event(app, "info", Some(&target.name), "relayed in-game sync request");
            }
            Err(err) => emit_event(
                app,
                "error",
                Some(&target.name),
                format!("failed to relay sync request: {err}"),
            ),
        }
    }
}

/// Targets sharing a wtfDir get one read of that install's SavedVariables,
/// fanned out to each target's own API key.
async fn sync_group(
    app: &AppHandle,
    wtf_dir: &str,
    targets: &[Target],
    state_path: &Path,
    state: &mut SyncState,
) {
    emit_event(app, "started", None, format!("reading {wtf_dir}"));

    let data = match parsers::read_wtf_dir(Path::new(wtf_dir)) {
        Ok(data) => data,
        Err(err) => {
            emit_event(app, "error", None, format!("failed to read {wtf_dir}: {err}"));
            return;
        }
    };

    for target in targets {
        if let Err(err) = sync_target(app, target, &data).await {
            emit_event(
                app,
                "error",
                Some(&target.name),
                format!("sync failed: {err}"),
            );
        }
    }

    sync_addon_data_file(app, wtf_dir, targets).await;
    relay_sync_request(app, state_path, state, targets, data.sync_requested_at).await;
}

pub async fn sync_all(app: &AppHandle, targets: &[Target], state_path: &Path) {
    let state_path_buf = state_path.to_path_buf();
    let mut state = config::load_state(&state_path_buf);
    let groups = match group_by_wtf_dir(targets) {
        Ok(groups) => groups,
        Err(err) => {
            emit_event(app, "error", None, err);
            return;
        }
    };
    for (wtf_dir, group) in groups {
        sync_group(app, &wtf_dir, &group, &state_path_buf, &mut state).await;
    }
    emit_event(app, "done", None, "sync complete");
}

/// Watch-mode thread: polls SavedVariables mtimes, debounces, runs
/// sync_all on change. One thread for ALL targets (the Node script polled
/// per-wtfDir; the work inside is identical and sequential there too).
pub struct Watcher {
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Watcher {
    pub fn start(
        app: AppHandle,
        targets: Vec<Target>,
        state_path: PathBuf,
    ) -> Result<Arc<Watcher>, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop);

        let groups: Vec<(String, Vec<Target>)> = group_by_wtf_dir(&targets)?
            .into_iter()
            .collect();

        let thread = std::thread::Builder::new()
            .name("sync-watcher".into())
            .spawn(move || watch_loop(app, groups, state_path, stop_clone))
            .map_err(|e| format!("failed to start watcher thread: {e}"))?;

        Ok(Arc::new(Watcher {
            stop,
            thread: Mutex::new(Some(thread)),
        }))
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.thread.lock().take() {
            let _ = handle.join();
        }
    }

    pub fn is_running(&self) -> bool {
        !self.stop.load(Ordering::SeqCst)
    }
}

fn watch_loop(app: AppHandle, groups: Vec<(String, Vec<Target>)>, state_path: PathBuf, stop: Arc<AtomicBool>) {

    let mut last_mtimes: HashMap<String, (u64, u64)> = HashMap::new();
    let mut pending_at: Option<std::time::Instant> = None;

    let mtimes = |group_key: &str| -> Option<(u64, u64)> {
        let wtf_dir = Path::new(group_key);
        // Every account folder's copy is read on a sync, so any one of
        // them changing counts as a change — not just the first found.
        let roster_mtime = paths::list_saved_variables_files(wtf_dir, "GuildThing.lua")
            .iter()
            .filter_map(|f| mtime_millis(f))
            .max()?;
        let recipes_mtime = paths::list_saved_variables_files(wtf_dir, "OurRecipes.lua")
            .iter()
            .filter_map(|f| mtime_millis(f))
            .max()
            .unwrap_or(0);
        Some((roster_mtime, recipes_mtime))
    };

    // Seed baselines without syncing on startup — the first sync should be
    // triggered by an actual change (or the explicit "Sync now" button).
    for (group_key, _) in &groups {
        if let Some(times) = mtimes(group_key) {
            last_mtimes.insert(group_key.clone(), times);
        }
    }

    emit_event(&app, "watching", None, "watching your WoW folder");
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));

        for (group_key, _group_targets) in &groups {
            let Some(times) = mtimes(group_key) else {
                continue;
            };
            let last = last_mtimes.get(group_key);
            if last == Some(&times) {
                continue;
            }
            last_mtimes.insert(group_key.clone(), times);
            pending_at = Some(std::time::Instant::now() + Duration::from_millis(DEBOUNCE_MS));
        }

        if let Some(deadline) = pending_at {
            if std::time::Instant::now() >= deadline {
                pending_at = None;
                let state_path = state_path.clone();
                let mut state = config::load_state(&state_path);
                for (group_key, group_targets) in &groups {
                    // Re-check stop between groups — closing the window
                    // should not keep syncing.
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    tauri::async_runtime::block_on(sync_group(
                        &app,
                        group_key,
                        group_targets,
                        &state_path,
                        &mut state,
                    ));
                }
                emit_event(&app, "done", None, "sync complete");
            }
        }
    }
}

fn mtime_millis(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// Managed app state: the current watch-mode thread, if running. An
/// Option behind a lock (instead of managing a fresh Watcher per start)
/// so stop→start cycles replace the watcher instead of piling up.
pub struct WatcherHandle(pub Mutex<Option<Arc<Watcher>>>);

impl WatcherHandle {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }
}