local GT = GuildThing

local frame

local TEXTBOX_WIDTH = 440
local TEXTBOX_HEIGHT = 260
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

local function CreateGTFrame()
    local f = CreateFrame("Frame", "GuildThingFrame", UIParent, "BackdropTemplate")
    f:SetSize(480, 420)
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
    title:SetText("GuildThing")

    local close = CreateFrame("Button", nil, f, "UIPanelCloseButton")
    close:SetPoint("TOPRIGHT", -4, -4)

    local status = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    status:SetPoint("TOPLEFT", 20, -44)
    status:SetPoint("RIGHT", -20, 0)
    status:SetJustifyH("LEFT")

    local scanBtn = CreateFrame("Button", nil, f, "UIPanelButtonTemplate")
    scanBtn:SetSize(140, 22)
    scanBtn:SetPoint("TOPLEFT", status, "BOTTOMLEFT", 0, -8)
    scanBtn:SetText("Scan guild roster")

    local exportLabel = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
    exportLabel:SetPoint("TOPLEFT", scanBtn, "BOTTOMLEFT", 0, -16)
    exportLabel:SetText("Paste this into the guild's import box on the website:")

    local exportBox, exportEditBox = CreateExportBox(f, TEXTBOX_WIDTH, TEXTBOX_HEIGHT)
    exportBox:SetPoint("TOPLEFT", exportLabel, "BOTTOMLEFT", 0, -8)

    local function RefreshStatus()
        local roster = GT.GetRoster()
        local lastScan = GT.GetLastScanText()
        if #roster == 0 then
            status:SetText("No roster scanned yet.")
        else
            status:SetText(string.format("%d member(s) — last scan: %s", #roster, lastScan or "?"))
        end
    end

    local function RefreshExportBox()
        local json = GT.ExportRoster()
        exportEditBox.lastSetText = json
        exportEditBox:SetText(json)
    end

    scanBtn:SetScript("OnClick", function()
        scanBtn:SetText("Scanning...")
        scanBtn:Disable()
        GT.RequestRosterUpdate(function()
            RefreshStatus()
            RefreshExportBox()
            exportEditBox:HighlightText()
            exportEditBox:SetFocus()
            scanBtn:SetText("Scan guild roster")
            scanBtn:Enable()
        end)
    end)

    f:SetScript("OnShow", function()
        RefreshStatus()
        RefreshExportBox()
    end)

    f:Hide()

    return f
end

local function ToggleGTFrame()
    if not frame then
        local ok, result = pcall(CreateGTFrame)
        if not ok then
            print("|cffff0000GuildThing error:|r " .. tostring(result))
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

SLASH_GUILDTHING1 = "/gt"
SLASH_GUILDTHING2 = "/guildthing"
SlashCmdList["GUILDTHING"] = ToggleGTFrame
