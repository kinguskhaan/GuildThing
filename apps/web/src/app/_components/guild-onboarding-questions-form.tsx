"use client";

import "@xyflow/react/dist/style.css";

import {
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type Connection,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import {
  GuildOnboardingBuiltinNode,
  GuildOnboardingConditionNode,
  GuildOnboardingQuestionNode,
  GuildOnboardingStartNode,
} from "./guild-onboarding-question-node";
import { GuildOnboardingQuestionPanel } from "./guild-onboarding-question-panel";
import { GuildOnboardingEdgePanel } from "./guild-onboarding-edge-panel";

export type QuestionType = "single_select" | "multi_select" | "free_text";

export interface OptionDraft {
  id: string;
  label: string;
  sortOrder: number;
}

export interface QuestionDraft {
  id: string;
  prompt: string;
  type: QuestionType;
  // Optional questions offer a "Skip" choice in Discord — see
  // onboardingQuestions.ts in the bot for how a skip is handled.
  required: boolean;
  canvasX: number;
  canvasY: number;
  options: OptionDraft[];
}

// A condition is its own draggable box on the canvas (see
// GuildOnboardingConditionNode) with two handles — you wire a question (or
// Start) into its left side and a question out its right side yourself,
// same as connecting two questions directly. undefined means "not wired
// yet" (only possible client-side, mid-edit); null for fromQuestionId
// specifically means "wired from Start". Only conditions with both ends
// wired are included when saving — see handleSave.
export interface EdgeDraft {
  // Client-only id, only used to key this condition within this session —
  // conditions have no history to preserve, saveOnboardingFlow blind-
  // replaces them every time, so this never needs to match anything
  // server-side.
  id: string;
  fromQuestionId: string | null | undefined;
  toQuestionId: string | undefined;
  conditionType: "always" | "answer_equals" | "class_equals" | "level_between";
  // OR sets — "answer_equals" fires if the given answer includes ANY of
  // conditionOptionIds; "class_equals" fires if the resolved class is ANY
  // of conditionClasses.
  conditionOptionIds: string[];
  conditionClasses: string[];
  conditionMinLevel?: number;
  conditionMaxLevel?: number;
  // Canvas position, session-local only (like Start's) — not persisted,
  // since GuildOnboardingEdge has no position columns server-side.
  canvasX: number;
  canvasY: number;
}

const START_ID = "start";

const nodeTypes = {
  question: GuildOnboardingQuestionNode,
  start: GuildOnboardingStartNode,
  builtin: GuildOnboardingBuiltinNode,
  condition: GuildOnboardingConditionNode,
};

// What always happens after this graph finishes, regardless of which path
// through it someone took — not wired to any particular question, since
// every leaf question leads here the same way. Fixed, so a module-level
// constant rather than component state/memo.
const AFTER_STEP_LABELS = ["Alts (loop)", "Nickname"];

export function conditionSummary(
  edge: EdgeDraft,
  questions: QuestionDraft[],
): string {
  if (edge.conditionType === "class_equals") {
    return edge.conditionClasses.length > 0
      ? `Class: ${edge.conditionClasses.join(", ")}`
      : "Class: ?";
  }
  if (edge.conditionType === "answer_equals") {
    const fromQuestion = questions.find((q) => q.id === edge.fromQuestionId);
    const labels = edge.conditionOptionIds
      .map((id) => fromQuestion?.options.find((o) => o.id === id)?.label ?? "(untitled)")
      .filter(Boolean);
    return labels.length > 0 ? `= ${labels.join(", ")}` : "= ?";
  }
  if (edge.conditionType === "level_between") {
    return edge.conditionMinLevel != null && edge.conditionMaxLevel != null
      ? `Level ${edge.conditionMinLevel}-${edge.conditionMaxLevel}`
      : "Level: ?";
  }
  return "Always";
}

type RoleRule = RouterOutputs["guild"]["discordRoleConfig"]["rules"][number];

// One human-readable line per condition, e.g. "rank equals Officer" or
// "level between 10-20" — same field/operator shape guild-role-rules-form
// itself uses, just rendered as plain text here instead of an editable row.
function ruleConditionText(c: RoleRule["conditions"][number]): string {
  if (c.operator === "between") {
    return `${c.field} between ${c.minNumber ?? "?"}-${c.maxNumber ?? "?"}`;
  }
  return `${c.field} equals ${c.textValue ?? "?"}`;
}

// Read-only — an admin building questions can see what Role Rules already
// grant, for context, without leaving this tab. Not connected to the
// canvas or the graph in any way; editing Role Rules still only happens on
// the separate "Role rules" tab.
function RoleRulesReference({
  rules,
  discordRoles,
}: {
  rules: RoleRule[];
  discordRoles: { id: string; name: string }[] | undefined;
}) {
  if (rules.length === 0) return null;

  function roleName(discordRoleId: string): string {
    return discordRoles?.find((r) => r.id === discordRoleId)?.name ?? discordRoleId;
  }

  return (
    <details className="bg-discord-elevated rounded-xl p-4 text-sm">
      <summary className="cursor-pointer font-bold">
        Existing role rules ({rules.length}) — for reference, edit on the
        &quot;Role rules&quot; tab
      </summary>
      <ul className="text-discord-text-muted mt-3 flex flex-col gap-2">
        {rules.map((rule) => (
          <li key={rule.id} className="border-t border-black/10 pt-2 first:border-0 first:pt-0">
            <span className="text-discord-text font-semibold">
              {rule.label ?? "(unlabeled rule)"}
            </span>
            {rule.conditions.length > 0 && (
              <> — {rule.conditions.map(ruleConditionText).join(" AND ")}</>
            )}
            <br />
            grants{" "}
            {rule.grantedRoles.length > 0
              ? rule.grantedRoles.map((r) => roleName(r.discordRoleId)).join(", ")
              : "no roles"}
            {rule.grantedChannels.length > 0 &&
              ` · ${rule.grantedChannels.length} channel${rule.grantedChannels.length === 1 ? "" : "s"}`}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function GuildOnboardingQuestionsForm({
  guildId,
  pugEnabled,
  rosterSource,
  rules,
  discordRoles,
}: {
  guildId: string;
  pugEnabled: boolean;
  rosterSource: "addon" | "onboarding";
  rules: RoleRule[];
  discordRoles: { id: string; name: string }[] | undefined;
}) {
  const utils = api.useUtils();
  const flow = api.guild.onboardingFlow.useQuery({ guildId });
  const saveFlow = api.guild.saveOnboardingFlow.useMutation({
    onSuccess: () => utils.guild.onboardingFlow.invalidate({ guildId }),
  });

  const [questions, setQuestions] = useState<QuestionDraft[]>([]);
  const [edgeDrafts, setEdgeDrafts] = useState<EdgeDraft[]>([]);
  const [startPos, setStartPos] = useState({ x: -220, y: 120 });
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(
    null,
  );
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // Seed local draft state once from the server, same "don't yank an
  // admin's in-progress edits away on an unrelated refetch" concern
  // hasAutoSelected addresses elsewhere in the rules tab — only the first
  // successful load populates the canvas, not every refetch.
  const hasSeededRef = useRef(false);
  useEffect(() => {
    if (!flow.data || hasSeededRef.current) return;
    hasSeededRef.current = true;
    setQuestions(
      flow.data.questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        type: q.type as QuestionType,
        required: q.required,
        canvasX: q.canvasX,
        canvasY: q.canvasY,
        options: q.options.map((o) => ({
          id: o.id,
          label: o.label,
          sortOrder: o.sortOrder,
        })),
      })),
    );
    // Conditions have no saved position — place each one at the midpoint
    // of the question(s) it connects, a reasonable one-time layout guess;
    // freely draggable afterward, just not remembered across reloads.
    const posById = new Map(
      flow.data.questions.map((q) => [q.id, { x: q.canvasX, y: q.canvasY }]),
    );
    setEdgeDrafts(
      flow.data.edges.map((e) => {
        const fromPos = e.fromQuestionId
          ? (posById.get(e.fromQuestionId) ?? startPos)
          : startPos;
        const toPos = posById.get(e.toQuestionId) ?? fromPos;
        return {
          id: crypto.randomUUID(),
          fromQuestionId: e.fromQuestionId,
          toQuestionId: e.toQuestionId,
          conditionType: e.conditionType as EdgeDraft["conditionType"],
          conditionOptionIds: e.conditionOptions.map((co) => co.optionId),
          conditionClasses: e.conditionClasses.map((cc) => cc.class),
          conditionMinLevel: e.conditionMinLevel ?? undefined,
          conditionMaxLevel: e.conditionMaxLevel ?? undefined,
          canvasX: (fromPos.x + toPos.x) / 2,
          canvasY: (fromPos.y + toPos.y) / 2,
        };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.data]);

  function updateQuestion(id: string, patch: Partial<QuestionDraft>) {
    setQuestions((qs) => qs.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  }

  function deleteQuestion(id: string) {
    setQuestions((qs) => qs.filter((q) => q.id !== id));
    setEdgeDrafts((es) =>
      es.filter((e) => e.fromQuestionId !== id && e.toQuestionId !== id),
    );
    setSelectedQuestionId((cur) => (cur === id ? null : cur));
  }

  function addQuestion() {
    const id = crypto.randomUUID();
    setQuestions((qs) => [
      ...qs,
      {
        id,
        prompt: "",
        type: "single_select",
        required: true,
        canvasX: 120 + (qs.length % 5) * 220,
        canvasY: 40 + Math.floor(qs.length / 5) * 160,
        options: [
          { id: crypto.randomUUID(), label: "", sortOrder: 0 },
          { id: crypto.randomUUID(), label: "", sortOrder: 1 },
        ],
      },
    ]);
    setSelectedEdgeId(null);
    setSelectedQuestionId(id);
  }

  function updateEdge(id: string, patch: Partial<EdgeDraft>) {
    setEdgeDrafts((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function deleteEdge(id: string) {
    setEdgeDrafts((es) => es.filter((e) => e.id !== id));
    setSelectedEdgeId((cur) => (cur === id ? null : cur));
  }

  // Drops a fresh, unwired condition onto the canvas — nothing plugged
  // into either side yet. Drag a wire from a question (or Start) into its
  // left handle, and one from its right handle out to a question, same as
  // wiring two questions together directly. The edit panel (opened
  // immediately) also has From/To pickers, for wiring without dragging.
  function addCondition() {
    const id = crypto.randomUUID();
    setEdgeDrafts((es) => [
      ...es,
      {
        id,
        fromQuestionId: undefined,
        toQuestionId: undefined,
        conditionType: "always",
        conditionOptionIds: [],
        conditionClasses: [],
        canvasX: startPos.x + 160,
        canvasY: startPos.y + 220,
      },
    ]);
    setSelectedQuestionId(null);
    setSelectedEdgeId(id);
  }

  // Fixed steps runOnboarding (apps/bot/src/onboarding.ts) always asks
  // outside this admin-built graph, in the order they actually happen —
  // PUG-or-member first (only if the guild has PUGs enabled), then the
  // character name, then class (only for guilds with no addon to scan it
  // from). Purely informational: not editable, connectable, or saved.
  const beforeStepLabels = useMemo(() => {
    const labels: string[] = [];
    if (pugEnabled) labels.push("PUG or member?");
    labels.push("Character name");
    if (rosterSource === "onboarding") labels.push("Class");
    return labels;
  }, [pugEnabled, rosterSource]);

  const nodes: Node[] = useMemo(() => {
    const startNode: Node = {
      id: START_ID,
      type: "start",
      position: startPos,
      data: {},
      deletable: false,
    };
    const questionNodes: Node[] = questions.map((q) => ({
      id: q.id,
      type: "question",
      position: { x: q.canvasX, y: q.canvasY },
      data: { question: q },
      selected: q.id === selectedQuestionId,
    }));
    const conditionNodes: Node[] = edgeDrafts.map((e) => ({
      id: e.id,
      type: "condition",
      position: { x: e.canvasX, y: e.canvasY },
      data: { label: conditionSummary(e, questions) },
      selected: e.id === selectedEdgeId,
    }));

    // Waterfall, top to bottom, straight into Start — same x as Start, one
    // row per fixed step, closest one directly above it.
    const beforeIds = beforeStepLabels.map((_, i) => `builtin-before-${i}`);
    const beforeNodes: Node[] = beforeStepLabels.map((label, i) => ({
      id: beforeIds[i]!,
      type: "builtin",
      position: {
        x: startPos.x,
        y: startPos.y - (beforeStepLabels.length - i) * 90,
      },
      data: { label },
      draggable: false,
      selectable: false,
      deletable: false,
    }));

    // A second, separate waterfall for what always happens afterward — not
    // connected to Start or to any question (every path through the graph
    // leads here the same way, so there's no single node to hang it off
    // of), placed clear of the question graph with its own "Then, always"
    // caption instead of a misleading connection.
    const maxQuestionX =
      questions.length > 0 ? Math.max(...questions.map((q) => q.canvasX)) : startPos.x;
    const afterX = maxQuestionX + 320;
    const afterIds = AFTER_STEP_LABELS.map((_, i) => `builtin-after-${i}`);
    const afterHeaderNode: Node = {
      id: "builtin-after-header",
      type: "builtin",
      position: { x: afterX, y: startPos.y - 60 },
      data: { label: "↓ Then, always:", muted: true },
      draggable: false,
      selectable: false,
      deletable: false,
    };
    const afterNodes: Node[] = AFTER_STEP_LABELS.map((label, i) => ({
      id: afterIds[i]!,
      type: "builtin",
      position: { x: afterX, y: startPos.y + i * 90 },
      data: { label },
      draggable: false,
      selectable: false,
      deletable: false,
    }));

    return [
      ...beforeNodes,
      startNode,
      ...questionNodes,
      ...conditionNodes,
      afterHeaderNode,
      ...afterNodes,
    ];
  }, [questions, edgeDrafts, startPos, selectedQuestionId, selectedEdgeId, beforeStepLabels]);

  // Plain, unlabeled wire segments — one from a condition's source into it,
  // one from it out to its target, only rendered once that side is
  // actually wired. The condition's own node carries the label now, not
  // the wire.
  const edges: Edge[] = useMemo(() => {
    const arrow = { type: MarkerType.ArrowClosed, color: "#8b90a0" };
    const wireStyle = { stroke: "#8b90a0", strokeWidth: 1.5 };
    const wires: Edge[] = [];
    for (const e of edgeDrafts) {
      if (e.fromQuestionId !== undefined) {
        wires.push({
          id: `wire-in-${e.id}`,
          source: e.fromQuestionId ?? START_ID,
          target: e.id,
          selectable: false,
          deletable: false,
          style: wireStyle,
          markerEnd: arrow,
        });
      }
      if (e.toQuestionId !== undefined) {
        wires.push({
          id: `wire-out-${e.id}`,
          source: e.id,
          target: e.toQuestionId,
          selectable: false,
          deletable: false,
          style: wireStyle,
          markerEnd: arrow,
        });
      }
    }

    const dashedStyle = { stroke: "#8b90a0", strokeDasharray: "4 3", strokeWidth: 1.5 };
    const beforeChain = [
      ...beforeStepLabels.map((_, i) => `builtin-before-${i}`),
      START_ID,
    ];
    const builtinEdges: Edge[] = beforeChain.slice(0, -1).map((id, i) => ({
      id: `builtin-before-edge-${i}`,
      source: id,
      target: beforeChain[i + 1]!,
      selectable: false,
      deletable: false,
      style: dashedStyle,
      markerEnd: arrow,
    }));
    const afterIds = AFTER_STEP_LABELS.map((_, i) => `builtin-after-${i}`);
    for (let i = 0; i < afterIds.length - 1; i++) {
      builtinEdges.push({
        id: `builtin-after-edge-${i}`,
        source: afterIds[i]!,
        target: afterIds[i + 1]!,
        selectable: false,
        deletable: false,
        style: dashedStyle,
        markerEnd: arrow,
      });
    }

    return [...builtinEdges, ...wires];
  }, [edgeDrafts, beforeStepLabels]);

  function posOf(id: string): { x: number; y: number } {
    if (id === START_ID) return startPos;
    const q = questions.find((qq) => qq.id === id);
    if (q) return { x: q.canvasX, y: q.canvasY };
    const e = edgeDrafts.find((ee) => ee.id === id);
    return e ? { x: e.canvasX, y: e.canvasY } : { x: 0, y: 0 };
  }

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    for (const change of changes) {
      if (change.type === "position" && change.position) {
        const { x, y } = change.position;
        if (change.id === START_ID) {
          setStartPos({ x, y });
          continue;
        }
        // A position change always targets either a question or a
        // condition, never both — mapping over both lists and only
        // touching the matching id is simplest, the non-matching .map()
        // just no-ops.
        setQuestions((qs) =>
          qs.map((q) => (q.id === change.id ? { ...q, canvasX: x, canvasY: y } : q)),
        );
        setEdgeDrafts((es) =>
          es.map((e) => (e.id === change.id ? { ...e, canvasX: x, canvasY: y } : e)),
        );
      } else if (change.type === "remove" && change.id !== START_ID) {
        deleteQuestion(change.id);
        deleteEdge(change.id);
      }
    }
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target) return;
      if (source === target) return;

      setEdgeDrafts((es) => {
        const isConditionId = (id: string) => es.some((e) => e.id === id);

        if (isConditionId(target)) {
          // Wiring INTO an existing condition's left handle replaces
          // whatever was plugged in there before.
          return es.map((e) =>
            e.id === target
              ? { ...e, fromQuestionId: source === START_ID ? null : source }
              : e,
          );
        }
        if (isConditionId(source)) {
          // Wiring OUT of an existing condition's right handle replaces
          // its previous target.
          return es.map((e) => (e.id === source ? { ...e, toQuestionId: target } : e));
        }

        // Direct question/Start -> question drag — auto-creates a fully-
        // wired "Always" condition at the midpoint, so the common
        // unconditioned case doesn't need a separate "+ Add condition"
        // step first.
        const from = posOf(source);
        const to = posOf(target);
        return [
          ...es,
          {
            id: crypto.randomUUID(),
            fromQuestionId: source === START_ID ? null : source,
            toQuestionId: target,
            conditionType: "always",
            conditionOptionIds: [],
            conditionClasses: [],
            canvasX: (from.x + to.x) / 2,
            canvasY: (from.y + to.y) / 2,
          },
        ];
      });
    },
    // posOf reads questions/edgeDrafts/startPos by closure — included so a
    // freshly-dragged direct connection always uses current positions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [questions, startPos],
  );

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    if (node.id === START_ID || node.type === "builtin") return;
    if (node.type === "condition") {
      setSelectedQuestionId(null);
      setSelectedEdgeId(node.id);
      return;
    }
    setSelectedEdgeId(null);
    setSelectedQuestionId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedQuestionId(null);
    setSelectedEdgeId(null);
  }, []);

  const selectedQuestion = questions.find((q) => q.id === selectedQuestionId) ?? null;
  const selectedEdge = edgeDrafts.find((e) => e.id === selectedEdgeId) ?? null;
  const selectedEdgeFromQuestion = selectedEdge
    ? (questions.find((q) => q.id === selectedEdge.fromQuestionId) ?? null)
    : null;

  const unwiredCount = edgeDrafts.filter(
    (e) => e.fromQuestionId === undefined || e.toQuestionId === undefined,
  ).length;

  function handleSave() {
    const wired = edgeDrafts.filter(
      (e): e is EdgeDraft & { toQuestionId: string } =>
        e.fromQuestionId !== undefined && e.toQuestionId !== undefined,
    );
    saveFlow.mutate({
      guildId,
      questions: questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        type: q.type,
        required: q.required,
        canvasX: q.canvasX,
        canvasY: q.canvasY,
        options: q.options.map((o, i) => ({ id: o.id, label: o.label, sortOrder: i })),
      })),
      edges: wired.map((e) => ({
        fromQuestionId: e.fromQuestionId ?? null,
        toQuestionId: e.toQuestionId,
        conditionType: e.conditionType,
        conditionOptionIds: e.conditionOptionIds,
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
        <h3 className="font-bold">Custom onboarding questions</h3>
        <p className="text-discord-text-muted text-sm">
          Build your own questions for new members, with branching. Drag a
          connection straight between two questions for an unconditional
          link, or click &quot;+ Add condition&quot; to drop a small
          condition box on the canvas and wire it up yourself — a question
          (or Start) into its left side, a question out its right side.
          Click any question or condition to edit it. Answers show up on
          the roster page for everyone. Nothing configured here means
          onboarding behaves exactly as it does today. The dashed boxes are
          onboarding&apos;s existing fixed steps (name, class, alts,
          nickname — not editable here) shown for context.
        </p>
      </div>

      <RoleRulesReference rules={rules} discordRoles={discordRoles} />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={addQuestion}
          className="bg-discord-elevated hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1.5 text-xs font-semibold"
        >
          + Add question
        </button>
        <button
          type="button"
          onClick={addCondition}
          title="Drops a condition box on the canvas — wire it up by dragging connections in and out"
          className="bg-discord-elevated hover:bg-discord-elevated-hover self-start rounded-full px-3 py-1.5 text-xs font-semibold"
        >
          + Add condition
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saveFlow.isPending}
          className="bg-discord-brand self-start rounded-full px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saveFlow.isPending ? "Saving..." : "Save"}
        </button>
        {unwiredCount > 0 && (
          <p className="text-discord-text-muted text-xs">
            {unwiredCount} condition{unwiredCount === 1 ? "" : "s"} not fully
            wired — won&apos;t be saved yet.
          </p>
        )}
        {saveFlow.error && (
          <p className="text-discord-red text-sm">{saveFlow.error.message}</p>
        )}
        {saveFlow.isSuccess && !saveFlow.isPending && (
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
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            colorMode="dark"
            fitView
          />
        </div>

        {selectedQuestion && (
          <GuildOnboardingQuestionPanel
            question={selectedQuestion}
            onChange={(patch) => updateQuestion(selectedQuestion.id, patch)}
            onDelete={() => deleteQuestion(selectedQuestion.id)}
          />
        )}
        {selectedEdge && (
          <GuildOnboardingEdgePanel
            edge={selectedEdge}
            questions={questions}
            fromQuestion={selectedEdgeFromQuestion}
            onChange={(patch) => updateEdge(selectedEdge.id, patch)}
            onDelete={() => deleteEdge(selectedEdge.id)}
          />
        )}
      </div>
    </div>
  );
}
