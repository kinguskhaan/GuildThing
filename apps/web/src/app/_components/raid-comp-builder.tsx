"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { wowIconUrl } from "@guildthing/wowhead-data";

import { ConfirmButton } from "~/app/_components/confirm-button";
import { classColor } from "~/lib/format";
import { api, type RouterOutputs } from "~/trpc/react";

import { RaidCompCanvas, type DragPayload, type DropTarget, type SlotRef } from "./raid-comp-canvas";
import { RaidCompCoverage } from "./raid-comp-coverage";
import { RaidCompRoles } from "./raid-comp-roles";
import {
  BENCH_GROUP_INDEX,
  benchSlots,
  expansionDef,
  firstEmptyGroupSlot,
  type CompSlot,
  type CompState,
} from "./raid-comp-state";

const MAX_GROUPS = 10;

type SaveState = "idle" | "saving" | "saved" | "error";

export function RaidCompBuilder({
  guildId,
  guildSlug,
  expansionId,
  bnetConfigured,
}: {
  guildId: string;
  guildSlug: string;
  expansionId: string;
  bnetConfigured: boolean;
}) {
  const expansion = expansionDef(expansionId);
  const roster = api.guild.rosterMembers.useQuery({ guildId });
  const comps = api.raidComp.list.useQuery({ guildId });

  const utils = api.useUtils();
  const createComp = api.raidComp.create.useMutation({
    onSuccess: (comp) => {
      setDraft(compToState(comp));
      setActiveCompId(comp.id);
      setDirty(false);
      void utils.raidComp.list.invalidate();
    },
  });
  const deleteComp = api.raidComp.delete.useMutation({
    onSuccess: (_data, vars) => {
      void utils.raidComp.list.invalidate();
      if (activeCompId === vars.compId) {
        setActiveCompId(null);
        setDraft(null);
      }
    },
  });
  const syncSpec = api.raidComp.syncSpec.useMutation({
    onSuccess: (data) => {
      // Patch the roster cache and the current draft directly so the
      // drawer and any placed block show the synced spec without a
      // refetch round-trip.
      if (!data.specToken || !data.rosterMemberId) return;
      utils.guild.rosterMembers.setData({ guildId }, (prev) =>
        prev?.map((m) =>
          m.id === data.rosterMemberId
            ? { ...m, spec: data.specToken, specSyncedAt: new Date() }
            : m,
        ),
      );
      setDraft((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          slots: prev.slots.map((s) =>
            s.rosterMemberId === data.rosterMemberId
              ? { ...s, specToken: data.specToken }
              : s,
          ),
        };
      });
    },
  });

  const [activeCompId, setActiveCompId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CompState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [dragPayload, setDragPayload] = useState<DragPayload | null>(null);
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState<string[]>([]);
  const [rankFilter, setRankFilter] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"groups" | "roles">("groups");

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // Adopt the loaded comps into the draft whenever the server state changes
  // and there are no unsaved local edits (e.g. first load, refetch after
  // create/delete, another officer's changes).
  useEffect(() => {
    if (!comps.data || dirtyRef.current) return;
    const current = comps.data.find((c) => c.id === activeCompId);
    if (current) {
      setDraft(compToState(current));
    } else if (comps.data.length > 0 && !activeCompId) {
      setActiveCompId(comps.data[0]!.id);
    }
  }, [comps.data, activeCompId]);

  // Autosave: debounce over the draft, skip while a save is in flight — the
  // success handler triggers a refetch, and the next dirty draft saves again.
  const saveComp = api.raidComp.save.useMutation({
    onSuccess: () => {
      setSaveState("saved");
      setDirty(false);
      void utils.raidComp.list.invalidate();
    },
    onError: () => setSaveState("error"),
  });
  useEffect(() => {
    if (!dirty || !draft || saveComp.isPending) return;
    const timer = setTimeout(() => {
      setSaveState("saving");
      saveComp.mutate({
        compId: draft.id,
        name: draft.name,
        groupCount: draft.groupCount,
        slots: draft.slots,
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [draft, dirty, saveComp]);

  const update = useCallback((fn: (prev: CompState) => CompState) => {
    setDraft((prev) => (prev ? fn(prev) : prev));
    setDirty(true);
  }, []);

  // Placement resolver: what happens when `payload` lands on `target`.
  // Displacing a filled block sends its occupant to the bench; dropping a
  // block back on the drawer (or the ✕ button) removes it from the comp.
  // Takes the payload as a parameter (rather than reading drag state) so
  // both native drag-and-drop and the drawer's click-to-place can call it
  // synchronously.
  const place = useCallback(
    (payload: DragPayload, target: DropTarget) => {
      let placed: CompSlot;
      if (payload.source === "roster") {
        const member = roster.data?.find((m) => m.id === payload.memberId);
        if (!member) return;
        placed = {
          groupIndex: -2,
          slotIndex: -2,
          rosterMemberId: member.id,
          characterName: member.name,
          classToken: member.class,
          specToken: member.spec,
        };
      } else if (payload.source === "placeholder") {
        // No roster link and no name — a stand-in for "we'll have a class
        // here" when the guild doesn't have (or hasn't imported) a
        // character for it yet. See CompBlock's `isPlaceholder`.
        placed = {
          groupIndex: -2,
          slotIndex: -2,
          rosterMemberId: null,
          characterName: null,
          classToken: payload.classToken,
          specToken: null,
        };
      } else {
        placed = { ...payload.slot };
      }

      if (target.kind === "drawer") {
        // Slot source: drop the block entirely. Roster source back on the
        // drawer is a no-op (the drawer is the "not in comp" state).
        if (payload.source === "slot") {
          update((prev) => ({
            ...prev,
            slots: prev.slots.filter(
              (s) =>
                !(
                  s.groupIndex === payload.slot.groupIndex &&
                  s.slotIndex === payload.slot.slotIndex
                ),
            ),
          }));
        }
        return;
      }

      const dest =
        target.kind === "bench"
          ? { groupIndex: BENCH_GROUP_INDEX, slotIndex: -1 }
          : { groupIndex: target.groupIndex, slotIndex: target.slotIndex };

      update((prev) => {
        // Drop the dragged block's old position (slot source) and any
        // existing placement of the same roster member (duplicate guard).
        let slots = prev.slots.filter((s) => {
          if (
            payload.source === "slot" &&
            s.groupIndex === payload.slot.groupIndex &&
            s.slotIndex === payload.slot.slotIndex
          ) {
            return false;
          }
          return !(
            placed.rosterMemberId != null &&
            s.rosterMemberId === placed.rosterMemberId
          );
        });
        // Displace whoever already occupies the target slot to the bench.
        if (target.kind === "slot") {
          slots = slots.map((s) =>
            s.groupIndex === dest.groupIndex && s.slotIndex === dest.slotIndex
              ? { ...s, groupIndex: BENCH_GROUP_INDEX, slotIndex: nextBenchIndex(slots) }
              : s,
          );
        }
        const finalDest =
          target.kind === "bench"
            ? { groupIndex: BENCH_GROUP_INDEX, slotIndex: nextBenchIndex(slots) }
            : dest;
        slots.push({ ...placed, ...finalDest });
        return { ...prev, slots };
      });

      if (
        payload.source === "roster" &&
        placed.rosterMemberId &&
        expansion.hasSpecs &&
        bnetConfigured &&
        !placed.specToken
      ) {
        syncSpec.mutate({ rosterMemberId: placed.rosterMemberId });
      }
    },
    [roster.data, update, syncSpec, expansion, bnetConfigured],
  );

  const dropAt = useCallback(
    (target: DropTarget) => {
      if (dragPayload) place(dragPayload, target);
      setDragPayload(null);
    },
    [dragPayload, place],
  );

  const placeFromDrawer = useCallback(
    (member: NonNullable<typeof roster.data>[number]) => {
      const target: DropTarget = draft
        ? (() => {
            const empty = firstEmptyGroupSlot(draft);
            return empty ? { kind: "slot" as const, ...empty } : { kind: "bench" as const };
          })()
        : { kind: "bench" as const };
      place(
        {
          source: "roster",
          memberId: member.id,
          name: member.name,
          classToken: member.class,
          specToken: member.spec,
        },
        target,
      );
    },
    [draft, place],
  );

  const placePlaceholder = useCallback(
    (classToken: string) => {
      const target: DropTarget = draft
        ? (() => {
            const empty = firstEmptyGroupSlot(draft);
            return empty ? { kind: "slot" as const, ...empty } : { kind: "bench" as const };
          })()
        : { kind: "bench" as const };
      place({ source: "placeholder", classToken }, target);
    },
    [draft, place],
  );

  const removeAt = useCallback(
    (ref: SlotRef) => {
      update((prev) => ({
        ...prev,
        slots: prev.slots.filter(
          (s) => !(s.groupIndex === ref.groupIndex && s.slotIndex === ref.slotIndex),
        ),
      }));
    },
    [update],
  );

  // Manual spec pin from a block's spec picker — updates the slot
  // snapshots and the roster cache immediately (same patch pattern as
  // syncSpec above), then persists to GuildRosterMember via the router.
  const setManualSpec = api.raidComp.setManualSpec.useMutation({
    onSuccess: (data) => {
      utils.guild.rosterMembers.setData({ guildId }, (prev) =>
        prev?.map((m) =>
          m.id === data.rosterMemberId
            ? {
                ...m,
                spec: data.specToken,
                specSyncedAt: data.specToken != null ? new Date() : null,
              }
            : m,
        ),
      );
    },
  });
  const handleSetSpec = useCallback(
    (slot: CompSlot, specToken: string | null) => {
      // Keyed by slot position, not rosterMemberId — placeholder (and any
      // stale, unlinked) slots all share rosterMemberId === null, and
      // matching on that would fan a single spec pick out to every one of
      // them.
      update((prev) => ({
        ...prev,
        slots: prev.slots.map((s) =>
          s.groupIndex === slot.groupIndex && s.slotIndex === slot.slotIndex
            ? { ...s, specToken }
            : s,
        ),
      }));
      if (!slot.rosterMemberId) return;
      utils.guild.rosterMembers.setData({ guildId }, (prev) =>
        prev?.map((m) =>
          m.id === slot.rosterMemberId
            ? {
                ...m,
                spec: specToken,
                specSyncedAt: specToken != null ? new Date() : null,
              }
            : m,
        ),
      );
      setManualSpec.mutate({ rosterMemberId: slot.rosterMemberId, specToken });
    },
    [update, setManualSpec, utils, guildId],
  );

  // Class override from a block's "Change class…" picker — updates the
  // slot snapshot only (the roster's class stays whatever the addon
  // imported; snapshots win for comp display per the data contract) and
  // clears the spec, since specs don't survive a class change.
  const handleSetClass = useCallback(
    (slot: CompSlot, classToken: string) => {
      // Same slot-position keying as handleSetSpec above.
      update((prev) => ({
        ...prev,
        slots: prev.slots.map((s) =>
          s.groupIndex === slot.groupIndex && s.slotIndex === slot.slotIndex
            ? { ...s, classToken, specToken: null }
            : s,
        ),
      }));
    },
    [update],
  );

  const removeGroup = useCallback(
    (groupIndex: number) => {
      update((prev) => {
        const evicted = prev.slots.filter((s) => s.groupIndex === groupIndex);
        const kept = prev.slots.filter((s) => s.groupIndex !== groupIndex);
        let benchNext = nextBenchIndex(kept);
        const rehomed = evicted.map((s) => ({
          ...s,
          groupIndex: BENCH_GROUP_INDEX,
          slotIndex: benchNext++,
        }));
        return {
          ...prev,
          groupCount: Math.max(1, prev.groupCount - 1),
          slots: [...kept, ...rehomed],
        };
      });
    },
    [update],
  );

  const addGroup = useCallback(() => {
    update((prev) => ({
      ...prev,
      groupCount: Math.min(MAX_GROUPS, prev.groupCount + 1),
    }));
  }, [update]);

  const renameComp = useCallback(
    (name: string) => {
      update((prev) => ({ ...prev, name }));
    },
    [update],
  );

  const placedMemberIds = useMemo(
    () =>
      new Set(
        (draft?.slots ?? [])
          .map((s) => s.rosterMemberId)
          .filter((id): id is string => id != null),
      ),
    [draft],
  );
  // Guild ranks as they appear on the roster, most common first then
  // alphabetical — the filter chips mirror that order so officers see the
  // ranks their guild actually uses. (Hooks order: kept above the early
  // returns below.)
  const distinctRanks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of roster.data ?? []) {
      if (m.rank == null) continue;
      counts.set(m.rank, (counts.get(m.rank) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([rank]) => rank);
  }, [roster.data]);

  if (comps.isLoading) {
    return (
      <div className="bg-discord-elevated rounded-xl p-8 text-center">
        <p className="text-discord-text-muted text-sm">Loading comps…</p>
      </div>
    );
  }

  if (comps.data && comps.data.length === 0) {
    return (
      <div className="bg-discord-elevated flex flex-col items-center gap-3 rounded-xl p-10 text-center">
        <h3 className="text-lg font-bold">No raid comps yet</h3>
        <p className="text-discord-text-muted max-w-sm text-sm">
          Build your raid night: snap roster members into {expansion.raidSize}-
          person group blocks, bench the rest, and watch the buff coverage
          fill in.
        </p>
        <button
          type="button"
          onClick={() =>
            createComp.mutate({ guildId, name: "Raid comp 1" })
          }
          disabled={createComp.isPending}
          className="bg-discord-brand rounded-full px-6 py-2 text-sm font-semibold text-white transition hover:bg-discord-brand-hover disabled:opacity-50"
        >
          Create raid comp
        </button>
      </div>
    );
  }

  const comp = draft;
  if (!comp) {
    return (
      <div className="bg-discord-elevated rounded-xl p-8 text-center">
        <p className="text-discord-text-muted text-sm">
          {comps.error ? comps.error.message : "Select a comp…"}
        </p>
      </div>
    );
  }

  const members = (roster.data ?? []).filter((m) => {
    const matchesSearch = m.name.toLowerCase().includes(search.toLowerCase());
    const matchesClass =
      classFilter.length === 0 || (m.class != null && classFilter.includes(m.class));
    const matchesRank =
      rankFilter.length === 0 || (m.rank != null && rankFilter.includes(m.rank));
    return matchesSearch && matchesClass && matchesRank;
  });

  return (
    <div className="flex w-full flex-col gap-3">
      {/* Comp bar: switcher, name, save state, delete */}
      <div className="flex flex-wrap items-center gap-2">
        {(comps.data ?? []).map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => {
              if (dirtyRef.current) return;
              setActiveCompId(c.id);
            }}
            title={
              dirtyRef.current && c.id !== activeCompId
                ? "Unsaved changes — wait for the save to finish before switching"
                : undefined
            }
            className={`rounded-full px-3 py-1.5 text-sm transition ${
              c.id === activeCompId
                ? "bg-discord-brand font-semibold text-white"
                : "bg-discord-elevated text-discord-text hover:bg-discord-elevated-hover"
            }`}
          >
            {c.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => createComp.mutate({ guildId, name: `Raid comp ${(comps.data?.length ?? 0) + 1}` })}
          disabled={createComp.isPending}
          className="bg-discord-elevated-hover text-discord-text-muted rounded-full px-3 py-1.5 text-sm transition hover:bg-discord-brand hover:text-white disabled:opacity-50"
        >
          + New comp
        </button>

        <div className="bg-discord-elevated-hover ml-auto flex rounded-full p-0.5">
          <button
            type="button"
            onClick={() => setViewMode("groups")}
            aria-pressed={viewMode === "groups"}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              viewMode === "groups"
                ? "bg-discord-brand text-white"
                : "text-discord-text-muted hover:text-discord-text"
            }`}
          >
            Groups
          </button>
          <button
            type="button"
            onClick={() => setViewMode("roles")}
            aria-pressed={viewMode === "roles"}
            className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
              viewMode === "roles"
                ? "bg-discord-brand text-white"
                : "text-discord-text-muted hover:text-discord-text"
            }`}
          >
            Roles
          </button>
        </div>
        <span className="bg-discord-rail text-discord-text-muted rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wider">
          {expansion.shortLabel} · {expansion.raidSize}-MAN
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={comp.name}
          onChange={(e) => renameComp(e.target.value)}
          aria-label="Comp name"
          className="bg-discord-elevated-hover text-discord-text w-56 rounded-full px-4 py-2 text-sm font-semibold"
        />
        <button
          type="button"
          onClick={addGroup}
          disabled={comp.groupCount >= MAX_GROUPS}
          className="bg-discord-elevated-hover rounded-full px-4 py-2 text-sm transition hover:bg-discord-elevated disabled:opacity-50"
        >
          Add group
        </button>
        <span
          className={`text-xs ${
            saveState === "error"
              ? "text-discord-red"
              : "text-discord-text-muted"
          }`}
          role={saveState === "error" ? "alert" : undefined}
        >
          {saveState === "saving" && "Saving…"}
          {saveState === "saved" && "Saved"}
          {saveState === "error" && "Couldn't save — retrying on next change"}
        </span>
        <div className="ml-auto">
          <ConfirmButton
            label="Delete comp"
            confirmLabel="Delete"
            description={`Delete "${comp.name}" and all its placements? This can't be undone.`}
            onConfirm={() => deleteComp.mutate({ compId: comp.id })}
            className="rounded-full bg-discord-elevated-hover px-4 py-2 text-sm transition hover:bg-discord-red"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[280px_1fr]">
        {/* Roster drawer */}
        <div
          onDragOver={(e) => {
            if (dragPayload?.source !== "slot") return;
            e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            dropAt({ kind: "drawer" });
          }}
          className="bg-discord-elevated flex flex-col gap-2 rounded-xl p-3"
        >
          <span className="text-discord-text-muted text-xs font-bold tracking-wider uppercase">
            Roster
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search roster…"
            aria-label="Search roster"
            className="bg-discord-elevated-hover placeholder:text-discord-text-muted w-full rounded-full px-4 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-1">
            {expansion.classes.map((cls) => {
              const active = classFilter.includes(cls.token);
              return (
                <button
                  key={cls.token}
                  type="button"
                  onClick={() =>
                    setClassFilter((prev) =>
                      prev.includes(cls.token)
                        ? prev.filter((t) => t !== cls.token)
                        : [...prev, cls.token],
                    )
                  }
                  aria-pressed={active}
                  title={cls.label}
                  className={`rounded p-1 transition ${
                    active ? "bg-discord-brand/30" : "hover:bg-discord-elevated-hover"
                  }`}
                >
                  <img
                    src={wowIconUrl(cls.icon)}
                    alt={cls.label}
                    className={`h-5 w-5 rounded-[3px] ${active ? "" : "opacity-80"}`}
                    draggable={false}
                  />
                </button>
              );
            })}
          </div>
          {distinctRanks.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {distinctRanks.map((rank) => {
                const active = rankFilter.includes(rank);
                return (
                  <button
                    key={rank}
                    type="button"
                    onClick={() =>
                      setRankFilter((prev) =>
                        prev.includes(rank)
                          ? prev.filter((r) => r !== rank)
                          : [...prev, rank],
                      )
                    }
                    aria-pressed={active}
                    title={`Filter by guild rank: ${rank}`}
                    className={`rounded-full px-2 py-0.5 text-xs transition ${
                      active
                        ? "bg-discord-brand font-semibold text-white"
                        : "bg-discord-elevated-hover text-discord-text-muted hover:text-discord-text"
                    }`}
                  >
                    {rank}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex flex-col gap-1 border-t border-black/10 pt-2">
            <span className="text-discord-text-muted text-xs font-bold tracking-wider uppercase">
              Add placeholder
            </span>
            <div className="flex flex-wrap gap-1">
              {expansion.classes.map((cls) => (
                <button
                  key={cls.token}
                  type="button"
                  draggable
                  onDragStart={() =>
                    setDragPayload({ source: "placeholder", classToken: cls.token })
                  }
                  onDragEnd={() => setDragPayload(null)}
                  onClick={() => placePlaceholder(cls.token)}
                  title={`Add a placeholder ${cls.label} — a slot to plan for a class you don't have a character for yet`}
                  className="rounded p-1 transition hover:bg-discord-elevated-hover"
                >
                  <img
                    src={wowIconUrl(cls.icon)}
                    alt={cls.label}
                    className="h-5 w-5 rounded-[3px] opacity-80"
                    draggable={false}
                  />
                </button>
              ))}
            </div>
          </div>
          <div className="flex max-h-[480px] flex-col gap-1 overflow-y-auto">
            {roster.isLoading && (
              <span className="text-discord-text-muted px-1 py-2 text-sm">
                Loading roster…
              </span>
            )}
            {!roster.isLoading && members.length === 0 && (
              <span className="text-discord-text-muted px-1 py-2 text-sm">
                No roster members{search ? " match that search" : ""} — import
                the addon export on the Members page.
              </span>
            )}
            {members.map((m) => {
              const placed = placedMemberIds.has(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  draggable={!placed}
                  onDragStart={() =>
                    setDragPayload({
                      source: "roster",
                      memberId: m.id,
                      name: m.name,
                      classToken: m.class,
                      specToken: m.spec,
                    })
                  }
                  onDragEnd={() => setDragPayload(null)}
                  onClick={() => {
                    if (placed) return;
                    placeFromDrawer(m);
                  }}
                  disabled={placed}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition ${
                    placed
                      ? "cursor-default opacity-40"
                      : "hover:bg-discord-elevated-hover"
                  }`}
                >
                  <img
                    src={wowIconUrl(
                      expansion.classes.find((c) => c.token === m.class)?.icon ??
                        "inv_misc_questionmark",
                    )}
                    alt=""
                    className="h-[18px] w-[18px] shrink-0 rounded-[3px]"
                    draggable={false}
                  />
                  <span
                    className="truncate text-sm font-semibold"
                    style={{ color: m.class ? classColor(m.class) : undefined }}
                  >
                    {m.name}
                  </span>
                  {placed && (
                    <span className="text-discord-text-muted text-xs">in comp</span>
                  )}
                  {m.spec && (
                    <span className="text-discord-text-muted truncate text-xs">
                      {expansion.specs.find((s) => s.token === m.spec)?.label ?? m.spec}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Block wall (groups) / role buckets (roles) + coverage */}
        <div className="flex flex-col gap-3">
          {viewMode === "groups" ? (
            <RaidCompCanvas
              expansion={expansion}
              comp={comp}
              dragPayload={dragPayload}
              onDragPayloadChange={setDragPayload}
              onDropAt={dropAt}
              onRemoveAt={removeAt}
              onRemoveGroup={removeGroup}
              onSetSpec={handleSetSpec}
              onSetClass={handleSetClass}
            />
          ) : (
            <RaidCompRoles
              expansion={expansion}
              comp={comp}
              onRemoveAt={removeAt}
              onSetSpec={handleSetSpec}
              onSetClass={handleSetClass}
            />
          )}
          <RaidCompCoverage expansion={expansion} comp={comp} />
        </div>
      </div>
    </div>
  );
}

// --- state plumbing ---------------------------------------------------------

type CompRow = RouterOutputs["raidComp"]["list"][number];

function compToState(comp: CompRow): CompState {
  return {
    id: comp.id,
    name: comp.name,
    groupCount: comp.groupCount,
    slots: comp.slots.map((s) => ({
      groupIndex: s.groupIndex,
      slotIndex: s.slotIndex,
      rosterMemberId: s.rosterMemberId,
      characterName: s.characterName,
      classToken: s.classToken,
      specToken: s.specToken,
    })),
  };
}

function nextBenchIndex(slots: CompSlot[]): number {
  return slots
    .filter((s) => s.groupIndex === BENCH_GROUP_INDEX)
    .reduce((max, s) => Math.max(max, s.slotIndex + 1), 0);
}