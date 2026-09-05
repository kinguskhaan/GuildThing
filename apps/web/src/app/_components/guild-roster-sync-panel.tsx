"use client";

import { useState } from "react";

import { CollapsibleCard } from "~/app/_components/collapsible-card";
import { GuildExportPanel } from "~/app/_components/guild-export-panel";
import { GuildRosterImportForm } from "~/app/_components/guild-roster-import-form";

type Tab = "import" | "export";

function tabClass(active: boolean) {
  return `rounded-full px-3 py-1 text-sm font-semibold transition ${
    active
      ? "bg-discord-elevated-hover text-discord-text"
      : "text-discord-text-muted hover:text-discord-text"
  }`;
}

// Import (addon → roster) and export (roster → addon) are the two
// directions of the same integration point — one card with a tab switch
// instead of two stacked collapsed cards that both say "addon" in the title.
export function GuildRosterSyncPanel({
  guildId,
  existingMemberNames,
}: {
  guildId: string;
  existingMemberNames: string[];
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("import");

  return (
    <CollapsibleCard
      title="Sync roster with the addon"
      collapsed={!open}
      onToggle={() => setOpen((o) => !o)}
    >
      <div className="flex flex-col gap-4">
        <div className="flex w-fit gap-1 rounded-full bg-discord-base p-1">
          <button
            type="button"
            onClick={() => setTab("import")}
            className={tabClass(tab === "import")}
          >
            Import
          </button>
          <button
            type="button"
            onClick={() => setTab("export")}
            className={tabClass(tab === "export")}
          >
            Export
          </button>
        </div>

        {tab === "import" ? (
          <GuildRosterImportForm
            guildId={guildId}
            existingMemberNames={existingMemberNames}
          />
        ) : (
          <GuildExportPanel guildId={guildId} />
        )}
      </div>
    </CollapsibleCard>
  );
}
