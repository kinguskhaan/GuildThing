"use client";

// Read-only rendering of one saved raid comp — the page behind a share
// link. Same group wall, bench and coverage as the builder's Groups view,
// but every block is readOnly: no drag, no remove, no spec picker. Placed
// through the Copy share link button in the admin builder.
import {
  wowIconUrl,
  wowheadSpellUrl,
  type ExpansionDef,
} from "@guildthing/wowhead-data";

import { RaidCompCoverage } from "~/app/_components/raid-comp-coverage";
import { CompBlock, EmptySlot } from "~/app/_components/raid-comp-canvas";

import {
  GROUP_SIZE,
  benchSlots,
  groupCoverage,
  groupSlots,
  type CompState,
} from "./raid-comp-state";

export function RaidCompView({
  expansion,
  comp,
}: {
  expansion: ExpansionDef;
  comp: CompState;
}) {
  const bench = benchSlots(comp);

  const groups = [];
  for (let g = 0; g < comp.groupCount; g++) {
    const slots = groupSlots(comp, g);
    const groupBuffs = groupCoverage(expansion, comp, g);
    const slotRows = [];
    for (let i = 0; i < GROUP_SIZE; i++) {
      const slot = slots.find((s) => s.slotIndex === i);
      slotRows.push(
        slot ? (
          <CompBlock
            key={`${slot.groupIndex}:${slot.slotIndex}`}
            slot={slot}
            expansion={expansion}
            readOnly
          />
        ) : (
          // Idle empty slot, exactly how the builder renders it when no
          // drag is active — onDrop never fires without a drag payload.
          <EmptySlot key={`empty:${g}:${i}`} dragActive={false} />
        ),
      );
    }
    groups.push(
      <div key={g} className="bg-discord-base rounded-xl p-2">
        <div className="mb-1.5 px-1">
          <span className="text-discord-text-muted text-xs font-bold uppercase tracking-wider">
            Group {g + 1}
          </span>
        </div>
        <div className="flex flex-col gap-1">{slotRows}</div>
        <div
          className="mt-1.5 flex min-h-6 items-center gap-1 rounded-lg px-1 py-0.5"
          title={
            groupBuffs.some((b) => !b.spellId)
              ? groupBuffs.map((b) => b.label).join(", ")
              : undefined
          }
        >
          {groupBuffs.length > 0 ? (
            groupBuffs.map((b) =>
              b.spellId ? (
                <a
                  key={b.id}
                  href={wowheadSpellUrl(expansion.id, b.spellId)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img
                    src={wowIconUrl(b.icon)}
                    alt={b.label}
                    className="h-4 w-4 rounded-[3px]"
                    draggable={false}
                  />
                </a>
              ) : (
                <img
                  key={b.id}
                  src={wowIconUrl(b.icon)}
                  alt={b.label}
                  title={b.label}
                  className="h-4 w-4 rounded-[3px]"
                  draggable={false}
                />
              ),
            )
          ) : (
            <span className="text-discord-text-muted px-1 text-xs">
              No group buffs
            </span>
          )}
        </div>
      </div>,
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {groups}
      </div>
      <div className="bg-discord-base rounded-xl p-2">
        <span className="text-discord-text-muted px-1 pb-1.5 text-xs font-bold uppercase tracking-wider">
          Bench
        </span>
        {bench.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 p-1">
            {bench.map((slot) => (
              <div key={`bench:${slot.slotIndex}`} className="w-44">
                <CompBlock slot={slot} expansion={expansion} readOnly />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-discord-text-muted px-1 py-2 text-sm">
            Bench is empty.
          </p>
        )}
      </div>
      <RaidCompCoverage expansion={expansion} comp={comp} />
    </div>
  );
}
