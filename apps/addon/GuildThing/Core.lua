GuildThingDB = GuildThingDB or {}

GuildThing = GuildThing or {}
local GT = GuildThing

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

function GT.ScanRoster()
    local roster = {}
    for i = 1, GetNumGuildMembers() do
        local name, rank, _, level = GetGuildRosterInfo(i)
        if name then
            table.insert(roster, {
                name = StripRealm(name),
                rank = rank,
                level = level,
            })
        end
    end
    GuildThingDB.roster = roster
    GuildThingDB.lastScan = time()
    return roster
end

function GT.GetRoster()
    return GuildThingDB.roster or {}
end

function GT.GetLastScanText()
    if not GuildThingDB.lastScan then return nil end
    return date("%Y-%m-%d %H:%M", GuildThingDB.lastScan)
end

function GT.ExportRoster()
    local parts = {}
    for _, m in ipairs(GT.GetRoster()) do
        table.insert(parts, string.format(
            '{"name":"%s","rank":"%s","level":%s}',
            JSONEscape(m.name),
            JSONEscape(m.rank),
            m.level and tostring(m.level) or "null"
        ))
    end
    local guildName = GetGuildInfo("player") or ""
    return string.format(
        '{"guild":"%s","exportedAt":%d,"members":[%s]}',
        JSONEscape(guildName),
        GuildThingDB.lastScan or time(),
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

local scanFrame = CreateFrame("Frame")
scanFrame:RegisterEvent("GUILD_ROSTER_UPDATE")
scanFrame:SetScript("OnEvent", function()
    GT.ScanRoster()
    if pendingCallback then
        local callback = pendingCallback
        pendingCallback = nil
        callback()
    end
end)
