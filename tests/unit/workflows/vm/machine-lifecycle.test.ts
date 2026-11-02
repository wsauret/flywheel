import { describe, expect, it } from "bun:test";
import type { WorkflowTransitionResult } from "../../../../src/workflows/vm/commands.js";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import {
  initializeWorkflow,
  replayWorkflow,
  transitionWorkflow,
} from "../../../../src/workflows/vm/transition.js";

function control(status: CommittedWorkflowControl["status"] = "ready"): CommittedWorkflowControl {
  const ownership = { _tag: "workflow", workflowDefinitionId: "fake" } as const;
  return {
    definitionIdentity: {
      workflowDefinitionId: "fake", workflowSha256: "a".repeat(64),
      bindings: [{ bindingId: "work", sha256: "b".repeat(64) }], vmVersion: "1", handoffRegistry: [], skills: [], personas: [],
    },
    workflowName: "Fake",
    graph: {
      nodes: [{
        kind: "agent", id: "node-1", workflowDefinitionId: "fake", order: 0, ownership,
        state: status === "ready" ? { _tag: "ready" } : { _tag: status === "completed" ? "completed" : "running" },
        definitionId: "work", name: "Work", retry: null, condition: null,
      }],
      dependencies: [], joins: [], budgets: [],
    },
    attempts: [{
      id: "attempt-1", logicalNodeId: "node-1", workflowDefinitionId: "fake", definitionId: "work",
      sequence: 1, iteration: 1, resumeRevertCount: 0, provenance: { _tag: "authored" }, ownership,
      state: status === "ready" ? { _tag: "pending" } : { _tag: status === "completed" ? "completed" : "running" },
      parentAttemptId: null, conversationId: null, handoff: null, priorRetryFeedback: null, item: null,
    }],
    frontier: status === "ready" ? ["node-1"] : [],
    guardrails: {
      maxAttempts: 50, maxMutationsPerAttempt: 3, maxInserts: 20, insertsUsed: 0,
      attemptMutationsUsed: [{ attemptId: "attempt-1", used: 0 }],
    },
    status,
    followUp: null,
    aggregateSeq: 0,
  };
}

function acknowledge(result: WorkflowTransitionResult): WorkflowTransitionResult {
  const pending = result.state.context.pending;
  if (!pending) throw new Error("test transition must have a pending commit");
  return transitionWorkflow(result.state, {
    type: "COMMIT_SUCCEEDED",
    proposalId: pending.proposalId,
    aggregateSeq: pending.proposedCommitted.aggregateSeq,
  });
}

