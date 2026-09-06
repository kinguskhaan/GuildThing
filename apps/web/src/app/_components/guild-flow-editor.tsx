"use client";

// Onboarding & role-rules flow canvas — one admin-built graph of steps
// (question / condition / action / loop) wired together with edges that
// carry the branching conditions. Every step type, including "condition",
// is a regular node on the canvas (see guild-flow-node.tsx) — a condition
// step has no config of its own, its OUTGOING edges carry the conditions
// instead.
//
// The canvas auto-layouts (dagre, top-to-bottom) on every change instead of
// storing per-step coordinates: a step's place is its position in the
// graph, never a free X/Y an admin dragged it to. Nodes aren't draggable.
// A new connection is never hand-drawn either — drag a step type from the
// toolbar onto an existing node (appends it as that node's next step) or
// onto an existing connection (splices it into the middle of that
// connection) to wire it in; see handleDrop below.

import "@xyflow/react/dist/style.css";

import dagre from "@dagrejs/dagre";
import {
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";

import {
  GuildFlowEndNode,
  GuildFlowStartNode,
  GuildFlowStepNode,
  NEW_STEP_TYPES,
  stepSummary,
  titleFor,
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
  // Title for non-question steps (questions show their prompt instead) —
  // GuildOnboardingStep.label.
  label: string;

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
const NODE_WIDTH = 220;
const NODE_HEIGHT = 64;

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

function newStep(type: StepType): StepDraft {
  return {
    id: crypto.randomUUID(),
    type,
    label: "",
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

function emptyEdge(fromStepId: string | null, toStepId: string): EdgeDraft {
  return {
    id: crypto.randomUUID(),
    fromStepId,
    toStepId,
    conditionType: "always",
    conditionOptionIds: [],
    conditionValues: [],
    conditionClasses: [],
  };
}
// Flow order + true back-edges — the same preorder DFS the bot's
// onboardingFlowEngine uses (Start, outgoing edges in list order), with
// back-edge membership decided by DFS-stack semantics: an edge whose
// target is ON the stack when walked. NOT "target ordered earlier" — in a
// diamond (A→B→D, A→C→D) the merge C→D targets an earlier-ordered node
// but is a legal merge, and painting it as a ↺ loop would demand a
// condition the server happily accepts. The editor and the walker must
// agree on what a cycle is.
export function flowOrder(edgeDrafts: EdgeDraft[]): {
  order: Map<string, number>;
  backEdges: Set<string>;
} {
  const order = new Map<string, number>();
  const backEdges = new Set<string>();
  let next = 0;
  const outgoingByFrom = new Map<string, string[]>();
  for (const e of edgeDrafts) {
    const key = e.fromStepId ?? START_ID;
    const list = outgoingByFrom.get(key) ?? [];
    list.push(e.toStepId);
    outgoingByFrom.set(key, list);
  }
  const onStack = new Set<string>();
  const stack = [START_ID];
  while (stack.length > 0) {
    const id = stack[stack.length - 1]!;
    if (!onStack.has(id)) {
      onStack.add(id);
      if (id !== START_ID) order.set(id, next++);
    }
    const pendingChild = (outgoingByFrom.get(id) ?? []).find((child) => {
      if (onStack.has(child)) {
        backEdges.add(`${id}->${child}`);
        return false;
      }
      return !order.has(child);
    });
    if (pendingChild == null) {
      onStack.delete(id);
      stack.pop();
    } else {
      stack.push(pendingChild);
    }
  }
  return { order, backEdges };
}

// True when `edge` is one of the graph's DFS-stack cycles — the drawn ↺
// loop the save validation demands a condition for.
export function isBackEdge(edge: EdgeDraft, backEdges: Set<string>): boolean {
  if (edge.fromStepId == null) return false;
  return backEdges.has(`${edge.fromStepId}->${edge.toStepId}`);
}

// Auto-layout — top-to-bottom, dagre-computed. Runs on every render of the
// graph instead of reading stored coordinates; nodes carry no position of
// their own and aren't draggable (see the ReactFlow props below).
function layout(nodes: Node[], edges: { source: string; target: string }[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 56, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id) as { x: number; y: number };
    return {
      ...n,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    };
  });
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
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // End-flow stub the inspector's morph panel is open for (see endStubs).
  const [selectedStubId, setSelectedStubId] = useState<string | null>(null);
  // Cross-highlight: hovering a rail row lights its canvas node and vice
  // versa — the rail and the graph are one thing, never two lists.
  const [hoveredStepId, setHoveredStepId] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const flowWrapperRef = useRef<HTMLDivElement | null>(null);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);

  // Seed local draft state once from the server — same "don't yank an
  // admin's in-progress edits away on an unrelated refetch" concern the
  // rules editor addresses too. Only the first successful load populates
  // the canvas, not every refetch.
  const hasSeededRef = useRef(false);
  useEffect(() => {
    if (!flow.data || hasSeededRef.current) return;
    hasSeededRef.current = true;
    const seedSteps: StepDraft[] = flow.data.steps.map((s) => ({
      id: s.id,
      type: s.type as StepType,
      label: s.label ?? "",
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

  function updateEdge(id: string, patch: Partial<EdgeDraft>) {
    setEdgeDrafts((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function deleteEdge(id: string) {
    setEdgeDrafts((es) => es.filter((e) => e.id !== id));
    setSelectedEdgeId((cur) => (cur === id ? null : cur));
  }

  // Drop a step type onto an existing node — appends the new step as that
  // node's next step (an outgoing "always" edge). fromStepId null means
  // dropped on the Start pill.
  function appendStep(fromStepId: string | null, type: StepType) {
    const step = newStep(type);
    setSteps((ss) => [...ss, step]);
    setEdgeDrafts((es) => [...es, emptyEdge(fromStepId, step.id)]);
    setSelectedEdgeId(null);
    setSelectedStepId(step.id);
  }

  // Drop a step type onto an existing connection — splices it in the
  // middle: the original edge now points at the new step (keeping
  // whatever condition got you onto it), and a new unconditional edge
  // carries on from the new step to the original target.
  function insertOnEdge(edgeId: string, type: StepType) {
    const edge = edgeDrafts.find((e) => e.id === edgeId);
    if (!edge) return;
    const step = newStep(type);
    setSteps((ss) => [...ss, step]);
    setEdgeDrafts((es) => [
      ...es.map((e) => (e.id === edgeId ? { ...e, toStepId: step.id } : e)),
      emptyEdge(step.id, edge.toStepId),
    ]);
    setSelectedEdgeId(null);
    setSelectedStepId(step.id);
  }

  // Not a drag target — links the selected step to an already-existing
  // step (the merge/convergence case a fresh drag can't express, since
  // dragging only ever creates a NEW step).
  function linkExisting(fromStepId: string, toStepId: string) {
    const edge = emptyEdge(fromStepId, toStepId);
    setEdgeDrafts((es) => [...es, edge]);
    setSelectedStepId(null);
    setSelectedEdgeId(edge.id);
  }

  // Hand-drawn connection (React Flow's onConnect): the ↺ back-edge and the
  // merge both become a normal drag between handles. Back-edges are the
  // loop model — they get selected immediately so the inspector can demand
  // the condition that save validation requires.
  function connectEdges(source: string, target: string) {
    if (source === target) return;
    const already = edgeDrafts.some(
      (e) => (e.fromStepId ?? START_ID) === source && e.toStepId === target,
    );
    if (already) return;
    const edge = emptyEdge(source === START_ID ? null : source, target);
    setEdgeDrafts((es) => [...es, edge]);
    setSelectedStepId(null);
    setSelectedStubId(null);
    setSelectedEdgeId(edge.id);
  }

  // A dead-end stub clicked in the canvas: turn it into a real step of the
  // chosen type, wired where the stub was. The stub vanishes on its own —
  // the new "always" edge now covers that answer.
  function convertStub(stubId: string, type: StepType) {
    const stub = endStubs.find((s) => s.id === stubId);
    if (!stub) return;
    appendStep(stub.stepId, type);
    setSelectedStubId(null);
  }

  // Rail row click: select the step AND bring it into view — the ledger
  // and the graph are the same list, so browsing one is browsing both.
  function jumpToStep(stepId: string) {
    setSelectedEdgeId(null);
    setSelectedStubId(null);
    setSelectedStepId(stepId);
    const instance = rfInstanceRef.current;
    const node = instance?.getNode(stepId);
    if (!instance || !node) return;
    void instance.setCenter(
      node.position.x + NODE_WIDTH / 2,
      node.position.y + NODE_HEIGHT / 2,
      { zoom: Math.max(instance.getZoom(), 0.9), duration: 400 },
    );
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const type = e.dataTransfer.getData("application/step-type") as StepType;
    if (!type) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const nodeEl = el?.closest<HTMLElement>(".react-flow__node");
    const edgeEl = el?.closest<HTMLElement>(".react-flow__edge");
    const nodeId = nodeEl?.dataset.id;
    const edgeId = edgeEl?.dataset.id;
    if (nodeId) {
      appendStep(nodeId === START_ID ? null : nodeId, type);
    } else if (edgeId) {
      insertOnEdge(edgeId, type);
    } else {
      // Dropped on empty canvas: a seeded-but-unwired step. The rail flags
      // it until it's wired in — drawing first, connecting after.
      const step = newStep(type);
      setSteps((ss) => [...ss, step]);
      setSelectedEdgeId(null);
      setSelectedStepId(step.id);
    }
  }

  // "Dead end" markers: a single/multi-select question's options that no
  // outgoing edge covers (and no catch-all "always" edge swallows) would
  // otherwise trail off into nothing. Stubs render as a selectable "End
  // flow" node — clicking one opens the inspector's morph panel, which
  // converts it into a real step wired where the stub was. Never saved:
  // derived from steps/edgeDrafts on every render.
  const endStubs = useMemo(() => {
    const stubs: { id: string; stepId: string; label: string }[] = [];
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
      for (const o of step.options) {
        if (covered.has(o.id)) continue;
        stubs.push({
          id: `end-${step.id}-${o.id}`,
          stepId: step.id,
          label: o.label.trim() || "(untitled)",
        });
      }
    }
    return stubs;
  }, [steps, edgeDrafts]);

  const nodes: Node[] = useMemo(() => {
    const startNode: Node = {
      id: START_ID,
      type: "start",
      position: { x: 0, y: 0 },
      data: {},
      deletable: false,
      draggable: false,
    };
    const stepNodes: Node[] = steps.map((s) => ({
      id: s.id,
      type: "step",
      position: { x: 0, y: 0 },
      data: {
        step: s,
        hovered: hoveredStepId === s.id,
        onQuickAdd: (type: StepType) => appendStep(s.id, type),
      },
      selected: s.id === selectedStepId,
      draggable: false,
    }));
    const endNodes: Node[] = endStubs.map((stub) => ({
      id: stub.id,
      type: "end",
      position: { x: 0, y: 0 },
      data: { label: stub.label },
      selected: stub.id === selectedStubId,
      deletable: false,
      draggable: false,
    }));
    const graphEdges = [
      ...edgeDrafts.map((e) => ({ source: e.fromStepId ?? START_ID, target: e.toStepId })),
      ...endStubs.map((stub) => ({ source: stub.stepId, target: stub.id })),
    ];
    return layout([startNode, ...stepNodes, ...endNodes], graphEdges);
  }, [steps, selectedStepId, selectedStubId, hoveredStepId, edgeDrafts, endStubs]);

  const { order, backEdges } = useMemo(() => flowOrder(edgeDrafts), [edgeDrafts]);
  const edges: Edge[] = useMemo(() => {
    const BRANDED = "#5865f2";
    const WIRE = "#3d5a75"; // --schem-line-dim: forward wires stay quiet
    const LOOP = "#ffb000"; // --schem-amber: a drawn ↺ back-edge IS a loop
    const wireEdges: Edge[] = edgeDrafts.map((e) => {
      const back = isBackEdge(e, backEdges);
      const unconditional = e.conditionType === "always";
      // A back-edge without a condition can never be saved — show it as
      // the broken thing it is, amber and dashed, with a demand for one.
      const invalid = back && unconditional;
      const selected = e.id === selectedEdgeId;
      const stroke = selected ? BRANDED : invalid ? LOOP : back ? LOOP : WIRE;
      return {
        id: e.id,
        source: e.fromStepId ?? START_ID,
        target: e.toStepId,
        label: invalid
          ? `↺ ${edgeSummary(e, steps) || "condition required"}`
          : edgeSummary(e, steps) || (back ? "↺" : ""),
        selected,
        style: {
          stroke,
          strokeWidth: selected || back ? 2 : 1.5,
          strokeDasharray: invalid ? "6 4" : undefined,
        },
        labelStyle: {
          fill: invalid ? LOOP : back ? LOOP : "#949ba4",
          fontSize: 11,
          fontStyle: back ? "italic" : undefined,
          fontFamily: "var(--font-arcade-mono), monospace",
        },
        labelBgStyle: { fill: "#2b2d31" },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: selected ? BRANDED : back ? LOOP : WIRE,
        },
      };
    });
    const endEdges: Edge[] = endStubs.map((stub) => ({
      id: `edge-${stub.id}`,
      source: stub.stepId,
      target: stub.id,
      label: stub.label,
      selectable: false,
      style: { stroke: "#6b7280", strokeWidth: 1, strokeDasharray: "4 3" },
      labelStyle: { fill: "#8b90a0", fontSize: 10, fontStyle: "italic" },
      labelBgStyle: { fill: "#2b2d31" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#6b7280" },
    }));
    return [...wireEdges, ...endEdges];
  }, [edgeDrafts, steps, selectedEdgeId, endStubs, order, backEdges]);

  const onNodesChange = (changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === "remove" && change.id !== START_ID) {
        deleteStep(change.id);
      }
    }
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    for (const change of changes) {
      if (change.type === "remove") deleteEdge(change.id);
    }
  };

  const onNodeClick = (_: unknown, node: Node) => {
    if (node.id === START_ID) return;
    setSelectedEdgeId(null);
    // An "End flow" stub is selectable now — the inspector's morph panel
    // turns it into a real step (see convertStub).
    if (node.type === "end") {
      setSelectedStepId(null);
      setSelectedStubId(node.id);
      return;
    }
    setSelectedStubId(null);
    setSelectedStepId(node.id);
  };

  const onEdgeClick = (_: unknown, edge: Edge) => {
    if (!edgeDrafts.some((e) => e.id === edge.id)) return; // end-flow stub
    setSelectedStepId(null);
    setSelectedStubId(null);
    setSelectedEdgeId(edge.id);
  };

  const onPaneClick = () => {
    setSelectedStepId(null);
    setSelectedEdgeId(null);
    setSelectedStubId(null);
  };

  const selectedStep = steps.find((s) => s.id === selectedStepId) ?? null;
  const selectedEdge = edgeDrafts.find((e) => e.id === selectedEdgeId) ?? null;
  const selectedEdgeFromStep = selectedEdge
    ? (steps.find((s) => s.id === selectedEdge.fromStepId) ?? null)
    : null;
  const selectedStub = endStubs.find((s) => s.id === selectedStubId) ?? null;


  // Unsaved-diff: compare current drafts against the last-seeded server
  // snapshot. Re-seeding only happens once (hasSeededRef), so this stays
  // accurate for the whole session rather than resetting on every
  // background refetch.
  const savedSnapshotRef = useRef<{ steps: StepDraft[]; edges: EdgeDraft[] } | null>(
    null,
  );
  useEffect(() => {
    if (flow.data && savedSnapshotRef.current === null) {
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

  // The ledger: every step in true walk order (the same preorder the bot
  // uses), plus each branch's condition as an indented subrow — the rail
  // is the flow's table of contents, and the canvas is the same list drawn.
  const railSteps = [...steps].sort(
    (a, b) =>
      (order.get(a.id) ?? Number.POSITIVE_INFINITY) -
      (order.get(b.id) ?? Number.POSITIVE_INFINITY),
  );
  const statusChip = saveFlow.isPending
    ? { text: "SAVING ...", cls: "text-discord-text-muted" }
    : saveFlow.error
      ? { text: "ERROR", cls: "text-discord-red" }
      : isDirty
        ? { text: "UNSAVED", cls: "text-[color:var(--schem-amber)]" }
        : { text: "SAVED", cls: "text-[color:var(--schem-green)]" };

  return (
    <div className="flex h-[calc(100dvh-15rem)] min-h-[560px] flex-col">
      {/* ---- Toolbar: name, save state, palette, save ---- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-3">
        <h3 className="font-bold">Onboarding flow</h3>
        <span className={`schem-mono text-xs tracking-[0.14em] ${statusChip.cls}`}>
          ● {statusChip.text}
        </span>
        {saveFlow.error && (
          <span className="text-discord-red max-w-md truncate text-xs">
            {saveFlow.error.message}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setRailOpen((v) => !v)}
          className="bg-discord-elevated rounded-lg px-3 py-1.5 text-xs font-semibold lg:hidden"
        >
          Flow
        </button>
        {NEW_STEP_TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/step-type", t.value);
              e.dataTransfer.effectAllowed = "copy";
            }}
            className="bg-discord-elevated hover:bg-discord-elevated-hover cursor-grab rounded-full px-3 py-1.5 text-xs font-semibold active:cursor-grabbing"
            title="Drag onto the canvas — or straight onto a step or a connection"
          >
            + {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={handleSave}
          disabled={saveFlow.isPending}
          className="bg-discord-brand rounded-full px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saveFlow.isPending ? "Saving..." : "Save flow"}
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-stretch gap-3">
        {/* ---- Ledger rail: the flow's own table of contents ---- */}
        <aside
          className={`${railOpen ? "absolute inset-y-0 left-0 z-20 flex" : "hidden"} w-64 shrink-0 flex-col overflow-hidden rounded-xl bg-discord-elevated lg:static lg:flex`}
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {railSteps.length === 0 && (
              <p className="text-discord-text-muted p-2 text-sm">
                Empty flow. Drag a step type from the toolbar onto the canvas.
              </p>
            )}
            {railSteps.map((s, i) => {
              const branches = edgeDrafts.filter(
                (e) => e.fromStepId === s.id && e.conditionType !== "always",
              );
              const wired = edgeDrafts.some(
                (e) => e.fromStepId === s.id || e.toStepId === s.id,
              );
              return (
                <div key={s.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setHoveredStepId(s.id)}
                    onMouseLeave={() => setHoveredStepId(null)}
                    onClick={() => jumpToStep(s.id)}
                    className={`flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition ${
                      selectedStepId === s.id
                        ? "bg-discord-base shadow-[inset_2px_0_0_var(--schem-line)]"
                        : hoveredStepId === s.id
                          ? "bg-discord-base"
                          : "hover:bg-discord-base"
                    }`}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="schem-mono text-discord-text-muted text-[10px] tracking-[0.14em]">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="schem-kicker text-[10px] text-discord-text-muted">
                        {s.type === "question"
                          ? "QUESTION"
                          : s.type === "condition"
                            ? "BRANCH"
                            : s.type === "loop"
                              ? "LOOP"
                              : "ACTION"}
                      </span>
                      {!wired && (
                        <span className="text-[10px] font-semibold text-[color:var(--schem-amber)]">
                          unwired
                        </span>
                      )}
                    </span>
                    <span className="line-clamp-2 text-sm font-semibold">
                      {titleFor(s)}
                    </span>
                    <span className="text-discord-text-muted truncate text-xs">
                      {stepSummary(s)}
                    </span>
                  </button>
                  {branches.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => {
                        setSelectedStepId(null);
                        setSelectedStubId(null);
                        setSelectedEdgeId(e.id);
                      }}
                      className={`text-discord-text-muted ml-4 block w-[calc(100%-1rem)] truncate rounded-md border-l px-2 py-1 text-left text-xs ${
                        isBackEdge(e, backEdges)
                          ? "border-[color:var(--schem-amber)]"
                          : "border-black/20"
                      } hover:text-discord-text ${
                        selectedEdgeId === e.id
                          ? "text-discord-text"
                          : ""
                      }`}
                    >
                      {isBackEdge(e, backEdges) ? "↺ " : "↳ "}
                      {edgeSummary(e, steps) || "always"}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="border-black/20 border-t p-2">
            <p className="schem-kicker text-discord-text-muted px-1.5 pb-1.5 text-[10px]">
              Add step
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              {NEW_STEP_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/step-type", t.value);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  className="bg-discord-base hover:bg-discord-elevated-hover cursor-grab rounded-lg px-2 py-1.5 text-left text-xs font-semibold active:cursor-grabbing"
                >
                  + {t.label}
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* ---- Canvas ---- */}
        <div
          ref={flowWrapperRef}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          className="flow-canvas bg-discord-base relative min-w-0 flex-1 overflow-hidden rounded-xl border border-black/20"
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable
            isValidConnection={(c) =>
              c.source !== c.target &&
              !edgeDrafts.some(
                (e) =>
                  (e.fromStepId ?? START_ID) === c.source &&
                  e.toStepId === c.target,
              )
            }
            onConnect={(c) => {
              if (c.source && c.target) connectEdges(c.source, c.target);
            }}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onNodeMouseEnter={(_, node) => {
              if (node.type === "step") setHoveredStepId(node.id);
            }}
            onNodeMouseLeave={(_, node) => {
              if (node.type === "step") setHoveredStepId(null);
            }}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            onInit={(instance) => {
              rfInstanceRef.current = instance;
            }}
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.2}
          >
            <Controls position="bottom-right" showInteractive={false} />
          </ReactFlow>
        </div>

        {/* ---- Inspector: the selected thing's controls, docked right ---- */}
        {(selectedStep ?? selectedEdge ?? selectedStub) && (
          <aside className="max-md:absolute max-md:inset-x-3 max-md:bottom-3 max-md:z-20 max-md:max-h-[60%] flex w-72 shrink-0 flex-col gap-2 overflow-y-auto">
            {selectedStep && (
              <>
                {selectedStep.type === "question" && (
                  <GuildFlowQuestionPanel
                    step={selectedStep}
                    onChange={(patch) => updateStep(selectedStep.id, patch)}
                    onDelete={() => deleteStep(selectedStep.id)}
                  />
                )}
                {selectedStep.type === "condition" && (
                  <GuildFlowConditionPanel
                    step={selectedStep}
                    onChange={(patch) => updateStep(selectedStep.id, patch)}
                    onDelete={() => deleteStep(selectedStep.id)}
                  />
                )}
                {selectedStep.type === "action" && (
                  <GuildFlowActionPanel
                    step={selectedStep}
                    steps={steps}
                    discordRoles={roles.data}
                    channelsForGrants={channelsForGrants.data}
                    onChange={(patch) => updateStep(selectedStep.id, patch)}
                    onDelete={() => deleteStep(selectedStep.id)}
                  />
                )}
                {selectedStep.type === "loop" && (
                  <GuildFlowLoopPanel
                    step={selectedStep}
                    onChange={(patch) => updateStep(selectedStep.id, patch)}
                    onDelete={() => deleteStep(selectedStep.id)}
                  />
                )}
                <LinkExistingControl
                  fromStepId={selectedStep.id}
                  steps={steps}
                  onLink={(toStepId) => linkExisting(selectedStep.id, toStepId)}
                />
              </>
            )}
            {selectedEdge && (
              <>
                {isBackEdge(selectedEdge, backEdges) &&
                  selectedEdge.conditionType === "always" && (
                    <p className="rounded-lg border border-dashed border-[color:var(--schem-amber)] bg-discord-elevated p-3 text-xs text-[color:var(--schem-amber)]">
                      A back-edge (↺) needs a condition — otherwise the flow
                      loops forever and saving is refused.
                    </p>
                  )}
                <GuildFlowEdgePanel
                  edge={selectedEdge}
                  steps={steps}
                  fromStep={selectedEdgeFromStep}
                  onChange={(patch) => updateEdge(selectedEdge.id, patch)}
                  onDelete={() => deleteEdge(selectedEdge.id)}
                />
              </>
            )}
            {selectedStub && (
              <div className="bg-discord-elevated w-full rounded-xl border border-dashed border-discord-text-muted/40 p-4 text-sm">
                <p className="schem-kicker text-[10px] text-discord-text-muted">
                  END OF FLOW
                </p>
                <p className="mt-1 font-semibold">
                  &quot;{selectedStub.label}&quot;
                </p>
                <p className="text-discord-text-muted mt-1 text-xs">
                  This answer leads nowhere yet. Turn it into the next step:
                </p>
                <div className="mt-3 grid grid-cols-2 gap-1.5">
                  {NEW_STEP_TYPES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => convertStub(selectedStub.id, t.value)}
                      className="bg-discord-base hover:bg-discord-elevated-hover rounded-lg px-2 py-1.5 text-xs font-semibold"
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

// Linking to an ALREADY-EXISTING step (the merge/convergence case) isn't
// something a fresh drag can express — dragging a palette type always
// makes a new step. This is the one non-drag way to wire a connection.
function LinkExistingControl({
  fromStepId,
  steps,
  onLink,
}: {
  fromStepId: string;
  steps: StepDraft[];
  onLink: (toStepId: string) => void;
}) {
  const others = steps.filter((s) => s.id !== fromStepId);
  if (others.length === 0) return null;
  return (
    <select
      value=""
      onChange={(e) => {
        if (e.target.value) onLink(e.target.value);
      }}
      className="bg-discord-elevated hover:bg-discord-elevated-hover text-discord-text-muted w-72 shrink-0 rounded-full px-3 py-1.5 text-xs"
    >
      <option value="">Link to an existing step…</option>
      {others.map((s) => (
        <option key={s.id} value={s.id}>
          {titleFor(s)}
        </option>
      ))}
    </select>
  );
}

// Re-exported so callers (e.g. the role-rules editor's answer-condition
// picker) can type the onboardingFlow query's question list without
// reaching into RouterOutputs themselves.
export type OnboardingQuestionRef =
  RouterOutputs["guild"]["onboardingFlow"]["onboardingQuestions"][number];
