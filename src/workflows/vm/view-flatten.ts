import type { ResolvedAgent } from "../agent-resolution.js";
import type { AttemptRow, MutationLogEntry, WorkflowView } from "../view/types.js";
import type { CommittedWorkflowControl } from "./committed-control.js";
import type { Attempt, LogicalNode } from "./graph-types.js";
import { workflowTree } from "./view-tree.js";

function workflowState(status: CommittedWorkflowControl["status"]): WorkflowView["status"] {
  return status === "ready" ? "idle" : status === "executing" ? "running" : status === "follow_up" ? "completed" : status;
}

/** One attempt as a row of the workflow view. */
function attemptRow(attempt: Attempt, node: LogicalNode, agent: ResolvedAgent): AttemptRow {
  return {
    id: attempt.id,
    definitionId: attempt.definitionId,
    briefId: agent.briefId,
    workflowDefinitionId: attempt.workflowDefinitionId,
    name: node.kind === "agent" && attempt.definitionId === node.definitionId ? node.name : agent.name,
    status: attempt.state._tag,
    writes: agent.writes.map(({ id }) => id),
    resumeRevertCount: attempt.resumeRevertCount,
    ...(agent.description === undefined ? {} : { description: agent.description }),
    ...(attempt.conversationId === null ? {} : { lastConversationId: attempt.conversationId }),
    ...(attempt.item === null ? {} : { item: attempt.item }),
  };
}

function requireAgent(agents: ReadonlyMap<string, ResolvedAgent>, definitionId: string): ResolvedAgent {
  const agent = agents.get(definitionId);
  if (!agent) throw new Error(`Workflow view projection rejected unknown agent "${definitionId}"`);
  return agent;
}

/** Project committed attempts and their complete operational tree without reading a prior view. */
export function flattenWorkflowView(control: CommittedWorkflowControl, agents: ReadonlyMap<string, ResolvedAgent>): WorkflowView {
  const nodeById = new Map(control.graph.nodes.map((node) => [node.id, node]));
  const attempts = control.attempts.map((attempt) => {
    const agent = requireAgent(agents, attempt.definitionId);
    const node = nodeById.get(attempt.logicalNodeId);
    if (!node) throw new Error(`Workflow view projection rejected unknown node "${attempt.logicalNodeId}"`);
    return attemptRow(attempt, node, agent);
  });
  const cursor = attempts.findIndex(({ status }) => status === "pending" || status === "running");
  return {
    attempts,
    tree: workflowTree(control, (id) => requireAgent(agents, id).name),
    cursor: cursor < 0 ? attempts.length : cursor,
    status: workflowState(control.status),
    mutationLog: [],
    maxAttempts: control.guardrails.maxAttempts,
    ...(control.followUp === null ? {} : { followUpConversationId: control.followUp.conversationId }),
  };
}

/** Restate control-derived fields when no attempt change requires agent resolution. */
export function restateWorkflowView(view: WorkflowView, control: CommittedWorkflowControl): WorkflowView {
  const { followUpConversationId: _previous, ...rest } = view;
  const names = new Map(view.tree.nodes.flatMap((node) => node.kind === "agent" ? [[node.definitionId, node.label] as const] : []));
  return {
    ...rest,
    tree: workflowTree(control, (id) => {
      const name = names.get(id);
      if (name === undefined) throw new Error(`Workflow tree has no resolved name for agent "${id}"`);
      return name;
    }),
    status: workflowState(control.status),
    ...(control.followUp === null ? {} : { followUpConversationId: control.followUp.conversationId }),
  };
}

/** Add committed attempt provenance to a freshly flattened view target. */
export function workflowViewForProposal(
  current: WorkflowView | null,
  control: CommittedWorkflowControl,
  agents: ReadonlyMap<string, ResolvedAgent>,
  timestamp: number,
): WorkflowView {
  const target = flattenWorkflowView(control, agents);
  if (!current) return target;
  const currentIds = new Set(current.attempts.map(({ id }) => id));
  const insertedByActor = new Map<string, string[]>();
  for (const attempt of control.attempts) {
    if (currentIds.has(attempt.id)) continue;
    // The next record of a `then` chain or a `for` body of control from
    // before phases is authored work of its file. Remove after 2027-04-30.
    const actor = attempt.provenance._tag === "followUpV10" ? "authored" : attempt.provenance._tag;
    const ids = insertedByActor.get(actor) ?? [];
    ids.push(attempt.id);
    insertedByActor.set(actor, ids);
  }
  const mutations: MutationLogEntry[] = [...insertedByActor].map(([actor, attemptIds]) => ({
    timestamp,
    action: "insert",
    actor,
    reason: `Workflow control inserted ${actor} attempts`,
    attemptIds,
  }));
  return { ...target, mutationLog: [...current.mutationLog, ...mutations] };
}
