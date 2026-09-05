"use client";

import { useState } from "react";

import { wowIconUrl, type ExpansionDef } from "@guildthing/wowhead-data";

import { classColor } from "~/lib/format";

import type { CompSlot, CompState } from "./raid-comp-state";
import { BENCH_GROUP_INDEX, GROUP_SIZE, benchSlots, groupCoverage, groupSlots } from "./raid-comp-state";

// What a drag carries: a fresh roster pick or an existing block being moved.
export type DragPayload =
  | {
      source: "roster";
      memberId: string;
      name: string;
      classToken: string | null;
      specToken: string | null;
    }
  | { source: "slot"; slot: CompSlot }
  | { source: "placeholder"; classToken: string };

export type DropTarget =
  | { kind: "slot"; groupIndex: number; slotIndex: number }
  | { kind: "bench" }
  | { kind: "drawer" };

export type SlotRef = { groupIndex: number; slotIndex: number };

interface CanvasProps {
  expansion: ExpansionDef;
  comp: CompState;
  dragPayload: DragPayload | null;
  onDragPayloadChange: (payload: DragPayload | null) => void;
  onDropAt: (target: DropTarget) => void;
  onRemoveAt: (ref: SlotRef) => void;
  onRemoveGroup: (groupIndex: number) => void;
  onSetSpec: (slot: CompSlot, specToken: string | null) => void;
  onSetClass: (slot: CompSlot, classToken: string) => void;
}

