import { isDeepStrictEqual } from "node:util"
import { parseWorkflowQueueFact, type WorkflowQueueFact } from "./view-facts.js"
import type { AttemptRow, MutationLogEntry, WorkflowView } from "./types.js"
import type { WorkflowTree } from "../../protocol/workflow-view-protocol-types.js"

/** The queue facts that move the stored view from `current` to `target`.
 *  Each fact parses strictly, so a fact never stores a part of the view
 *  that its schema refuses. */
export function queueFactsForState(current: WorkflowView | null, target: WorkflowView): WorkflowQueueFact[] {
  if (!current) {
    const { tree, ...rows } = target
    return [
      parseWorkflowQueueFact({ type: "queue.created", version: 10, actor: "flywheel", payload: { rows } }),
      treeFact(tree),
    ]
  }
  // factsFromDiff is the single arbiter of what changed: unchanged rows
  // yield no diff facts on their own, so no separate equality short-circuit
  // is needed (the prior JSON.stringify guard was order-sensitive and dropped
  // present-but-undefined fields, silently suppressing real changes).
  return factsFromDiff(current, target).map(parseWorkflowQueueFact)
}

function factsFromDiff(current: WorkflowView, target: WorkflowView): WorkflowQueueFact[] {
  const facts: WorkflowQueueFact[] = []
  const newMutations = target.mutationLog.slice(current.mutationLog.length)
  for (const mutation of newMutations) facts.push(mutationFact(current, target, mutation))
  facts.push(...attemptStatusFacts(current, target, newMutations), ...resumeStateFacts(current, target), ...resumeRevertFacts(current, target), ...followUpResumeStateFacts(current, target))
  if (runStateChanged(current, target)) facts.push(runStateFact(target))
  facts.push(...treeFacts(current.tree, target.tree))
  return facts
}

function treeFact(tree: WorkflowTree): WorkflowQueueFact {
  return { type: "queue.tree.changed", version: 4, actor: "flywheel", payload: { tree } }
}

/** The facts that move the stored tree from `current` to `target`: one fact
 *  for each node that changed while every node keeps its id and place, or
 *  the whole tree when its structure changed. A transition changes a few
 *  nodes, so its facts stay small whatever the size of the tree. */
function treeFacts(current: WorkflowTree, target: WorkflowTree): WorkflowQueueFact[] {
  const keepsStructure = current.nodes.length === target.nodes.length
    && target.nodes.every((node, index) => node.id === current.nodes[index]?.id)
  if (!keepsStructure) return [treeFact(target)]
  const currentAgentNodeId = target.currentAgentNodeId ?? null
  const changed = target.nodes.filter((node, index) => !isDeepStrictEqual(node, current.nodes[index]))
  if (changed.length === 0) return currentAgentNodeId === (current.currentAgentNodeId ?? null) ? [] : [treeFact(target)]
  return changed.map((node) => ({ type: "queue.tree.node.changed", version: 1, actor: "flywheel", payload: { node, currentAgentNodeId } }))
}

function followUpResumeStateFacts(current: WorkflowView, target: WorkflowView): WorkflowQueueFact[] {
  if (current.followUpConversationId === target.followUpConversationId) return []
  return [{
    type: "follow_up.resume_state.recorded",
    version: 1,
    actor: "flywheel",
    payload: { conversationId: target.followUpConversationId ?? null },
  }]
}

function mutationFact(current: WorkflowView, target: WorkflowView, mutation: MutationLogEntry): WorkflowQueueFact {
  const insertions = insertionsForMutation(current, target, mutation)
  const removedAttemptIds = mutation.action === "remove"
    ? mutation.attemptIds.filter((id) => !target.attempts.some((attempt) => attempt.id === id))
    : []
  return {
    type: "queue.mutated",
    version: 11,
    actor: "flywheel",
    payload: {
      mutation,
      ...(insertions.length ? { insertions } : {}),
      ...(removedAttemptIds.length ? { removedAttemptIds } : {}),
    },
  }
}

function changedAttempts(current: WorkflowView, target: WorkflowView, changed: (previous: AttemptRow, attempt: AttemptRow) => boolean): readonly AttemptRow[] {
  const before = new Map(current.attempts.map((attempt) => [attempt.id, attempt]))
  return target.attempts.filter((attempt) => {
    const previous = before.get(attempt.id)
    return previous !== undefined && changed(previous, attempt)
  })
}

function attemptStatusFacts(current: WorkflowView, target: WorkflowView, mutations: readonly MutationLogEntry[]): WorkflowQueueFact[] {
  const before = new Map(current.attempts.map((attempt) => [attempt.id, attempt.status]))
  return changedAttempts(current, target, (previous, attempt) => previous.status !== attempt.status).map((attempt) => {
    const mutation = mutations.findLast((entry) => entry.attemptIds.includes(attempt.id))
    // SAFETY: changedAttempts keeps only attempts that the current rows hold.
    const previousStatus = before.get(attempt.id)!
    return {
      type: "step.status.changed",
      version: 2,
      actor: "flywheel",
      payload: { attemptId: attempt.id, status: attempt.status, previousStatus, ...(mutation?.reason ? { reason: mutation.reason } : {}) },
    }
  })
}

function resumeStateFacts(current: WorkflowView, target: WorkflowView): WorkflowQueueFact[] {
  return changedAttempts(current, target, (previous, attempt) => previous.lastConversationId !== attempt.lastConversationId).map((attempt) => ({
    type: "step.resume_state.recorded",
    version: 2,
    actor: "flywheel",
    payload: { attemptId: attempt.id, conversationId: attempt.lastConversationId ?? null },
  }))
}

function resumeRevertFacts(current: WorkflowView, target: WorkflowView): WorkflowQueueFact[] {
  return changedAttempts(current, target, (previous, attempt) => previous.resumeRevertCount !== attempt.resumeRevertCount).map((attempt) => ({
    type: "step.resume_revert.recorded",
    version: 2,
    actor: "flywheel",
    payload: { attemptId: attempt.id, count: attempt.resumeRevertCount },
  }))
}

function runStateFact(view: WorkflowView): WorkflowQueueFact {
  return {
    type: "queue.state.changed",
    version: 2,
    actor: "flywheel",
    payload: { status: view.status, cursor: view.cursor, maxAttempts: view.maxAttempts ?? null },
  }
}

/** Each row that the mutation inserts with its index in the target rows,
 *  in ascending order. Control places a new attempt after its anchor, so
 *  one mutation can insert rows in more than one place. */
function insertionsForMutation(current: WorkflowView, target: WorkflowView, mutation: MutationLogEntry): readonly { index: number; attempt: AttemptRow }[] {
  if (mutation.action !== "insert") return []
  const currentIds = new Set(current.attempts.map((attempt) => attempt.id))
  return target.attempts.flatMap((attempt, index) => mutation.attemptIds.includes(attempt.id) && !currentIds.has(attempt.id) ? [{ index, attempt }] : [])
}

function runStateChanged(current: WorkflowView, target: WorkflowView): boolean {
  return current.status !== target.status
    || current.cursor !== target.cursor
    || current.maxAttempts !== target.maxAttempts
}
