"use client";

// Onboarding & role-rules flow canvas — one admin-built graph of steps
// (question / condition / action / loop) wired together with edges that
// carry the branching conditions. Replaces the old fixed-waterfall
// question-only builder (guild-onboarding-questions-form.tsx and friends,
// now deleted): every step type, including "condition", is a regular node
// on the canvas (see guild-flow-node.tsx) — a condition step has no
// config of its own, its OUTGOING edges carry the conditions instead.

import "@xyflow/react/dist/style.css";

import {
  MarkerType,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import {
  GuildFlowEndNode,
  GuildFlowStartNode,
  GuildFlowStepNode,
} from "./guild-flow-node";
import { GuildFlowQuestionPanel } from "./guild-flow-question-panel";
import { GuildFlowConditionPanel } from "./guild-flow-condition-panel";
import { GuildFlowActionPanel } from "./guild-flow-action-panel";
import { GuildFlowLoopPanel } from "./guild-flow-loop-panel";
import { GuildFlowEdgePanel } from "./guild-flow-edge-panel";

export type StepType = "question" | "condition" | "action" | "loop";
export type QuestionType = "single_select" | "multi_select" | "free_text";
export type VarType = "text" | "choice" | "class" | "number" | "character";
export type ActionType =
  | "claim_characters"
  | "set_nickname"
  | "grant"
  | "dm";
export type ConditionType =
  | "always"
  | "answer_equals"
  | "var_equals"
  | "class_equals"
  | "level_between";

export interface StepOptionDraft {
  id: string;
  label: string;
  sortOrder: number;
}

export interface GrantDraft {
  // Client-local key only — blind-replaced on save, never referenced by
  // anything else, so it never needs to match a server id.
  id: string;
  discordRoleId: string | null;
  discordChannelId: string | null;
  channelType: "text" | "voice" | null;
}

// One flat draft struct for every step type — the fields that don't apply
// to a given step's type just sit unused, same convention the old
// QuestionDraft/EdgeDraft flattening used. See guild-flow-node.tsx for the
// canvas card that reads this shape.
export interface StepDraft {
  id: string;
  type: StepType;
  // Canvas title for non-question steps (questions show their prompt
  // instead) — GuildOnboardingStep.label.
  label: string;
  canvasX: number;
  canvasY: number;

  // --- question ---
  prompt: string;
  questionType: QuestionType;
  varName: string;
  varType: VarType;
  required: boolean;
  appendList: boolean;
  options: StepOptionDraft[];

  // --- action ---
  actionType: ActionType;
  namesVariable: string;
  classesVariable: string;
  nicknameTemplate: string;
  textTemplate: string;
  grants: GrantDraft[];

  // --- loop ---
  listVariable: string;
}

export interface EdgeDraft {
  id: string;
  // null = wired from the synthetic Start node.
  fromStepId: string | null;
  toStepId: string;
  conditionType: ConditionType;
  conditionOptionIds: string[];
  conditionValues: string[];
  conditionClasses: string[];
  conditionMinLevel?: number;
  conditionMaxLevel?: number;
}

const START_ID = "start";

const nodeTypes = {
  start: GuildFlowStartNode,
  step: GuildFlowStepNode,
  end: GuildFlowEndNode,
};

// The label shown on an edge's wire — the same text a condition would
// have carried as its own box in the old model.
export function edgeSummary(edge: EdgeDraft, steps: StepDraft[]): string {
  switch (edge.conditionType) {
    case "always":
      return "";
    case "answer_equals": {
      const from = steps.find((s) => s.id === edge.fromStepId);
      const labels = edge.conditionOptionIds
        .map(
          (id) => from?.options.find((o) => o.id === id)?.label ?? "(untitled)",
        )
        .filter(Boolean);
      return labels.length > 0 ? `= ${labels.join(", ")}` : "= ?";
    }
    case "var_equals":
      return edge.conditionValues.length > 0
        ? `var = ${edge.conditionValues.join(", ")}`
        : "var = ?";
    case "class_equals":
      return edge.conditionClasses.length > 0
        ? `class: ${edge.conditionClasses.join(", ")}`
        : "class: ?";
    case "level_between":
      return edge.conditionMinLevel != null && edge.conditionMaxLevel != null
        ? `level ${edge.conditionMinLevel}-${edge.conditionMaxLevel}`
        : "level: ?";
  }
}

function newOption(sortOrder: number): StepOptionDraft {
  return { id: crypto.randomUUID(), label: "", sortOrder };
}

function newStep(type: StepType, index: number): StepDraft {
  return {
    id: crypto.randomUUID(),
    type,
    label: "",
    canvasX: 120 + (index % 5) * 240,
    canvasY: 40 + Math.floor(index / 5) * 160,
    prompt: "",
    questionType: "single_select",
    varName: "",
    varType: "text",
    required: true,
    appendList: false,
    options: type === "question" ? [newOption(0), newOption(1)] : [],
    actionType: "claim_characters",
    namesVariable: "",
    classesVariable: "",
    nicknameTemplate: "",
    textTemplate: "",
    grants: [],
    listVariable: "",
  };
}

export function GuildFlowEditor({ guildId }: { guildId: string }) {
  const utils = api.useUtils();
  const flow = api.guild.onboardingFlow.useQuery({ guildId });
  const roles = api.guild.discordRoles.useQuery({ guildId });
  const channelsForGrants = api.guild.discordChannelsForGrants.useQuery({
    guildId,
  });
  const saveFlow = api.guild.saveOnboardingFlow.useMutation({
    onSuccess: () => utils.guild.onboardingFlow.invalidate({ guildId }),
  });

  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [edgeDrafts, setEdgeDrafts] = useState<EdgeDraft[]>([]);
  const [startPos, setStartPos] = useState({ x: -220, y: 120 });
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // Seed local draft state once from the server — same "don't yank an
  // admin's in-progress edits away on an unrelated refetch" concern the
  // rules editor addresses too. Only the first successful load populates
  // the canvas, not every refetch.
  const hasSeededRef = useRef(false);
  useEffect(() => {
    if (!flow.data || hasSeededRef.current) return;
    hasSeededRef.current = true;
    // Build the drafts as local constants and anchor the unsaved-diff
    // snapshot to exactly these: reading this render's `steps`/`edgeDrafts`
    // in a later effect would capture the still-empty pre-seed state and
    // flag the freshly-seeded flow as "Unsaved changes" from the start.
    const seedSteps: StepDraft[] = flow.data.steps.map((s) => ({
      id: s.id,
      type: s.type as StepType,
      label: s.label ?? "",
      canvasX: s.canvasX,
      canvasY: s.canvasY,
      prompt: s.prompt ?? "",
      questionType: (s.questionType as QuestionType | null) ?? "single_select",
      varName: s.varName ?? "",
      varType: (s.varType as VarType | null) ?? "text",
      required: s.required,
      appendList: s.appendList,
      options: s.options.map((o) => ({
        id: o.id,
        label: o.label,
        sortOrder: o.sortOrder,
      })),
      actionType: (s.actionType as ActionType | null) ?? "claim_characters",
      namesVariable: s.namesVariable ?? "",
      classesVariable: s.classesVariable ?? "",
      nicknameTemplate: s.nicknameTemplate ?? "",
      textTemplate: s.textTemplate ?? "",
      grants: s.grants.map((g) => ({
        id: crypto.randomUUID(),
        discordRoleId: g.discordRoleId,
        discordChannelId: g.discordChannelId,
        channelType: g.channelType as "text" | "voice" | null,
      })),
      listVariable: s.listVariable ?? "",
    }));
    const seedEdges: EdgeDraft[] = flow.data.edges.map((e) => ({
      id: crypto.randomUUID(),
      fromStepId: e.fromStepId,
      toStepId: e.toStepId,
      conditionType: e.conditionType as ConditionType,
      conditionOptionIds: e.conditionOptionIds,
      conditionValues: e.conditionValues,
      conditionClasses: e.conditionClasses,
      conditionMinLevel: e.conditionMinLevel ?? undefined,
      conditionMaxLevel: e.conditionMaxLevel ?? undefined,
    }));
    setSteps(seedSteps);
    setEdgeDrafts(seedEdges);
    savedSnapshotRef.current = { steps: seedSteps, edges: seedEdges };
  }, [flow.data]);
  function updateStep(id: string, patch: Partial<StepDraft>) {
    setSteps((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function deleteStep(id: string) {
    setSteps((ss) => ss.filter((s) => s.id !== id));
    setEdgeDrafts((es) =>
      es.filter((e) => e.fromStepId !== id && e.toStepId !== id),
    );
    setSelectedStepId((cur) => (cur === id ? null : cur));
  }

  function addStep(type: StepType) {
    const step = newStep(type, steps.length);
    setSteps((ss) => [...ss, step]);
    setSelectedEdgeId(null);
    setSelectedStepId(step.id);
  }

  function updateEdge(id: string, patch: Partial<EdgeDraft>) {
    setEdgeDrafts((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function deleteEdge(id: string) {
    setEdgeDrafts((es) => es.filter((e) => e.id !== id));
    setSelectedEdgeId((cur) => (cur === id ? null : cur));
  }

  // Purely cosmetic "dead end" markers: a single/multi-select question's
  // options that no outgoing edge covers (and no catch-all "always" edge
  // swallows) would otherwise just trail off into nothing on the canvas —
  // indistinguishable from a step someone forgot to wire up. Stub these as
  // a synthetic "End flow" node so a bare "No" branch reads as intentional.
  // Client-side only: never touches steps/edgeDrafts, never saved.
  const endStubs = useMemo(() => {
    const stubs: { id: string; stepId: string; label: string; index: number }[] =
      [];
    for (const step of steps) {
      if (step.type !== "question" || step.questionType === "free_text") {
        continue;
      }
      const outgoing = edgeDrafts.filter((e) => e.fromStepId === step.id);
      if (outgoing.some((e) => e.conditionType === "always")) continue;
      const covered = new Set(
        outgoing
          .filter((e) => e.conditionType === "answer_equals")
          .flatMap((e) => e.conditionOptionIds),
      );
      const uncovered = step.options.filter((o) => !covered.has(o.id));
      uncovered.forEach((o, i) => {
        stubs.push({
          id: `end-${step.id}-${o.id}`,
          stepId: step.id,
          label: o.label.trim() || "(untitled)",
          index: i,
        });
      });
    }
    return stubs;
  }, [steps, edgeDrafts]);

  const nodes: Node[] = useMemo(() => {
    const startNode: Node = {
      id: START_ID,
      type: "start",
      position: startPos,
      data: {},
      deletable: false,
    };
    const stepNodes: Node[] = steps.map((s) => ({
      id: s.id,
      type: "step",
      position: { x: s.canvasX, y: s.canvasY },
      data: { step: s },
      selected: s.id === selectedStepId,
    }));
    const endNodes: Node[] = endStubs.map((stub) => {
      const step = steps.find((s) => s.id === stub.stepId);
      return {
        id: stub.id,
        type: "end",
        position: {
          x: (step?.canvasX ?? 0) + 280,
          y: (step?.canvasY ?? 0) + stub.index * 56,
        },
        data: {},
        selectable: false,
        deletable: false,
        draggable: false,
      };
    });
    return [startNode, ...stepNodes, ...endNodes];
  }, [steps, startPos, selectedStepId, endStubs]);

  const edges: Edge[] = useMemo(() => {
    const arrow = { type: MarkerType.ArrowClosed, color: "#8b90a0" };
    const wireEdges: Edge[] = edgeDrafts.map((e) => ({
      id: e.id,
      source: e.fromStepId ?? START_ID,
      target: e.toStepId,
      label: edgeSummary(e, steps),
      selected: e.id === selectedEdgeId,
      style: {
        stroke: e.id === selectedEdgeId ? "#5865f2" : "#8b90a0",
        strokeWidth: 1.5,
      },
      labelStyle: { fill: "#949ba4", fontSize: 11 },
      labelBgStyle: { fill: "#2b2d31" },
      markerEnd: arrow,
    }));
    const endEdges: Edge[] = endStubs.map((stub) => ({
      id: `edge-${stub.id}`,
      source: stub.stepId,
      target: stub.id,
      label: `${stub.label} → End flow`,
      selectable: false,
      style: { stroke: "#6b7280", strokeWidth: 1, strokeDasharray: "4 3" },
      labelStyle: { fill: "#8b90a0", fontSize: 10, fontStyle: "italic" },
      labelBgStyle: { fill: "#2b2d31" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#6b7280" },
    }));
    return [...wireEdges, ...endEdges];
  }, [edgeDrafts, steps, selectedEdgeId, endStubs]);

  function posOf(id: string): { x: number; y: number } {
    if (id === START_ID) return startPos;
    const s = steps.find((ss) => ss.id === id);
    return s ? { x: s.canvasX, y: s.canvasY } : { x: 0, y: 0 };
  }

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        const { x, y } = change.position;
        if (change.id === START_ID) {
          setStartPos({ x, y });
          continue;
        }
        setSteps((ss) =>
          ss.map((s) => (s.id === change.id ? { ...s, canvasX: x, canvasY: y } : s)),
        );
      } else if (change.type === "remove" && change.id !== START_ID) {
        deleteStep(change.id);
      }
    }
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type === "remove") deleteEdge(change.id);
    }
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target || source === target) return;
      const from = posOf(source);
      const to = posOf(target);
      setEdgeDrafts((es) => [
        ...es,
        {
          id: crypto.randomUUID(),
          fromStepId: source === START_ID ? null : source,
          toStepId: target,
          conditionType: "always",
          conditionOptionIds: [],
          conditionValues: [],
          conditionClasses: [],
        },
      ]);
      void from;
      void to;
    },
    // posOf reads steps/startPos by closure — included so a freshly-
    // dragged connection always resolves against current positions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [steps, startPos],
  );

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.id === START_ID || node.type === "end") return;
    setSelectedEdgeId(null);
    setSelectedStepId(node.id);
  }, []);

  const onEdgeClick = useCallback((_: unknown, edge: Edge) => {
    setSelectedStepId(null);
    setSelectedEdgeId(edge.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedStepId(null);
    setSelectedEdgeId(null);
  }, []);

  const selectedStep = steps.find((s) => s.id === selectedStepId) ?? null;
  const selectedEdge = edgeDrafts.find((e) => e.id === selectedEdgeId) ?? null;
  const selectedEdgeFromStep = selectedEdge
    ? (steps.find((s) => s.id === selectedEdge.fromStepId) ?? null)
    : null;

  // Steps with no edge touching them at all — not blocked, just flagged,
  // same "heads up" role the old unwired-condition counter played (there
  // an edge could exist half-dragged; here an edge always has both ends
  // the moment it's created, so the equivalent gap is a freshly-added
  // step nobody's wired up yet).
  const unwiredCount = steps.filter(
    (s) => !edgeDrafts.some((e) => e.fromStepId === s.id || e.toStepId === s.id),
  ).length;

  // Unsaved-diff: compare current drafts against the last-seeded server
  // snapshot. Re-seeding only happens once (hasSeededRef), so this stays
  // accurate for the whole session rather than resetting on every
  // background refetch.
  const savedSnapshotRef = useRef<{ steps: StepDraft[]; edges: EdgeDraft[] } | null>(
    null,
  );
  useEffect(() => {
    if (flow.data && savedSnapshotRef.current === null) {
      // Captured once, right after the seeding effect above runs in the
      // same commit — cheap deep-equal via JSON, same trick the rules
      // editor's unsavedIndexes uses.
      savedSnapshotRef.current = { steps, edges: edgeDrafts };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.data]);
  useEffect(() => {
    if (saveFlow.isSuccess) savedSnapshotRef.current = { steps, edges: edgeDrafts };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveFlow.isSuccess]);

  const isDirty = useMemo(() => {
    if (!savedSnapshotRef.current) return false;
    return (
      JSON.stringify(steps) !== JSON.stringify(savedSnapshotRef.current.steps) ||
      JSON.stringify(edgeDrafts) !== JSON.stringify(savedSnapshotRef.current.edges)
    );
    // Re-check whenever drafts move OR a save just re-anchored the
    // snapshot (saveFlow.isSuccess flips the ref above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, edgeDrafts, saveFlow.isSuccess]);

  useEffect(() => {
    if (!isDirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [isDirty]);

  function handleSave() {
    saveFlow.mutate({
      guildId,
      steps: steps.map((s) => ({
        id: s.id,
        type: s.type,
        label: s.label.trim() === "" ? undefined : s.label.trim(),
        canvasX: s.canvasX,
        canvasY: s.canvasY,
        prompt: s.type === "question" ? s.prompt : undefined,
        questionType: s.type === "question" ? s.questionType : undefined,
        varName: s.type === "question" ? s.varName.trim() : undefined,
        varType: s.type === "question" ? s.varType : undefined,
        required: s.required,
        appendList: s.appendList,
        options:
          s.type === "question" && s.questionType !== "free_text"
            ? s.options.map((o, i) => ({ id: o.id, label: o.label, sortOrder: i }))
            : [],
        actionType: s.type === "action" ? s.actionType : undefined,
        namesVariable: s.namesVariable.trim() || undefined,
        classesVariable: s.classesVariable.trim() || undefined,
        nicknameTemplate: s.nicknameTemplate || undefined,
        textTemplate: s.textTemplate || undefined,
        grants:
          s.type === "action" && s.actionType === "grant"
            ? s.grants.map((g) => ({
                id: g.id,
                discordRoleId: g.discordRoleId,
                discordChannelId: g.discordChannelId,
                channelType: g.channelType,
              }))
            : [],
        listVariable: s.type === "loop" ? s.listVariable.trim() : undefined,
      })),
      edges: edgeDrafts.map((e) => ({
        fromStepId: e.fromStepId,
        toStepId: e.toStepId,
        conditionType: e.conditionType,
        conditionOptionIds: e.conditionOptionIds,
        conditionValues: e.conditionValues,
        conditionClasses: e.conditionClasses,
        conditionMinLevel: e.conditionMinLevel,
        conditionMaxLevel: e.conditionMaxLevel,
      })),
    });
  }

  if (flow.isLoading) {
    return <p className="text-discord-text-muted text-sm">Loading...</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="font-bold">Onboarding flow</h3>
        <p className="text-discord-text-muted text-sm">
          Build the whole onboarding walk as one graph: questions, branch
          conditions, actions (claim characters, grant roles/channels, set
          nickname, DM), and loops (for alts). Drag a connection from a
          step&apos;s right edge to another step&apos;s left edge to wire
          them together — click any wire to set its condition. Click a step
          to edit it.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => addStep("question")}
          className="bg-discord-elevated hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1.5 text-xs font-semibold"
        >
          + Fråga
        </button>
        <button
          type="button"
          onClick={() => addStep("condition")}
          className="bg-discord-elevated hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1.5 text-xs font-semibold"
        >
          + Villkor
        </button>
        <button
          type="button"
          onClick={() => addStep("action")}
          className="bg-discord-elevated hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1.5 text-xs font-semibold"
        >
          + Aktion
        </button>
        <button
          type="button"
          onClick={() => addStep("loop")}
          className="bg-discord-elevated hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1.5 text-xs font-semibold"
        >
          + Loop
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saveFlow.isPending}
          className="bg-discord-brand self-start rounded-full px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saveFlow.isPending ? "Saving..." : "Save flow"}
        </button>
        {unwiredCount > 0 && (
          <p className="text-discord-text-muted text-xs">
            {unwiredCount} step{unwiredCount === 1 ? "" : "s"} not connected
            to anything yet.
          </p>
        )}
        {isDirty && !saveFlow.isPending && (
          <p className="text-discord-text-muted text-xs">Unsaved changes</p>
        )}
        {saveFlow.error && (
          <p className="text-discord-red text-sm">{saveFlow.error.message}</p>
        )}
        {saveFlow.isSuccess && !saveFlow.isPending && !isDirty && (
          <p className="text-discord-green text-sm">Saved!</p>
        )}
      </div>

      <div className="flex items-start gap-3">
        <div className="h-[600px] flex-1 overflow-hidden rounded-xl bg-discord-elevated">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            colorMode="dark"
            fitView
          />
        </div>

        {selectedStep?.type === "question" && (
          <GuildFlowQuestionPanel
            step={selectedStep}
            onChange={(patch) => updateStep(selectedStep.id, patch)}
            onDelete={() => deleteStep(selectedStep.id)}
          />
        )}
        {selectedStep?.type === "condition" && (
          <GuildFlowConditionPanel
            step={selectedStep}
            onChange={(patch) => updateStep(selectedStep.id, patch)}
            onDelete={() => deleteStep(selectedStep.id)}
          />
        )}
        {selectedStep?.type === "action" && (
          <GuildFlowActionPanel
            step={selectedStep}
            steps={steps}
            discordRoles={roles.data}
            channelsForGrants={channelsForGrants.data}
            onChange={(patch) => updateStep(selectedStep.id, patch)}
            onDelete={() => deleteStep(selectedStep.id)}
          />
        )}
        {selectedStep?.type === "loop" && (
          <GuildFlowLoopPanel
            step={selectedStep}
            onChange={(patch) => updateStep(selectedStep.id, patch)}
            onDelete={() => deleteStep(selectedStep.id)}
          />
        )}
        {selectedEdge && (
          <GuildFlowEdgePanel
            edge={selectedEdge}
            steps={steps}
            fromStep={selectedEdgeFromStep}
            onChange={(patch) => updateEdge(selectedEdge.id, patch)}
            onDelete={() => deleteEdge(selectedEdge.id)}
          />
        )}
      </div>
    </div>
  );
}

// Re-exported so callers (e.g. the role-rules editor's answer-condition
// picker) can type the onboardingFlow query's question list without
// reaching into RouterOutputs themselves.
export type OnboardingQuestionRef =
  RouterOutputs["guild"]["onboardingFlow"]["onboardingQuestions"][number];
