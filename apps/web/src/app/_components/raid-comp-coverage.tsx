"use client";

import { wowIconUrl, wowheadSpellUrl, type ExpansionDef } from "@guildthing/wowhead-data";

import type { CompState } from "./raid-comp-state";
import { raidCoverage } from "./raid-comp-state";
import { WowheadTooltips } from "./wowhead-tooltips";

// The raid-level coverage bands: every buff/debuff the expansion knows,
// lit when the comp provides it, dimmed when missing. Order is the
// catalog's order; the two panels sit side by side and stack on mobile.
export function RaidCompCoverage({
  expansion,
  comp,
}: {
  expansion: ExpansionDef;
  comp: CompState;
}) {
  const { buffs, debuffs } = raidCoverage(expansion, comp);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <WowheadTooltips />
      <CoverageBand title="Buffs" expansion={expansion} rows={buffs} />
      <CoverageBand title="Debuffs" expansion={expansion} rows={debuffs} />
    </div>
  );
}

function CoverageBand({
  title,
  expansion,
  rows,
}: {
  title: string;
  expansion: ExpansionDef;
  rows: { buff: { id: string; label: string; icon: string; spellId?: number }; covered: boolean }[];
}) {
  const coveredCount = rows.filter((r) => r.covered).length;
  return (
    <div className="bg-discord-base rounded-xl p-3">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <span className="text-discord-text-muted text-xs font-bold tracking-wider uppercase">
          {title}
        </span>
        <span className="text-discord-text-muted text-xs">
          {coveredCount}/{rows.length} covered
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
        {rows.map(({ buff, covered }) => {
          const content = (
            <>
              <img
                src={wowIconUrl(buff.icon)}
                alt=""
                className={`h-4 w-4 shrink-0 rounded-[3px] ${
                  covered ? "" : "opacity-40 grayscale"
                }`}
                draggable={false}
              />
              <span
                className={`truncate text-sm ${
                  covered ? "text-discord-text" : "text-discord-text-muted"
                }`}
              >
                {buff.label}
              </span>
            </>
          );
          const rowClassName = `flex items-center gap-2 rounded-lg px-2 py-1 ${
            covered ? "bg-discord-elevated-hover" : ""
          }`;
          return (
            <li key={buff.id}>
              {buff.spellId ? (
                // Wowhead's tooltip script attaches to plain hrefs like this
                // one automatically (see WowheadTooltips) — the real spell
                // tooltip renders on hover, no extra data to maintain here.
                <a
                  href={wowheadSpellUrl(expansion.id, buff.spellId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={rowClassName}
                >
                  {content}
                </a>
              ) : (
                <div
                  className={rowClassName}
                  title={covered ? undefined : `No one in this comp provides ${buff.label}`}
                >
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}