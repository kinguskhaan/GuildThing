local GT = GuildThingRoster

-- "Discord Roles" tab: a scrollable Name/Rank/Roles list, sourced from the
-- roster scan (GT.GetRoster, already in-memory) joined against
-- GuildThingDiscordRolesDB — a global this addon never assigns to itself.
-- apps/sync writes it into SyncData.lua, a plain addon-code file (see
-- GuildThing.toc's file list) — deliberately NOT a `## SavedVariables:`
-- entry. WoW only "owns" (loads once, then saves the current in-memory
-- state back over on every reload/logout) SavedVariables files; every
-- other file in the .toc's list, including this one, is just re-executed
-- fresh from disk on every single addon load. So a write that lands while
-- the client is already running is never at risk of being clobbered by
-- the client's own save-on-teardown — a plain /reload picks it up
-- correctly, no full client restart needed. WoW addons still can't make
-- network calls at all, so the data itself is only ever as fresh as
-- apps/sync's last run — "Request sync" below can't trigger anything
-- immediately, only flag a request for apps/sync to notice on its own
-- next pass (and THAT flag, being addon-authored `GuildThingRosterDB`
-- state rather than externally-written, still needs an actual reload/
-- logout to flush to disk before apps/sync can see it).

local ROW_HEIGHT = 18
local LIST_WIDTH = 600
local LIST_HEIGHT = 198

local rowPool = {}

-- Search text, dropdown filter selections, and current sort — module-level
-- so they survive across Refresh() calls (every tab-show) instead of
-- resetting each time, same lifetime as rowPool.
local searchText = ""
local rankFilter = nil -- nil = all ranks
local roleFilter = nil -- nil = all roles
local mismatchOnly = false
local sortColumn = "name" -- "name" | "rank" | "nick" | "account"
local sortDesc = false

local function AcquireRow(parent, index)
    local row = rowPool[index]
    if row then
        row:SetParent(parent)
        return row
    end
    row = CreateFrame("Frame", nil, parent)
    row:SetSize(LIST_WIDTH, ROW_HEIGHT)

    -- Clicking anywhere on the row jumps to that person's own history on
    -- the Audit Log tab (see GT.ShowAuditLogFor in UI.lua) — row.characterName
    -- is (re)assigned fresh on every BuildRows call below, so the handler
    -- always sees whoever's currently shown in this pooled row, not
    -- whoever it was created for.
    row:EnableMouse(true)
    row:SetScript("OnEnter", function(self) self.name:SetTextColor(1, 0.82, 0) end)
    row:SetScript("OnLeave", function(self) self.name:SetTextColor(1, 1, 1) end)
    row:SetScript("OnMouseUp", function(self)
        if self.characterName and GT.ShowAuditLogFor then
            GT.ShowAuditLogFor(self.characterName)
        end
    end)

    row.name = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    row.name:SetPoint("LEFT", 0, 0)
    row.name:SetWidth(90)
    row.name:SetJustifyH("LEFT")

    row.rank = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    row.rank:SetPoint("LEFT", row.name, "RIGHT", 4, 0)
    row.rank:SetWidth(65)
    row.rank:SetJustifyH("LEFT")

    -- Their current Discord server nickname (falls back to their account
    -- name below if they haven't set one) and their actual Discord account
    -- name — two different things, both worth showing since a nickname is
    -- guild-specific and can be anything, but the account name is the
    -- stable identity behind it.
    row.nick = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    row.nick:SetPoint("LEFT", row.rank, "RIGHT", 4, 0)
    row.nick:SetWidth(95)
    row.nick:SetJustifyH("LEFT")

    row.account = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    row.account:SetPoint("LEFT", row.nick, "RIGHT", 4, 0)
    row.account:SetWidth(110)
    row.account:SetJustifyH("LEFT")

    row.roles = row:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    row.roles:SetPoint("LEFT", row.account, "RIGHT", 4, 0)
    row.roles:SetPoint("RIGHT", 0, 0)
    row.roles:SetJustifyH("LEFT")
    row.roles:SetWordWrap(false)

    rowPool[index] = row
    return row
end

-- Joins the in-game roster scan against GuildThingDiscordRolesDB and
-- GuildThingRoleMismatchesDB by name into one flat list of plain tables —
-- the shape everything below (search/filter/sort) operates on, independent
-- of either source's own structure. Mismatch data comes from the bot's
-- diffGuildRoles pass (apps/bot/src/roleSync.ts), written down by
-- role-mismatches/route.ts — read-only, always at most an hour stale (or
-- fresher right after a sync); "Request sync" below is the fix.
local function GetCombinedRows()
    local roster = GT.GetRoster()
    local membersData = (GuildThingDiscordRolesDB and GuildThingDiscordRolesDB.members) or {}
    local mismatchData = (GuildThingRoleMismatchesDB and GuildThingRoleMismatchesDB.members) or {}

    local rows = {}
    for _, m in ipairs(roster) do
        local entry = membersData[m.name]
        local hasSyncData = entry ~= nil
            and (entry.tag ~= nil or (entry.roleNames and #entry.roleNames > 0))
        local mismatch = mismatchData[m.name]
        local hasMismatch = mismatch ~= nil
            and ((mismatch.toAdd and #mismatch.toAdd > 0) or (mismatch.toRemove and #mismatch.toRemove > 0))
        table.insert(rows, {
            name = m.name,
            rank = m.rank,
            nick = hasSyncData and entry.nick or nil,
            account = hasSyncData and entry.tag or nil,
            roles = hasSyncData and entry.roleNames or {},
            hasSyncData = hasSyncData,
            hasMismatch = hasMismatch,
            mismatchAdd = hasMismatch and mismatch.toAdd or {},
            mismatchRemove = hasMismatch and mismatch.toRemove or {},
        })
    end
    return rows
end

local function RowMatchesSearch(row, query)
    if query == "" then return true end
    if row.name:lower():find(query, 1, true) then return true end
    if row.nick and row.nick:lower():find(query, 1, true) then return true end
    if row.account and row.account:lower():find(query, 1, true) then return true end
    return false
end

local function RowHasRole(row, role)
    for _, r in ipairs(row.roles) do
        if r == role then return true end
    end
    return false
end

local function ApplyFiltersAndSort(rows)
    local query = searchText:lower()
    local filtered = {}
    for _, row in ipairs(rows) do
        if (not rankFilter or row.rank == rankFilter)
            and (not roleFilter or RowHasRole(row, roleFilter))
            and (not mismatchOnly or row.hasMismatch)
            and RowMatchesSearch(row, query)
        then
            table.insert(filtered, row)
        end
    end

    table.sort(filtered, function(a, b)
        if sortColumn == "nick" or sortColumn == "account" then
            -- Claimed (has a value) always sorts before unclaimed,
            -- regardless of direction — "de som claimat högst upp, de som
            -- inte claimat längst ner" — direction only decides ordering
            -- WITHIN the claimed group.
            local av, bv = a[sortColumn], b[sortColumn]
            if (av ~= nil) ~= (bv ~= nil) then
                return av ~= nil
            end
            if av == nil then return false end
            local cmp = av:lower() < bv:lower()
            if sortDesc then return av:lower() > bv:lower() end
            return cmp
        end

        local av, bv = a[sortColumn]:lower(), b[sortColumn]:lower()
        if sortDesc then return av > bv end
        return av < bv
    end)

    return filtered
end

local function BuildRows(scrollChild)
    local rows = ApplyFiltersAndSort(GetCombinedRows())

    local shown = 0
    for _, row in ipairs(rows) do
        shown = shown + 1
        local frame = AcquireRow(scrollChild, shown)
        frame:ClearAllPoints()
        frame:SetPoint("TOPLEFT", 0, -(shown - 1) * ROW_HEIGHT)
        frame:SetPoint("RIGHT", 0, 0)
        frame.characterName = row.name
        frame.name:SetText(row.name)
        frame.rank:SetText(row.rank)
        if row.hasSyncData then
            frame.nick:SetText(row.nick or "—")
            frame.account:SetText(row.account or "—")
            local rolesText = (#row.roles > 0) and table.concat(row.roles, ", ") or "—"
            if row.hasMismatch then
                local parts = {}
                if #row.mismatchAdd > 0 then
                    table.insert(parts, "+" .. table.concat(row.mismatchAdd, ",+"))
                end
                if #row.mismatchRemove > 0 then
                    table.insert(parts, "-" .. table.concat(row.mismatchRemove, ",-"))
                end
                rolesText = rolesText .. " |cffff8800[" .. table.concat(parts, " ") .. "]|r"
            end
            frame.roles:SetText(rolesText)
        else
            frame.nick:SetText("")
            frame.account:SetText("")
            frame.roles:SetText("|cff888888(no sync data yet)|r")
        end
        frame:Show()
    end
    for i = shown + 1, #rowPool do
        rowPool[i]:Hide()
    end
    scrollChild:SetHeight(math.max(shown * ROW_HEIGHT, 1))

    return shown
end

-- Builds the whole "Discord Roles" page (search/filter toolbar, sortable
-- list, "Request sync" button) as a child of `parent`, filling it. Returns
-- { frame, Refresh } — UI.lua calls Refresh() whenever this page is shown,
-- same as it already refreshes the roster page's status/export text on
-- show/scan.
function GT.CreateDiscordRolesPage(parent)
    local page = CreateFrame("Frame", nil, parent)
    page:SetAllPoints(parent)

    local Refresh -- forward-declared, filters/dropdowns call this on change

    -- Toolbar: search box + rank/role filter dropdowns (each labeled above
    -- it, since "Guild Rank"/"Discord Roles" isn't obvious from the
    -- dropdown's own placeholder text alone) + a status count. Bottom-
    -- aligned within a taller-than-the-controls band so there's headroom
    -- above the dropdowns for their labels.
    local toolbar = CreateFrame("Frame", nil, page)
    toolbar:SetSize(LIST_WIDTH, 36)
    toolbar:SetPoint("TOPLEFT", 0, 0)

    local searchBox = CreateFrame("EditBox", nil, toolbar, "InputBoxTemplate")
    searchBox:SetSize(150, 20)
    searchBox:SetPoint("BOTTOMLEFT", toolbar, "BOTTOMLEFT", 8, 0)
    searchBox:SetAutoFocus(false)
    searchBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)
    searchBox:SetScript("OnTextChanged", function(self)
        searchText = self:GetText() or ""
        if Refresh then Refresh() end
    end)

    local rankDropDown = CreateFrame(
        "Frame", "GuildThingRankFilterDropDown", toolbar, "UIDropDownMenuTemplate"
    )
    rankDropDown:SetPoint("BOTTOMLEFT", searchBox, "BOTTOMRIGHT", 4, -2)
    UIDropDownMenu_SetWidth(rankDropDown, 80)

    local rankLabel = toolbar:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    rankLabel:SetPoint("BOTTOMLEFT", rankDropDown, "TOPLEFT", 16, 3)
    rankLabel:SetJustifyH("LEFT")
    rankLabel:SetText("Guild Rank")

    local roleDropDown = CreateFrame(
        "Frame", "GuildThingRoleFilterDropDown", toolbar, "UIDropDownMenuTemplate"
    )
    roleDropDown:SetPoint("LEFT", rankDropDown, "RIGHT", -12, 0)
    UIDropDownMenu_SetWidth(roleDropDown, 80)

    local roleLabel = toolbar:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    roleLabel:SetPoint("BOTTOMLEFT", roleDropDown, "TOPLEFT", 16, 3)
    roleLabel:SetJustifyH("LEFT")
    roleLabel:SetText("Discord Roles")

    local function InitRankDropDown(self, level)
        local rows = GetCombinedRows()
        local ranks = {}
        local seen = {}
        for _, row in ipairs(rows) do
            if not seen[row.rank] then
                seen[row.rank] = true
                table.insert(ranks, row.rank)
            end
        end
        table.sort(ranks)

        local allInfo = UIDropDownMenu_CreateInfo()
        allInfo.text = "All ranks"
        allInfo.checked = (rankFilter == nil)
        allInfo.func = function()
            rankFilter = nil
            UIDropDownMenu_SetText(rankDropDown, "All ranks")
            CloseDropDownMenus()
            if Refresh then Refresh() end
        end
        UIDropDownMenu_AddButton(allInfo, level)

        for _, rank in ipairs(ranks) do
            local info = UIDropDownMenu_CreateInfo()
            info.text = rank
            info.checked = (rankFilter == rank)
            info.func = function()
                rankFilter = rank
                UIDropDownMenu_SetText(rankDropDown, rank)
                CloseDropDownMenus()
                if Refresh then Refresh() end
            end
            UIDropDownMenu_AddButton(info, level)
        end
    end

    local function InitRoleDropDown(self, level)
        local rows = GetCombinedRows()
        local roles = {}
        local seen = {}
        for _, row in ipairs(rows) do
            for _, r in ipairs(row.roles) do
                if not seen[r] then
                    seen[r] = true
                    table.insert(roles, r)
                end
            end
        end
        table.sort(roles)

        local allInfo = UIDropDownMenu_CreateInfo()
        allInfo.text = "All roles"
        allInfo.checked = (roleFilter == nil)
        allInfo.func = function()
            roleFilter = nil
            UIDropDownMenu_SetText(roleDropDown, "All roles")
            CloseDropDownMenus()
            if Refresh then Refresh() end
        end
        UIDropDownMenu_AddButton(allInfo, level)

        for _, role in ipairs(roles) do
            local info = UIDropDownMenu_CreateInfo()
            info.text = role
            info.checked = (roleFilter == role)
            info.func = function()
                roleFilter = role
                UIDropDownMenu_SetText(roleDropDown, role)
                CloseDropDownMenus()
                if Refresh then Refresh() end
            end
            UIDropDownMenu_AddButton(info, level)
        end
    end

    UIDropDownMenu_Initialize(rankDropDown, InitRankDropDown)
    UIDropDownMenu_SetText(rankDropDown, "All ranks")
    UIDropDownMenu_Initialize(roleDropDown, InitRoleDropDown)
    UIDropDownMenu_SetText(roleDropDown, "All roles")

    local clearBtn = CreateFrame("Button", nil, toolbar, "UIPanelButtonTemplate")
    clearBtn:SetSize(50, 20)
    clearBtn:SetPoint("LEFT", roleDropDown, "RIGHT", -8, 2)
    clearBtn:SetText("Clear")
    clearBtn:SetScript("OnClick", function()
        searchText = ""
        searchBox:SetText("")
        rankFilter = nil
        roleFilter = nil
        mismatchOnly = false
        UIDropDownMenu_SetText(rankDropDown, "All ranks")
        UIDropDownMenu_SetText(roleDropDown, "All roles")
        if Refresh then Refresh() end
    end)

    -- Quick filter for the drift diffGuildRoles found (see GetCombinedRows)
    -- — jumps an admin straight to the rows "Request sync" below would fix.
    local mismatchCheck = CreateFrame(
        "CheckButton", nil, toolbar, "UICheckButtonTemplate"
    )
    mismatchCheck:SetSize(20, 20)
    mismatchCheck:SetPoint("LEFT", clearBtn, "RIGHT", 4, 2)
    mismatchCheck:SetScript("OnClick", function(self)
        mismatchOnly = self:GetChecked() and true or false
        if Refresh then Refresh() end
    end)

    local mismatchCheckLabel = toolbar:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    mismatchCheckLabel:SetPoint("LEFT", mismatchCheck, "RIGHT", 0, 1)
    mismatchCheckLabel:SetText("Mismatches only")

    local countText = toolbar:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    countText:SetPoint("LEFT", mismatchCheckLabel, "RIGHT", 8, -1)
    countText:SetPoint("RIGHT", 0, 0)
    countText:SetJustifyH("RIGHT")

    -- Column headers, sortable by click — same widths/order as
    -- AcquireRow's row fields.
    local header = CreateFrame("Frame", nil, page)
    header:SetSize(LIST_WIDTH, ROW_HEIGHT)
    header:SetPoint("TOPLEFT", toolbar, "BOTTOMLEFT", 0, -6)

    local function SortIndicator(column)
        if sortColumn ~= column then return "" end
        return sortDesc and " v" or " ^"
    end

    local headerLabels = {}
    local function headerLabel(text, width, anchorTo, sortKey)
        local btn = CreateFrame("Button", nil, header)
        if anchorTo then
            btn:SetPoint("LEFT", anchorTo, "RIGHT", 4, 0)
        else
            btn:SetPoint("LEFT", 0, 0)
        end
        btn:SetSize(width, ROW_HEIGHT)
        local fs = btn:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
        fs:SetAllPoints(btn)
        fs:SetJustifyH("LEFT")
        btn.label = text
        btn.fs = fs
        btn.sortKey = sortKey
        if sortKey then
            btn:SetScript("OnClick", function()
                if sortColumn == sortKey then
                    sortDesc = not sortDesc
                else
                    sortColumn = sortKey
                    sortDesc = false
                end
                if Refresh then Refresh() end
            end)
            table.insert(headerLabels, btn)
        else
            fs:SetText(text)
        end
        return btn
    end
    -- "Ing"/"Disc" prefixes disambiguate which side of the sync each
    -- column comes from — the in-game roster scan vs. the Discord roles
    -- snapshot — since e.g. "Rank" alone could otherwise be read as either.
    local hName = headerLabel("Ing Name", 90, nil, "name")
    local hRank = headerLabel("Guild Rank", 65, hName, "rank")
    local hNick = headerLabel("Disc Nick", 95, hRank, "nick")
    local hAccount = headerLabel("Disc Acc", 110, hNick, "account")
    headerLabel("Disc Roles", 130, hAccount, nil)

    local function RefreshHeaderLabels()
        for _, btn in ipairs(headerLabels) do
            btn.fs:SetText(btn.label .. SortIndicator(btn.sortKey))
        end
    end

    local scrollFrame = CreateFrame("ScrollFrame", nil, page, "UIPanelScrollFrameTemplate")
    scrollFrame:SetPoint("TOPLEFT", header, "BOTTOMLEFT", 0, -4)
    scrollFrame:SetSize(LIST_WIDTH, LIST_HEIGHT)

    local scrollChild = CreateFrame("Frame", nil, scrollFrame)
    scrollChild:SetSize(LIST_WIDTH, 1)
    scrollFrame:SetScrollChild(scrollChild)

    local requestBtn = CreateFrame("Button", nil, page, "UIPanelButtonTemplate")
    requestBtn:SetSize(140, 22)
    requestBtn:SetPoint("TOPLEFT", scrollFrame, "BOTTOMLEFT", 0, -8)
    requestBtn:SetText("Request sync")

    local requestStatus = page:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    requestStatus:SetPoint("TOPLEFT", requestBtn, "BOTTOMLEFT", 0, -6)
    requestStatus:SetPoint("RIGHT", 0, 0)
    requestStatus:SetJustifyH("LEFT")

    requestBtn:SetScript("OnClick", function()
        GuildThingRosterDB.syncRequestedAt = time()
        requestStatus:SetText(
            "Requested — apps/sync only sees this after you /reload or log out (SavedVariables flush to disk then), and it may take a few minutes after that for the results to update here. Not instant."
        )
    end)

    Refresh = function()
        local shown = BuildRows(scrollChild)
        local allRows = GetCombinedRows()
        local mismatchCount = 0
        for _, row in ipairs(allRows) do
            if row.hasMismatch then mismatchCount = mismatchCount + 1 end
        end
        local countLine = shown .. " of " .. #allRows
        if mismatchCount > 0 then
            countLine = countLine .. " |cffff8800(" .. mismatchCount .. " mismatch"
                .. (mismatchCount == 1 and "" or "es") .. ")|r"
        end
        countText:SetText(countLine)
        RefreshHeaderLabels()
    end

    return { frame = page, Refresh = Refresh }
end
