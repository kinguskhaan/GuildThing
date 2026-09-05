//! HTTP client for the GuildThing site API — port of apps/sync/src/api.ts.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::parsers::{ImportedCharacter, RosterMember};

/// Which guild an API key belongs to (the site resolves the key → guild).
#[derive(Debug, Deserialize)]
#[allow(dead_code)] // contract mirror — only `name` is needed for matching
pub struct GuildInfo {
    pub id: String,
    pub name: String,
    pub slug: String,
}

#[derive(Debug, Serialize)]
pub struct PostRosterBody<'a> {
    pub members: &'a [RosterMember],
}

#[derive(Debug, Deserialize)]
pub struct PostRosterResponse {
    pub count: u64,
}

#[derive(Debug, Deserialize)]
pub struct CharError {
    pub name: String,
    pub realm: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct PostCharactersResponse {
    pub imported: u64,
    pub errors: Vec<CharError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscordRoleMember {
    pub nick: Option<String>,
    pub tag: Option<String>,
    #[serde(rename = "roleNames")]
    pub role_names: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct DiscordRolesResponse {
    pub members: BTreeMap<String, DiscordRoleMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    #[serde(rename = "characterName")]
    pub character_name: String,
    pub detail: String,
    #[serde(rename = "detectedAt")]
    pub detected_at: f64,
    #[serde(rename = "discordNick")]
    pub discord_nick: Option<String>,
    #[serde(rename = "discordTag")]
    pub discord_tag: Option<String>,
    #[serde(rename = "guildId")]
    pub guild_id: String,
    #[serde(rename = "guildName")]
    pub guild_name: String,
}

#[derive(Debug, Deserialize)]
pub struct AuditLogResponse {
    pub entries: Vec<AuditEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleMismatchMember {
    #[serde(rename = "toAdd")]
    pub to_add: Vec<String>,
    #[serde(rename = "toRemove")]
    pub to_remove: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct RoleMismatchesResponse {
    pub members: BTreeMap<String, RoleMismatchMember>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // contract mirror — the site sends { ok: true }
pub struct RequestSyncResponse {
    pub ok: bool,
}

fn base_url(api_url: &str) -> Result<url::Url, String> {
    url::Url::parse(api_url)
        .map_err(|e| format!("Invalid site URL \"{api_url}\": {e}"))
}

async fn post<T: serde::de::DeserializeOwned>(
    api_url: &str,
    api_key: &str,
    path: &str,
    body: &impl serde::ser::Serialize,
) -> Result<T, String> {
    let url = base_url(api_url)?.join(path).map_err(|e| e.to_string())?;
    let res = reqwest::Client::new()
        .post(url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("{path} failed: {e}"))?;
    handle::<T>(path, res).await
}

async fn get<T: serde::de::DeserializeOwned>(
    api_url: &str,
    api_key: &str,
    path: &str,
) -> Result<T, String> {
    let url = base_url(api_url)?.join(path).map_err(|e| e.to_string())?;
    let res = reqwest::Client::new()
        .get(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .await
        .map_err(|e| format!("{path} failed: {e}"))?;
    handle::<T>(path, res).await
}

async fn handle<T: serde::de::DeserializeOwned>(
    path: &str,
    res: reqwest::Response,
) -> Result<T, String> {
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("{path} failed: {status} {text}"));
    }
    res.json::<T>()
        .await
        .map_err(|e| format!("{path} failed: bad response body: {e}"))
}

pub async fn post_roster(
    api_url: &str,
    api_key: &str,
    members: &[RosterMember],
) -> Result<PostRosterResponse, String> {
    post(api_url, api_key, "/api/v1/roster", &PostRosterBody { members }).await
}

pub async fn post_characters(
    api_url: &str,
    api_key: &str,
    characters: &[ImportedCharacter],
) -> Result<PostCharactersResponse, String> {
    post(api_url, api_key, "/api/v1/characters", &serde_json::json!({ "characters": characters })).await
}

/// Discord nick/account tag/role names per roster member (keyed by
/// character name — the only identifier the addon itself has), for writing
/// into SyncData.lua. See discord-roles/route.ts.
pub async fn get_discord_roles(
    api_url: &str,
    api_key: &str,
) -> Result<DiscordRolesResponse, String> {
    get(api_url, api_key, "/api/v1/discord-roles").await
}

/// Unified rank-change + manual-Discord-role-change history. Entries carry
/// guildId/guildName so several guilds' entries merged into one SyncData.lua
/// stay distinguishable — the addon filters rows to the player's current
/// guild. See audit-log/route.ts.
pub async fn get_audit_log(api_url: &str, api_key: &str) -> Result<AuditLogResponse, String> {
    get(api_url, api_key, "/api/v1/audit-log").await
}

/// Rule-managed Discord roles the bot's periodic diff pass has flagged as
/// out of sync, keyed by roster member name (only identifier the addon
/// has) — for writing into SyncData.lua so the addon's Discord Roles tab
/// can flag drift. See role-mismatches/route.ts.
pub async fn get_role_mismatches(
    api_url: &str,
    api_key: &str,
) -> Result<RoleMismatchesResponse, String> {
    get(api_url, api_key, "/api/v1/role-mismatches").await
}

/// API-key-authenticated equivalent of the website's "Sync now" button —
/// lets an in-game "Request sync" click (relayed through this app) nudge
/// the bot's role resync sooner than the daily cron. See request-sync/route.ts.
pub async fn request_sync(api_url: &str, api_key: &str) -> Result<RequestSyncResponse, String> {
    post(api_url, api_key, "/api/v1/request-sync", &serde_json::json!({})).await
}

/// The guild this API key points at — used to pick the matching roster out
/// of the (possibly multi-guild) SavedVariables before pushing. See
/// guild/route.ts.
pub async fn get_guild(api_url: &str, api_key: &str) -> Result<GuildInfo, String> {
    get(api_url, api_key, "/api/v1/guild").await
}