GuildThingRosterDB = GuildThingRosterDB or {}

GuildThingRoster = GuildThingRoster or {}
local GT = GuildThingRoster

-- Blizzard moved these from bare globals into the C_GuildInfo namespace at
-- some point — fall back to the old globals if C_GuildInfo isn't there, so
-- this keeps working on both older and newer clients either way.
local GuildRoster = (C_GuildInfo and C_GuildInfo.GuildRoster) or GuildRoster
local GetNumGuildMembers =
    (C_GuildInfo and C_GuildInfo.GetNumGuildMembers) or GetNumGuildMembers
local GetGuildRosterInfo =
    (C_GuildInfo and C_GuildInfo.GetGuildRosterInfo) or GetGuildRosterInfo

local function JSONEscape(s)
    s = (s or ""):gsub("\\", "\\\\")
    s = s:gsub("\"", "\\\"")
    s = s:gsub("\n", "\\n")
    return s
end

-- GetGuildRosterInfo's name can come back as "Name-Realm" for members on a
-- connected realm — strip that, guild members are always the player's own
-- realm so the suffix is redundant and just noise in the export.
local function StripRealm(name)
    return (name or ""):match("^([^-]+)") or name
end

-- One SavedVariables file is shared by every character on the account, and
-- each character only sees their OWN guild's roster — so the scan is stored
-- per guild name (rosterByGuild) instead of overwriting one slot. That's
-- what lets the desktop sync app push each guild's site the correct roster
-- even when characters from several guilds (on this account or other
-- accounts in the same install) take turns logging in. The legacy flat
-- `roster`/`lastScan` fields are still written for the /gtr export and the
-- UI tabs, and GetRoster() prefers the current character's guild entry.
function GT.ScanRoster()
    local roster = {}
    for i = 1, GetNumGuildMembers() do
        -- classFileName (11th return) is the locale-independent token (e.g.
        -- "WARRIOR"), unlike the 5th return which is the display name in
        -- the player's own game locale — token is what's worth exporting.
        -- officernote comes back as "" if we don't have officer permission
        -- to see it, not nil — nothing more to extract there either way.
        local name, rank, _, level, _, _, note, officernote, _, _, classFileName =
            GetGuildRosterInfo(i)
        if name then
            table.insert(roster, {
                name = StripRealm(name),
                rank = rank,
                level = level,
                class = classFileName,
                note = note,
                officernote = officernote,
            })
        end
    end
    local guildName = GetGuildInfo("player")
    if guildName then
        GuildThingRosterDB.rosterByGuild = GuildThingRosterDB.rosterByGuild or {}
        GuildThingRosterDB.rosterByGuild[guildName] = { lastScan = time(), roster = roster }
    end
    GuildThingRosterDB.roster = roster
    GuildThingRosterDB.lastScan = time()
    return roster
end

function GT.GetRoster()
    -- The character's own guild's scan when we have one; the legacy flat
    -- field otherwise (older DBs, or scans made before picking a guild).
    local guildName = GetGuildInfo("player")
    local byGuild = guildName and GuildThingRosterDB.rosterByGuild
    if byGuild and byGuild[guildName] then
        return byGuild[guildName].roster or {}
    end
    return GuildThingRosterDB.roster or {}
end

function GT.GetLastScanText()
    local guildName = GetGuildInfo("player")
    local byGuild = guildName and GuildThingRosterDB.rosterByGuild
    local lastScan = (byGuild and byGuild[guildName] and byGuild[guildName].lastScan)
        or GuildThingRosterDB.lastScan
    if not lastScan then return nil end
    return date("%Y-%m-%d %H:%M", lastScan)
end

function GT.ExportRoster()
    local parts = {}
    for _, m in ipairs(GT.GetRoster()) do
        table.insert(parts, string.format(
            '{"name":"%s","rank":"%s","level":%s,"class":"%s","note":"%s","officernote":"%s"}',
            JSONEscape(m.name),
            JSONEscape(m.rank),
            m.level and tostring(m.level) or "null",
            JSONEscape(m.class),
            JSONEscape(m.note),
            JSONEscape(m.officernote)
        ))
    end
    local guildName = GetGuildInfo("player") or ""
    return string.format(
        '{"guild":"%s","exportedAt":%d,"members":[%s]}',
        JSONEscape(guildName),
        GuildThingRosterDB.lastScan or time(),
        table.concat(parts, ",")
    )
end

-- Roster data isn't available synchronously — GuildRoster() just asks the
-- server to send it, and it lands later via GUILD_ROSTER_UPDATE. Callers
-- (the UI's refresh button) pass a callback to run once that arrives,
-- rather than reading GetGuildRosterInfo before it's populated.
local pendingCallback

function GT.RequestRosterUpdate(callback)
    pendingCallback = callback
    GuildRoster()
end

-- GUILD_ROSTER_UPDATE already fires on its own for join/leave/rank/note
-- changes that happen while online — Blizzard pushes those from the
-- server without anything here asking for them. PLAYER_ENTERING_WORLD
-- (login/reload) is different: the client may still be holding a stale
-- cached roster at that point, so this explicitly asks the server for a
-- fresh one via GuildRoster() — GUILD_ROSTER_UPDATE fires again once it
-- arrives and triggers the actual scan below.
local scanFrame = CreateFrame("Frame")
scanFrame:RegisterEvent("GUILD_ROSTER_UPDATE")
scanFrame:RegisterEvent("PLAYER_ENTERING_WORLD")
scanFrame:SetScript("OnEvent", function(_, event)
    if event == "PLAYER_ENTERING_WORLD" then
        GuildRoster()
        return
    end
    GT.ScanRoster()
    if pendingCallback then
        local callback = pendingCallback
        pendingCallback = nil
        callback()
    end
end)