describe("workflow machine lifecycle", () => {
  it("splits proposal, success, and stale commit events", () => {
    const initial = initializeWorkflow(control());
    expect(initial).toMatchObject({ state: { lifecycle: "ready", context: { pending: null } }, command: { kind: "none" } });

    const proposed = transitionWorkflow(initial.state, { type: "START" });
    expect(proposed.state.lifecycle).toBe("awaiting_commit");
    expect(proposed.command.kind).toBe("commit");
    expect(proposed.state.context.committed).toEqual(initial.state.context.committed);
    expect(proposed.state.context.pending?.proposedCommitted.attempts[0]?.state._tag).toBe("pending");

    const stale = transitionWorkflow(proposed.state, { type: "COMMIT_SUCCEEDED", proposalId: "stale", aggregateSeq: 1 });
    expect(stale.state).toEqual(proposed.state);
    expect(stale.command.kind).toBe("none");

    const prepared = acknowledge(proposed);
    expect(prepared.state.lifecycle).toBe("ready");
    expect(prepared.state.context.pending).toBeNull();
    expect(prepared.command).toMatchObject({ kind: "prepare_attempt", attempt: { attemptId: "attempt-1" } });

    const started = transitionWorkflow(prepared.state, {
      type: "ATTEMPT_STARTED", attemptId: "attempt-1", conversationId: "conversation-1",
    });
    expect(started.state.context.pending?.facts.map(({ type }) => type)).toEqual([
      "attempt.started", "workflow.control.committed",
    ]);
    const committed = acknowledge(started);
    expect(committed.state.lifecycle).toBe("executing");
    expect(committed.state.context.committed.attempts[0]).toMatchObject({
      state: { _tag: "running" }, conversationId: "conversation-1",
    });
    expect(committed.command).toMatchObject({ kind: "run_attempts", attempts: [{ attemptId: "attempt-1" }] });

    const duplicate = transitionWorkflow(committed.state, {
      type: "COMMIT_SUCCEEDED",
      proposalId: started.state.context.pending?.proposalId ?? "missing",
      aggregateSeq: committed.state.context.committed.aggregateSeq,
    });
    expect(duplicate.command.kind).toBe("none");
  });

  it("commits pause, resume, abort, and follow-up transitions", () => {
    const prepared = acknowledge(transitionWorkflow(initializeWorkflow(control()).state, { type: "START" }));
    const executing = acknowledge(transitionWorkflow(prepared.state, {
      type: "ATTEMPT_STARTED", attemptId: "attempt-1", conversationId: "conversation-1",
    }));
    const paused = acknowledge(transitionWorkflow(executing.state, { type: "PAUSE", reason: "operator" }));
    expect(paused.state.lifecycle).toBe("paused");
    expect(paused.command.kind).toBe("none");

    const resumed = acknowledge(transitionWorkflow(paused.state, { type: "RESUME", readers: {} }));
    expect(resumed.state.lifecycle).toBe("ready");
    expect(resumed.command.kind).toBe("prepare_attempt");

    const abortProposal = transitionWorkflow(resumed.state, { type: "ABORT", reason: "operator" });
    expect(abortProposal.state.context.pending?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "workflow.aborted", payload: expect.objectContaining({ reason: "operator" }) }),
    ]));
    const aborted = acknowledge(abortProposal);
    expect(aborted.state.lifecycle).toBe("paused");
    expect(aborted.state.context.committed.status).toBe("paused");
    expect(aborted.state.context.committed.attempts[0]?.state._tag).toBe("pending");
    expect(aborted.state.context.pending).toBeNull();

    const completed = initializeWorkflow(control("completed"));
    const followUp = acknowledge(transitionWorkflow(completed.state, {
      type: "FOLLOW_UP_REQUESTED", input: { text: "Explain" }, identity: { kind: "identified", inputID: "input-1" }, conversationId: "follow-up-1", requestSequence: 1,
    }));
    expect(followUp.state.lifecycle).toBe("follow_up");
    expect(followUp.command).toMatchObject({
      kind: "run_follow_up", input: { input: { text: "Explain" }, conversationId: "follow-up-1", requestSequence: 1 },
    });
    const done = acknowledge(transitionWorkflow(followUp.state, { type: "FOLLOW_UP_SUCCEEDED", conversationId: "follow-up-1", requestSequence: 1 }));
    expect(done.state.lifecycle).toBe("completed");

    const recovered = acknowledge(transitionWorkflow(replayWorkflow(followUp.state.context.committed), { type: "RECOVER", progressed: [] }));
    expect(recovered.command).toMatchObject({
      kind: "run_follow_up",
      input: { input: { text: "Explain" }, conversationId: "follow-up-1", requestSequence: 1 },
    });
    expect(recovered.state.context.committed.followUp).toEqual({
      conversationId: "follow-up-1",
      requestSequence: 1,
      identity: { kind: "identified", inputID: "input-1" },
      pendingInput: { text: "Explain" },
    });

    expect(transitionWorkflow(executing.state, {
      type: "FOLLOW_UP_REQUESTED", input: { text: "Steer" }, identity: { kind: "identified", inputID: "steer-1" }, conversationId: "not-follow-up", requestSequence: 1,
    })).toEqual({ state: executing.state, command: { kind: "none" } });
  });

  it("resumes an aborted follow-up only after its ordinary resume commit", () => {
    const requested = acknowledge(transitionWorkflow(initializeWorkflow(control("completed")).state, {
      type: "FOLLOW_UP_REQUESTED", input: { text: "Keep this exact prompt" }, identity: { kind: "identified", inputID: "input-1" }, conversationId: "follow-up-1", requestSequence: 1,
    }));
    const aborted = acknowledge(transitionWorkflow(requested.state, { type: "ABORT", reason: "operator" }));
    const before = aborted.state.context.committed;
    const proposed = transitionWorkflow(replayWorkflow(before), { type: "RESUME", readers: {} });
    expect(proposed.command.kind).toBe("commit");
    expect(proposed.state.context.committed).toEqual(before);
    expect(proposed.state.context.pending?.facts.map(({ type }) => type)).toEqual([
      "workflow.resumed", "workflow.control.committed",
    ]);
    const resumed = acknowledge(proposed);
    expect(resumed.command).toEqual(requested.command);
    expect(resumed.state.lifecycle).toBe("follow_up");
    expect(resumed.state.context.committed).toEqual({
      ...before, status: "follow_up", aggregateSeq: before.aggregateSeq + 2,
    });
    expect(transitionWorkflow(resumed.state, {
      type: "COMMIT_SUCCEEDED", proposalId: proposed.state.context.pending!.proposalId,
      aggregateSeq: resumed.state.context.committed.aggregateSeq,
    }).command.kind).toBe("none");
    expect(() => transitionWorkflow(resumed.state, {
      type: "FOLLOW_UP_SUCCEEDED", conversationId: "follow-up-1", requestSequence: 2,
    })).toThrow("request 2");
  });

  it("does not consult wall-clock time", () => {
    const realNow = Date.now;
    Date.now = () => { throw new Error("Date.now is forbidden"); };
    try {
      const proposed = transitionWorkflow(initializeWorkflow(control()).state, { type: "START" });
      expect(acknowledge(proposed).command.kind).toBe("prepare_attempt");
    } finally {
      Date.now = realNow;
    }
  });
});
