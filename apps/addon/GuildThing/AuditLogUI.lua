local GT = GuildThingRoster

-- "Audit Log" tab: a scrollable chronological list sourced entirely from
-- GuildThingAuditLogDB — written by apps/sync into SyncData.lua, the same
-- plain (non-SavedVariables) addon-code file as the Discord-roles data
-- (see DiscordRolesUI.lua's own comment for why that avoids the reload-
-- clobber problem SavedVariables would have here — a plain /reload is
-- enough, no full client restart needed). Merges in-game rank transitions
-- with human Discord role edits the bot's resync skipped. No "Request
-- sync" button here — that lives on the Discord Roles tab and already
-- covers this data in the same relayed request.

local ROW_HEIGHT = 18
local LIST_WIDTH = 600
local LIST_HEIGHT = 240

local rowPool = {}

-- Search text — module-level so it survives across Refresh() calls (every
-- tab-show), same lifetime as rowPool.
local searchText = ""

-- Exact local timestamp, matching the web admin panel's absoluteTime() in
-- ~/lib/format.ts — "45m ago" isn't precise enough to actually pin down
-- when something happened, unlike a relative label on a glanceable "last
-- active" column elsewhere.
local function FormatAbsolute(detectedAt)
    return date("%Y-%m-%d %H:%M:%S", detectedAt)
end

local function AcquireRow(parent, index)
    local row = rowPool[index]
    if row then
        row:SetParent(parent)
        return row
    end
    row = CreateFrame("Frame", nil, parent)
    row:SetSize(LIST_WIDTH, ROW_HEIGHT)

    row.name = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    row.name:SetPoint("LEFT", 0, 0)
    row.name:SetWidth(70)
    row.name:SetJustifyH("LEFT")

    row.nick = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    row.nick:SetPoint("LEFT", row.name, "RIGHT", 4, 0)
    row.nick:SetWidth(75)
    row.nick:SetJustifyH("LEFT")

    row.account = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    row.account:SetPoint("LEFT", row.nick, "RIGHT", 4, 0)
    row.account:SetWidth(85)
    row.account:SetJustifyH("LEFT")

    -- Wide enough for "YYYY-MM-DD HH:MM:SS" at this font size.
    row.when = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    row.when:SetPoint("LEFT", row.account, "RIGHT", 4, 0)
    row.when:SetWidth(130)
    row.when:SetJustifyH("LEFT")

    row.detail = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    row.detail:SetPoint("LEFT", row.when, "RIGHT", 4, 0)
    row.detail:SetPoint("RIGHT", 0, 0)
    row.detail:SetJustifyH("LEFT")
    row.detail:SetWordWrap(false)

    rowPool[index] = row
    return row
end

local function EntryMatchesSearch(e, query)
    if query == "" then return true end
    if e.characterName and e.characterName:lower():find(query, 1, true) then return true end
    if e.discordNick and e.discordNick:lower():find(query, 1, true) then return true end
    if e.discordTag and e.discordTag:lower():find(query, 1, true) then return true end
    return false
end

local function BuildRows(scrollChild, statusText)
    -- GuildThingAuditLogDB is nil until apps/sync has written it at least
    -- once — same "nothing yet" framing as the Discord Roles tab.
    local allEntries = (GuildThingAuditLogDB and GuildThingAuditLogDB.entries) or {}

    local query = searchText:lower()
    local entries = {}
    for _, e in ipairs(allEntries) do
        if EntryMatchesSearch(e, query) then
            table.insert(entries, e)
        end
    end

    if #allEntries == 0 then
        statusText:SetText("No audit log data yet — run apps/sync at least once.")
    else
        statusText:SetText(string.format("%d of %d entrie(s)", #entries, #allEntries))
    end

    local shown = 0
    for _, e in ipairs(entries) do
        shown = shown + 1
        local row = AcquireRow(scrollChild, shown)
        row:ClearAllPoints()
        row:SetPoint("TOPLEFT", 0, -(shown - 1) * ROW_HEIGHT)
        row:SetPoint("RIGHT", 0, 0)
        row.name:SetText(e.characterName)
        row.nick:SetText(e.discordNick or "—")
        row.account:SetText(e.discordTag or "—")
        row.when:SetText(FormatAbsolute(e.detectedAt))
        row.detail:SetText(e.detail)
        row:Show()
    end
    for i = shown + 1, #rowPool do
        rowPool[i]:Hide()
    end
    scrollChild:SetHeight(math.max(shown * ROW_HEIGHT, 1))
end

-- Builds the whole "Audit Log" page as a child of `parent`, filling it.
-- Returns { frame, Refresh } — UI.lua calls Refresh() whenever this page is
-- shown, same convention as the other two pages.
function GT.CreateAuditLogPage(parent)
    local page = CreateFrame("Frame", nil, parent)
    page:SetAllPoints(parent)

    local Refresh -- forward-declared, the search box calls this on change

    local toolbar = CreateFrame("Frame", nil, page)
    toolbar:SetSize(LIST_WIDTH, 22)
    toolbar:SetPoint("TOPLEFT", 0, 0)

    local searchBox = CreateFrame("EditBox", nil, toolbar, "InputBoxTemplate")
    searchBox:SetSize(200, 20)
    searchBox:SetPoint("LEFT", 8, 0)
    searchBox:SetAutoFocus(false)
    searchBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
    searchBox:SetScript("OnTextChanged", function(self)
        searchText = self:GetText() or ""
        if Refresh then Refresh() end
    end)

    local status = toolbar:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    status:SetPoint("LEFT", searchBox, "RIGHT", 12, 0)
    status:SetPoint("RIGHT", 0, 0)
    status:SetJustifyH("LEFT")

    -- Column headers — same widths/order as AcquireRow's row fields.
    local header = CreateFrame("Frame", nil, page)
    header:SetSize(LIST_WIDTH, ROW_HEIGHT)
    header:SetPoint("TOPLEFT", toolbar, "BOTTOMLEFT", 0, -6)
    local function headerLabel(text, width, anchorTo)
        local fs = header:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
        if anchorTo then
            fs:SetPoint("LEFT", anchorTo, "RIGHT", 4, 0)
        else
            fs:SetPoint("LEFT", 0, 0)
        end
        fs:SetWidth(width)
        fs:SetJustifyH("LEFT")
        fs:SetText(text)
        return fs
    end
    -- "Ing"/"Disc" prefixes disambiguate which side of the sync each
    -- column comes from — same convention as DiscordRolesUI.lua.
    local hName = headerLabel("Ing Name", 70, nil)
    local hNick = headerLabel("Disc Nick", 75, hName)
    local hAccount = headerLabel("Disc Acc", 85, hNick)
    local hWhen = headerLabel("When", 130, hAccount)
    headerLabel("Event", 130, hWhen)

    local scrollFrame = CreateFrame("ScrollFrame", nil, page, "UIPanelScrollFrameTemplate")
    scrollFrame:SetPoint("TOPLEFT", header, "BOTTOMLEFT", 0, -4)
    scrollFrame:SetSize(LIST_WIDTH, LIST_HEIGHT)

    local scrollChild = CreateFrame("Frame", nil, scrollFrame)
    scrollChild:SetSize(LIST_WIDTH, 1)
    scrollFrame:SetScrollChild(scrollChild)

    Refresh = function()
        BuildRows(scrollChild, status)
    end

    return { frame = page, Refresh = Refresh }
end
