import { expect } from "bun:test";
import type { WorkflowTransitionResult } from "../../../../src/workflows/vm/commands.js";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import type { FollowUpV10 } from "../../../../src/workflows/vm/graph-types.js";
import {
  replayWorkflow,
  transitionWorkflow,
} from "../../../../src/workflows/vm/transition.js";

export const ownership = { _tag: "workflow", workflowDefinitionId: "semantic" } as const;

export function runningControl(options: {
  retry?: { max: number; stuck: boolean } | null;
  then?: FollowUpV10 | null;
  resumeRevertCount?: number;
  conversationId?: string | null;
} = {}): CommittedWorkflowControl {
  return {
    definitionIdentity: {
      workflowDefinitionId: "semantic", workflowSha256: "a".repeat(64),
      bindings: ["follow", "nested", "work"].map((bindingId) => ({ bindingId, sha256: "b".repeat(64) })),
      vmVersion: "1", handoffRegistry: [], skills: [], personas: [],
    },
    workflowName: "Semantic",
    graph: {
      nodes: [{
        kind: "agent", id: "node", workflowDefinitionId: "semantic", order: 0, ownership,
        state: { _tag: "running" }, definitionId: "work", name: "Work",
        retry: options.retry ?? null, condition: null,
        ...(options.then ? { followUpV10: options.then } : {}),
      }],
      dependencies: [], joins: [], budgets: [],
    },
    attempts: [{
      id: "attempt", logicalNodeId: "node", workflowDefinitionId: "semantic", definitionId: "work",
      sequence: 1, iteration: 1, resumeRevertCount: options.resumeRevertCount ?? 0,
      provenance: { _tag: "authored" }, ownership, state: { _tag: "running" }, parentAttemptId: null,
      conversationId: options.conversationId ?? "conversation", handoff: null, priorRetryFeedback: null, item: null,
    }],
    frontier: [], status: "executing", aggregateSeq: 0,
    followUp: null,
    guardrails: {
      maxAttempts: 50, maxMutationsPerAttempt: 3, maxInserts: 20, insertsUsed: 0,
      attemptMutationsUsed: [{ attemptId: "attempt", used: 0 }],
    },
  };
}

export function acknowledge(result: WorkflowTransitionResult): WorkflowTransitionResult {
  const pending = result.state.context.pending;
  if (!pending) throw new Error("semantic event must propose a commit");
  return transitionWorkflow(result.state, {
    type: "COMMIT_SUCCEEDED", proposalId: pending.proposalId,
    aggregateSeq: pending.proposedCommitted.aggregateSeq,
  });
}

export function startPreparedAttempt(result: WorkflowTransitionResult): WorkflowTransitionResult {
  expect(result.command.kind).toBe("prepare_attempt");
  if (result.command.kind !== "prepare_attempt") throw new Error("semantic transition must prepare an attempt");
  const { attemptId } = result.command.attempt;
  expect(result.state.context.committed.attempts.find(({ id }) => id === attemptId)?.state._tag).toBe("pending");
  const proposed = transitionWorkflow(result.state, {
    type: "ATTEMPT_STARTED", attemptId, conversationId: `conversation:${attemptId}`,
  });
  expect(proposed.state.context.pending?.facts.map(({ type }) => type)).toEqual([
    "attempt.started", "workflow.control.committed",
  ]);
  const started = acknowledge(proposed);
  expect(started.command).toMatchObject({ kind: "run_attempts", attempts: [{ attemptId }] });
  if (started.command.kind !== "run_attempts") throw new Error("started attempt must run");
  expect(started.command.attempts).toHaveLength(1);
  return started;
}

export function success(state: ReturnType<typeof replayWorkflow>, handoff: { [key: string]: unknown }, attemptId = "attempt") {
  const attempt = state.context.committed.attempts.find(({ id }) => id === attemptId);
  if (!attempt?.conversationId) throw new Error("completed attempt must have a committed conversation identity");
  return transitionWorkflow(state, {
    type: "ATTEMPT_SUCCEEDED",
    outcome: { attemptId, conversationId: attempt.conversationId, handoff, reassessment: null },
  });
}