// One filled snap-block: class icon first, class-colored name, spec label.
// The icon is the block's identity — spec icon when known, class icon when
// the spec hasn't synced or the expansion has no specs.
export function CompBlock({
  slot,
  expansion,
  onRemove,
  onSetSpec,
  onSetClass,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  slot: CompSlot;
  expansion: ExpansionDef;
  onRemove: () => void;
  onSetSpec: (slot: CompSlot, specToken: string | null) => void;
  onSetClass: (slot: CompSlot, classToken: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  dragging: boolean;
}) {
  const cls = expansion.classes.find((c) => c.token === slot.classToken);
  const spec = slot.specToken
    ? expansion.specs.find((s) => s.token === slot.specToken)
    : undefined;
  const icon = spec?.icon ?? cls?.icon;
  // A slot with no roster link and no name was never a real character — an
  // officer added it as a "we'll have a warrior here" stand-in. That's
  // different from `stale`, below: a slot whose rosterMemberId got SetNull
  // because the roster row it pointed to was deleted, but whose name
  // snapshot survives on the row.
  const isPlaceholder = slot.rosterMemberId == null && slot.characterName == null;
  const label = slot.characterName ?? (isPlaceholder ? (cls?.label ?? "Placeholder") : "Unknown");
  const stale = slot.rosterMemberId == null && slot.characterName != null;
  const [specPickerOpen, setSpecPickerOpen] = useState(false);
  const [classPickerOpen, setClassPickerOpen] = useState(false);

  const classSpecs = expansion.specs.filter(
    (s) => slot.classToken == null || s.classToken === slot.classToken,
  );

  return (
    <div
      draggable={!stale}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`bg-discord-elevated-hover group relative flex h-9 items-center gap-2 rounded-lg px-2 ${
        dragging ? "opacity-40" : ""
      } ${stale ? "opacity-60" : ""} ${
        isPlaceholder ? "border border-dashed border-discord-text-muted/50" : ""
      }`}
      title={
        stale
          ? `${label} is no longer on the roster — remove the block or replace it`
          : isPlaceholder
            ? "Placeholder — no roster member assigned. Drag a roster member onto it to fill the slot."
            : undefined
      }
    >
      {icon ? (
        <img
          src={wowIconUrl(icon)}
          alt=""
          className="h-[18px] w-[18px] shrink-0 rounded-[3px]"
          draggable={false}
        />
      ) : (
        <span className="bg-discord-rail h-[18px] w-[18px] shrink-0 rounded-[3px]" />
      )}
      <span
        className={`truncate text-sm font-semibold ${isPlaceholder ? "italic" : ""}`}
        style={{ color: slot.classToken ? classColor(slot.classToken) : undefined }}
      >
        {label}
      </span>
      {!stale && expansion.hasSpecs && (
        <button
          type="button"
          onClick={() => setSpecPickerOpen(true)}
          title={
            spec
              ? `Change ${label}'s specialization`
              : `Set ${label}'s specialization (synced from Battle.net when configured)`
          }
          className={`truncate rounded px-1 text-xs transition hover:text-discord-text ${
            spec ? "text-discord-text-muted" : "text-discord-link"
          }`}
        >
          {spec ? spec.label : "set spec"}
        </button>
      )}
      {specPickerOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setSpecPickerOpen(false)}
          />
          <div className="bg-discord-elevated absolute top-full right-0 z-20 mt-1 min-w-40 rounded-lg p-1 shadow-lg">
            <span className="text-discord-text-muted block px-2 py-1 text-xs font-bold tracking-wider uppercase">
              {cls?.label ?? "Spec"}
            </span>
            {classSpecs.map((s) => (
              <button
                key={s.token}
                type="button"
                onClick={() => {
                  onSetSpec(slot, s.token);
                  setSpecPickerOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition hover:bg-discord-elevated-hover ${
                  slot.specToken === s.token ? "font-semibold" : ""
                }`}
              >
                <img
                  src={wowIconUrl(s.icon)}
                  alt=""
                  className="h-4 w-4 rounded-[3px]"
                  draggable={false}
                />
                {s.label}
              </button>
            ))}
            {slot.specToken != null && (
              <button
                type="button"
                onClick={() => {
                  onSetSpec(slot, null);
                  setSpecPickerOpen(false);
                }}
                className="text-discord-text-muted w-full rounded px-2 py-1.5 text-left text-xs transition hover:bg-discord-elevated-hover hover:text-discord-text"
              >
                Clear spec
              </button>
            )}
            <div className="my-1 border-t border-black/20" />
            {classPickerOpen ? (
              <div className="flex flex-wrap gap-1 p-1">
                {expansion.classes.map((c) => (
                  <button
                    key={c.token}
                    type="button"
                    onClick={() => {
                      onSetClass(slot, c.token);
                      setSpecPickerOpen(false);
                      setClassPickerOpen(false);
                    }}
                    title={c.label}
                    className="rounded p-1 transition hover:bg-discord-elevated-hover"
                  >
                    <img
                      src={wowIconUrl(c.icon)}
                      alt={c.label}
                      className="h-5 w-5 rounded-[3px]"
                      draggable={false}
                    />
                  </button>
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setClassPickerOpen(true)}
                className="text-discord-text-muted w-full rounded px-2 py-1.5 text-left text-xs transition hover:bg-discord-elevated-hover hover:text-discord-text"
              >
                Change class…
              </button>
            )}
          </div>
        </>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label} from this slot`}
        className="text-discord-text-muted ml-auto rounded px-1 text-xs opacity-0 transition group-hover:opacity-100 hover:text-discord-text"
      >
        ✕
      </button>
    </div>
  );
}

// One empty slot — a recessed drop target that highlights while a drag is
// over it. Keyboard users reach the same operation through the roster
// drawer's click-to-place and each block's remove button.
function EmptySlot({
  dragActive,
  onDrop,
}: {
  dragActive: boolean;
  onDrop: () => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (!dragActive) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop();
      }}
      className={`bg-discord-base h-9 rounded-lg transition ${
        over && dragActive ? "ring-1 ring-discord-brand" : ""
      }`}
    />
  );
}

export function RaidCompCanvas({
  expansion,
  comp,
  dragPayload,
  onDragPayloadChange,
  onDropAt,
  onRemoveAt,
  onRemoveGroup,
  onSetSpec,
  onSetClass,
}: CanvasProps) {
  const bench = benchSlots(comp);
  const dragActive = dragPayload != null;
  const [draggingSlotKey, setDraggingSlotKey] = useState<string | null>(null);
  const [benchOver, setBenchOver] = useState(false);

  const slotDragProps = (slot: CompSlot, key: string) => ({
    slot,
    expansion,
    onSetSpec,
    onSetClass,
    dragging: draggingSlotKey === key,
    onDragStart: () => {
      setDraggingSlotKey(key);
      onDragPayloadChange({ source: "slot", slot });
    },
    onDragEnd: () => {
      setDraggingSlotKey(null);
      onDragPayloadChange(null);
    },
  });

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
            {...slotDragProps(slot, `${slot.groupIndex}:${slot.slotIndex}`)}
            onRemove={() => onRemoveAt({ groupIndex: g, slotIndex: i })}
          />
        ) : (
          <EmptySlot
            key={`empty:${g}:${i}`}
            dragActive={dragActive}
            onDrop={() => onDropAt({ kind: "slot", groupIndex: g, slotIndex: i })}
          />
        ),
      );
    }
    groups.push(
      <div key={g} className="bg-discord-base rounded-xl p-2">
        <div className="mb-1.5 flex items-center justify-between px-1">
          <span className="text-discord-text-muted text-xs font-bold tracking-wider uppercase">
            Group {g + 1}
          </span>
          {comp.groupCount > 1 && (
            <button
              type="button"
              onClick={() => onRemoveGroup(g)}
              aria-label={`Remove group ${g + 1} — its members move to the bench`}
              title="Remove group — members move to the bench"
              className="text-discord-text-muted rounded px-1 text-xs transition hover:text-discord-text"
            >
              ✕
            </button>
          )}
        </div>
        <div className="flex flex-col gap-1">{slotRows}</div>
        <div
          className="mt-1.5 flex min-h-6 items-center gap-1 rounded-lg px-1 py-0.5"
          title={groupBuffs.map((b) => b.label).join(", ") || undefined}
        >
          {groupBuffs.length > 0 ? (
            groupBuffs.map((b) => (
              <img
                key={b.id}
                src={wowIconUrl(b.icon)}
                alt={b.label}
                title={b.label}
                className="h-4 w-4 rounded-[3px]"
                draggable={false}
              />
            ))
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
      <div
        onDragOver={(e) => {
          if (!dragActive) return;
          e.preventDefault();
          setBenchOver(true);
        }}
        onDragLeave={() => setBenchOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setBenchOver(false);
          onDropAt({ kind: "bench" });
        }}
        className={`bg-discord-base rounded-xl p-2 transition ${
          benchOver && dragActive ? "ring-1 ring-discord-brand" : ""
        }`}
      >
        <span className="text-discord-text-muted px-1 pb-1.5 text-xs font-bold tracking-wider uppercase">
          Bench
        </span>
        {bench.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 p-1">
            {bench.map((slot) => (
              <div key={`bench:${slot.slotIndex}`} className="w-44">
                <CompBlock
                  {...slotDragProps(slot, `bench:${slot.slotIndex}`)}
                  onRemove={() =>
                    onRemoveAt({
                      groupIndex: BENCH_GROUP_INDEX,
                      slotIndex: slot.slotIndex,
                    })
                  }
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-discord-text-muted px-1 py-2 text-sm">
            {dragActive
              ? "Drop here to bench"
              : "Bench is empty — drag a placed member here to hold them for this comp."}
          </p>
        )}
      </div>
    </div>
  );
}