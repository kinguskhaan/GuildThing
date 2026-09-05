"use client";

import { wowIconUrl, type ExpansionDef } from "@guildthing/wowhead-data";

import { CompBlock, type SlotRef } from "./raid-comp-canvas";
import type { CompSlot, CompState } from "./raid-comp-state";
import { BENCH_GROUP_INDEX, benchSlots } from "./raid-comp-state";

// The role view: the same placed members as the group canvas, bucketed by
// their spec's combat role (tank / healer / ranged / melee). Placement and
// drag-and-drop stay group-view operations — this view is for reading the
// comp's shape ("do we have heals? who's melee?") and for setting specs /
// removing members, so blocks here don't drag.
const ROLE_BUCKETS = [
  { role: "tank", label: "Tanks" },
  { role: "healer", label: "Healers" },
  { role: "ranged", label: "Ranged DPS" },
  { role: "melee", label: "Melee DPS" },
] as const;

export function RaidCompRoles({
  expansion,
  comp,
  onRemoveAt,
  onSetSpec,
  onSetClass,
}: {
  expansion: ExpansionDef;
  comp: CompState;
  onRemoveAt: (ref: SlotRef) => void;
  onSetSpec: (slot: CompSlot, specToken: string | null) => void;
  onSetClass: (slot: CompSlot, classToken: string) => void;
}) {
  const placed = comp.slots.filter((s) => s.groupIndex >= 0);
  const bench = benchSlots(comp);

  const byRole = new Map<string, CompSlot[]>();
  for (const bucket of ROLE_BUCKETS) byRole.set(bucket.role, []);
  const noSpec: CompSlot[] = [];
  for (const slot of placed) {
    const spec = slot.specToken
      ? expansion.specs.find((s) => s.token === slot.specToken)
      : undefined;
    if (spec) byRole.get(spec.role)!.push(slot);
    else noSpec.push(slot);
  }

  const blockProps = (slot: CompSlot) => ({
    slot,
    expansion,
    dragging: false,
    // Blocks in this view don't drag (see the file-level comment above) —
    // CompBlock still requires these handlers, so wire them to no-ops.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onDragStart: () => {},
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    onDragEnd: () => {},
    onRemove: () =>
      onRemoveAt({
        groupIndex: slot.groupIndex,
        slotIndex: slot.slotIndex,
      }),
    onSetSpec,
    onSetClass,
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
        {ROLE_BUCKETS.map(({ role, label }) => {
          const slots = byRole.get(role)!;
          return (
            <div key={role} className="bg-discord-base rounded-xl p-2">
              <div className="mb-1.5 flex items-baseline justify-between px-1">
                <span className="text-discord-text-muted text-xs font-bold tracking-wider uppercase">
                  {label}
                </span>
                <span className="text-discord-text-muted text-xs">
                  {slots.length}
                </span>
              </div>
              {slots.length > 0 ? (
                <div className="flex flex-col gap-1">
                  {slots.map((slot) => (
                    <CompBlock
                      key={`${slot.groupIndex}:${slot.slotIndex}`}
                      {...blockProps(slot)}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-discord-text-muted px-1 py-2 text-sm">
                  None placed yet.
                </p>
              )}
            </div>
          );
        })}
        {noSpec.length > 0 && (
          <div className="bg-discord-base rounded-xl p-2">
            <div className="mb-1.5 flex items-baseline justify-between px-1">
              <span className="text-discord-text-muted text-xs font-bold tracking-wider uppercase">
                No spec yet
              </span>
              <span className="text-discord-text-muted text-xs">
                {noSpec.length}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {noSpec.map((slot) => (
                <CompBlock
                  key={`${slot.groupIndex}:${slot.slotIndex}`}
                  {...blockProps(slot)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="bg-discord-base rounded-xl p-2">
        <span className="text-discord-text-muted px-1 pb-1.5 text-xs font-bold tracking-wider uppercase">
          Bench
        </span>
        {bench.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 p-1">
            {bench.map((slot) => (
              <div key={`bench:${slot.slotIndex}`} className="w-44">
                <CompBlock {...blockProps(slot)} />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-discord-text-muted px-1 py-2 text-sm">
            Bench is empty.
          </p>
        )}
      </div>
    </div>
  );
}