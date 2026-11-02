import { describe, expect, it } from "bun:test";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import {
  initializeWorkflow,
  transitionWorkflow,
} from "../../../../src/workflows/vm/transition.js";

function control(): CommittedWorkflowControl {
  const ownership = { _tag: "workflow", workflowDefinitionId: "ordering" } as const;
  const nodes = ["a", "b"].map((id, order) => ({
    kind: "agent" as const,
    id,
    workflowDefinitionId: "ordering",
    order,
    ownership,
    state: { _tag: "ready" as const },
    definitionId: id,
    name: id,
    condition: null,
    retry: null,
  }));
  const attempts = nodes.map((node, index) => ({
    id: `attempt-${node.id}`,
    logicalNodeId: node.id,
    workflowDefinitionId: "ordering",
    definitionId: node.definitionId,
    sequence: index + 1,
    iteration: 1,
    resumeRevertCount: 0,
    provenance: { _tag: "authored" as const },
    ownership,
    state: { _tag: "pending" as const },
    parentAttemptId: null,
    conversationId: null,
    handoff: null,
    priorRetryFeedback: null,
    item: null,
  }));
  return {
    definitionIdentity: {
      workflowDefinitionId: "ordering", workflowSha256: "a".repeat(64),
      bindings: ["a", "b"].map((bindingId) => ({ bindingId, sha256: "b".repeat(64) })),
      vmVersion: "1", handoffRegistry: [], skills: [], personas: [],
    },
    workflowName: "Ordering",
    graph: { nodes, dependencies: [], joins: [], budgets: [] },
    attempts,
    frontier: ["a", "b"],
    status: "ready", aggregateSeq: 0,
    followUp: null,
    guardrails: {
      maxAttempts: 50, maxMutationsPerAttempt: 3, maxInserts: 20, insertsUsed: 0,
      attemptMutationsUsed: attempts.map(({ id: attemptId }) => ({ attemptId, used: 0 })),
    },
  };
}

describe("workflow transition invariants", () => {
  it("is deterministic, emits one commit, and selects one stable attempt", () => {
    const initial = initializeWorkflow(control());
    const first = transitionWorkflow(initial.state, { type: "START" });
    const replay = transitionWorkflow(initial.state, { type: "START" });
    expect(first).toEqual(replay);
    expect(first.command.kind).toBe("commit");
    expect(first.state.context.pending?.facts.filter(({ type }) => type === "attempt.started")).toHaveLength(0);
    expect(first.state.context.pending?.proposedCommitted.attempts[0]?.state._tag).toBe("pending");

    const pending = first.state.context.pending;
    if (!pending) throw new Error("start must propose a commit");
    const prepared = transitionWorkflow(first.state, {
      type: "COMMIT_SUCCEEDED",
      proposalId: pending.proposalId,
      aggregateSeq: pending.proposedCommitted.aggregateSeq,
    });
    expect(prepared.command).toMatchObject({ kind: "prepare_attempt", attempt: { attemptId: "attempt-a" } });

    const start = transitionWorkflow(prepared.state, {
      type: "ATTEMPT_STARTED", attemptId: "attempt-a", conversationId: "conversation-a",
    });
    const startPending = start.state.context.pending;
    if (!startPending) throw new Error("attempt start must propose a commit");
    const committed = transitionWorkflow(start.state, {
      type: "COMMIT_SUCCEEDED",
      proposalId: startPending.proposalId,
      aggregateSeq: startPending.proposedCommitted.aggregateSeq,
    });
    expect(committed.command).toMatchObject({ kind: "run_attempts", attempts: [{ attemptId: "attempt-a" }] });
    expect(committed.state.context.pending).toBeNull();
  });

  it("rejects deliberately corrupted owned state before transition", () => {
    const valid = initializeWorkflow(control()).state;
    const corrupted = {
      ...valid,
      context: {
        ...valid.context,
        committed: { ...valid.context.committed, frontier: [""] },
      },
    };
    expect(() => transitionWorkflow(corrupted, { type: "START" })).toThrow();
  });
});
