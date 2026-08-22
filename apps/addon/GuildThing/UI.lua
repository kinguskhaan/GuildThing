local GT = GuildThingRoster

local frame

local TEXTBOX_WIDTH = 440
local TEXTBOX_HEIGHT = 220
local RIGHT_PADDING_FOR_SCROLLBAR = 34

-- Bordered, scrollable, read-only (still focusable/selectable so Ctrl+A/C
-- works right after it's populated, but typed edits get reverted) text box
-- for the export string. Width is explicit since the scrollFrame's anchors
-- aren't set until after this returns — reading GetWidth() before that
-- would just see 0.
local function CreateExportBox(parent, width, height)
    local border = CreateFrame("Frame", nil, parent, "BackdropTemplate")
    border:SetSize(width + 6 + RIGHT_PADDING_FOR_SCROLLBAR, height + 12)
    border:SetBackdrop({
        bgFile = "Interface/Tooltips/UI-Tooltip-Background",
        edgeFile = "Interface/Tooltips/UI-Tooltip-Border",
        tile = true, tileSize = 16, edgeSize = 12,
        insets = { left = 3, right = 3, top = 3, bottom = 3 },
    })
    border:SetBackdropColor(0, 0, 0, 0.85)

    local scrollFrame = CreateFrame("ScrollFrame", nil, border, "UIPanelScrollFrameTemplate")
    scrollFrame:SetPoint("TOPLEFT", 6, -6)
    scrollFrame:SetSize(width, height)

    local editBox = CreateFrame("EditBox", nil, scrollFrame)
    editBox:SetMultiLine(true)
    editBox:SetFontObject(ChatFontNormal)
    editBox:SetWidth(width)
    editBox:SetHeight(height)
    editBox:EnableMouse(true)
    editBox:SetAutoFocus(false)
    editBox:SetScript("OnEscapePressed", function(self) self:ClearFocus() end)

    editBox.lastSetText = ""
    editBox:SetScript("OnTextChanged", function(self, userInput)
        if userInput then
            self:SetText(self.lastSetText)
            self:HighlightText()
        end
    end)
    scrollFrame:SetScrollChild(editBox)

    local function FocusEditBox() editBox:SetFocus() end
    border:EnableMouse(true)
    border:SetScript("OnMouseDown", FocusEditBox)
    scrollFrame:EnableMouse(true)
    scrollFrame:SetScript("OnMouseDown", FocusEditBox)
    editBox:SetScript("OnMouseDown", FocusEditBox)

    return border, editBox
end

-- The original roster/export view, now built as its own page frame so it
-- can be shown/hidden as a unit alongside the Discord Roles page (see
-- DiscordRolesUI.lua) — same content and layout as before tabs existed,
-- just anchored inside `parent` (the shared page area under the tab
-- buttons) instead of directly under the dialog's title.
local function CreateRosterPage(parent)
    local page = CreateFrame("Frame", nil, parent)
    page:SetAllPoints(parent)

    local status = page:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    status:SetPoint("TOPLEFT", 0, 0)
    status:SetPoint("RIGHT", 0, 0)
    status:SetJustifyH("LEFT")

    local scanBtn = CreateFrame("Button", nil, page, "UIPanelButtonTemplate")
    scanBtn:SetSize(140, 22)
    scanBtn:SetPoint("TOPLEFT", status, "BOTTOMLEFT", 0, -8)
    scanBtn:SetText("Scan guild roster")

    local exportLabel = page:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    exportLabel:SetPoint("TOPLEFT", scanBtn, "BOTTOMLEFT", 0, -16)
    exportLabel:SetText("Paste this into the guild's import box on the website:")

    local exportBox, exportEditBox = CreateExportBox(page, TEXTBOX_WIDTH, TEXTBOX_HEIGHT)
    exportBox:SetPoint("TOPLEFT", exportLabel, "BOTTOMLEFT", 0, -8)

    local function Refresh()
        local roster = GT.GetRoster()
        local lastScan = GT.GetLastScanText()
        if #roster == 0 then
            status:SetText("No roster scanned yet.")
        else
            status:SetText(string.format("%d member(s) — last scan: %s", #roster, lastScan or "?"))
        end

        local json = GT.ExportRoster()
        exportEditBox.lastSetText = json
        exportEditBox:SetText(json)
    end

    scanBtn:SetScript("OnClick", function()
        scanBtn:SetText("Scanning...")
        scanBtn:Disable()
        GT.RequestRosterUpdate(function()
            Refresh()
            exportEditBox:HighlightText()
            exportEditBox:SetFocus()
            scanBtn:SetText("Scan guild roster")
            scanBtn:Enable()
        end)
    end)

    return { frame = page, Refresh = Refresh }
end

local function CreateGTFrame()
    -- Wide enough for the Discord Roles tab's five columns (name, rank,
    -- nick, account, roles) to actually be readable — the original 480
    -- only fit three.
    local f = CreateFrame("Frame", "GuildThingRosterFrame", UIParent, "BackdropTemplate")
    f:SetSize(640, 420)
    f:SetPoint("CENTER")
    f:SetMovable(true)
    f:EnableMouse(true)
    f:RegisterForDrag("LeftButton")
    f:SetScript("OnDragStart", f.StartMoving)
    f:SetScript("OnDragStop", f.StopMovingOrSizing)
    f:SetBackdrop({
        bgFile = "Interface/DialogFrame/UI-DialogBox-Background",
        edgeFile = "Interface/DialogFrame/UI-DialogBox-Border",
        tile = true, tileSize = 32, edgeSize = 32,
        insets = { left = 11, right = 12, top = 12, bottom = 11 },
    })
    f:SetFrameStrata("DIALOG")

    local title = f:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
    title:SetPoint("TOP", 0, -16)
    title:SetText("GuildThing Roster")

    local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
    close:SetPoint("TOPRIGHT", -4, -4)

    -- Three small toggle buttons stand in for a tab widget — this addon has
    -- never had one before (nothing to extend), and three views still
    -- doesn't justify building a general one.
    local rosterTabBtn = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
    rosterTabBtn:SetSize(90, 20)
    rosterTabBtn:SetPoint("TOPLEFT", 20, -40)
    rosterTabBtn:SetText("Roster")

    local rolesTabBtn = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
    rolesTabBtn:SetSize(110, 20)
    rolesTabBtn:SetPoint("LEFT", rosterTabBtn, "RIGHT", 4, 0)
    rolesTabBtn:SetText("Discord Roles")

    local auditTabBtn = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
    auditTabBtn:SetSize(90, 20)
    auditTabBtn:SetPoint("LEFT", rolesTabBtn, "RIGHT", 4, 0)
    auditTabBtn:SetText("Audit Log")

    -- Shared area all pages fill, below the tab row.
    local pageArea = CreateFrame("Frame", nil, f)
    pageArea:SetPoint("TOPLEFT", 20, -68)
    pageArea:SetPoint("BOTTOMRIGHT", -20, 16)

    local rosterPage = CreateRosterPage(pageArea)
    local discordRolesPage = GT.CreateDiscordRolesPage(pageArea)
    local auditLogPage = GT.CreateAuditLogPage(pageArea)

    local function ShowRosterTab()
        rosterTabBtn:Disable()
        rolesTabBtn:Enable()
        auditTabBtn:Enable()
        discordRolesPage.frame:Hide()
        auditLogPage.frame:Hide()
        rosterPage.frame:Show()
        rosterPage.Refresh()
    end
    local function ShowDiscordRolesTab()
        rolesTabBtn:Disable()
        rosterTabBtn:Enable()
        auditTabBtn:Enable()
        rosterPage.frame:Hide()
        auditLogPage.frame:Hide()
        discordRolesPage.frame:Show()
        discordRolesPage.Refresh()
    end
    local function ShowAuditLogTab()
        auditTabBtn:Disable()
        rosterTabBtn:Enable()
        rolesTabBtn:Enable()
        rosterPage.frame:Hide()
        discordRolesPage.frame:Hide()
        auditLogPage.frame:Show()
        auditLogPage.Refresh()
    end
    rosterTabBtn:SetScript("OnClick", ShowRosterTab)
    rolesTabBtn:SetScript("OnClick", ShowDiscordRolesTab)
    auditTabBtn:SetScript("OnClick", ShowAuditLogTab)

    f:SetScript("OnShow", ShowRosterTab)

    f:Hide()

    return f
end

local function ToggleGTFrame()
    if not frame then
        local ok, result = pcall(CreateGTFrame)
        if not ok then
            print("|cffff0000GuildThing Roster error:|r " .. tostring(result))
            return
        end
        frame = result
    end
    if frame:IsShown() then
        frame:Hide()
    else
        frame:Show()
    end
end

-- /gt and /guildthing are already claimed by OurRecipes (forked from the
-- same original addon, never renamed its own slash triggers) — use
-- distinct ones so SlashCmdList entries don't stomp each other based on
-- load order.
SLASH_GUILDTHINGROSTER1 = "/gtr"
SLASH_GUILDTHINGROSTER2 = "/guildroster"
SlashCmdList["GUILDTHINGROSTER"] = ToggleGTFrame
