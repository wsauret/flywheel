import { describe, expect, it } from "bun:test";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import { buildWorkflowControlInitializedFact } from "../../../../src/workflows/vm/session-facts.js";
import {
  replayWorkflow,
  transitionDecodedWorkflow,
  transitionWorkflow,
} from "../../../../src/workflows/vm/transition.js";

import { acknowledge, ownership, runningControl, startPreparedAttempt, success } from "./_machine-semantics-fixtures.js";

const blocker = {
  reason: "The phase packet names src/missing.ts, which the repository does not contain",
  evidence: "list src/ reports no missing.ts",
} as const;
const blockedHandoff = {
  outcome: { state: "blocked", ...blocker },
  summary: "Stopped before editing: the file the phase names is absent from the repository.",
};

function block(
  state: ReturnType<typeof replayWorkflow>,
  attemptId = "attempt",
  correctiveDefinitionId: string | null = null,
) {
  return transitionWorkflow(state, {
    type: "ATTEMPT_BLOCKED",
    blocked: { attemptId, conversationId: "conversation", handoff: blockedHandoff },
    correctiveDefinitionId,
  });
}

/** The agent node and running attempt of a control built by runningControl(). */
function workOf(base: CommittedWorkflowControl) {
  const [node] = base.graph.nodes;
  const [attempt] = base.attempts;
  if (node?.kind !== "agent" || !attempt) throw new Error("running control fixture must hold one agent and its attempt");
  return { node, attempt };
}

function blockedAttempt(base: CommittedWorkflowControl) {
  return {
    ...workOf(base).attempt,
    state: { _tag: "blocked", reason: blocker.reason },
    handoff: blockedHandoff,
  } as const;
}

/** A blocked source whose authored reassessment is running: the only shape from
 *  which a corrective proposal can reach the blocked attempt. */
function blockedThenReassessing(): CommittedWorkflowControl {
  const base = runningControl();
  const reassess = {
    ...workOf(base).attempt, id: "attempt:reassess", definitionId: "follow", sequence: 2,
    provenance: { _tag: "followUpV10" }, parentAttemptId: "attempt", state: { _tag: "running" },
  } as const;
  return {
    ...base,
    attempts: [blockedAttempt(base), reassess],
    guardrails: {
      ...base.guardrails,
      attemptMutationsUsed: [{ attemptId: "attempt", used: 0 }, { attemptId: reassess.id, used: 0 }],
    },
  };
}

describe("workflow machine fake semantics", () => {
  it.each([
    ["queue", { maxAttempts: 1 }, "max queue length (1)"],
    ["session", { maxInserts: 0 }, "max session inserts (0)"],
    ["mutation", { maxMutationsPerAttempt: 1, attemptMutationsUsed: [{ attemptId: "attempt", used: 1 }] }, "mutation cap (1)"],
  ] as const)("commits completion and fails without charging a refused %s insertion", (_limit, limits, reason) => {
    for (const kind of ["then", "loop"] as const) {
      const base = runningControl({ then: { step: "follow", when: null, then: null } });
      const control: CommittedWorkflowControl = {
        ...base,
        graph: kind === "then" ? base.graph : {
          ...base.graph,
          nodes: [{
            kind: "while", id: "node", workflowDefinitionId: "semantic", order: 0, ownership,
            state: { _tag: "running" }, evaluator: { step: "work", field: "continue" },
            body: [{ step: "work" }], maxIterations: 3, detectStuck: true, iteration: 1, priorNormalizedSignal: null,
          }],
        },
        guardrails: { ...base.guardrails, ...limits },
      };
      const root = buildWorkflowControlInitializedFact(control);
      const handoff = { continue: "yes", summary: "Finished source work" };
      const proposed = success(replayWorkflow(root.payload.control), handoff);
      const pending = proposed.state.context.pending;
      if (!pending) throw new Error("Expected refusal commit");
      expect(pending.facts.map(({ type }) => type)).toEqual([
        "attempt.succeeded", "attempt.insertion_rejected", "workflow.failed", "workflow.control.committed",
      ]);
      const refusal = pending.facts[1];
      if (refusal?.type !== "attempt.insertion_rejected") throw new Error("Expected insertion refusal");
      expect(refusal.version).toBe(1);
      expect(refusal.payload.attemptId).toBe("attempt");
      expect(refusal.payload.reason).toContain(reason);
      expect(pending.proposedCommitted.attempts).toMatchObject([
        { id: "attempt", state: { _tag: "completed" }, conversationId: "conversation", handoff },
      ]);
      expect(pending.proposedCommitted.attempts).toHaveLength(1);
      expect(pending.proposedCommitted.guardrails).toEqual(control.guardrails);
      expect(pending.proposedCommitted.graph.nodes[0]?.state._tag).toBe("failed");
      if (kind === "loop") expect(pending.proposedCommitted.graph.nodes[0]).toMatchObject({ iteration: 1, priorNormalizedSignal: null });
      expect(acknowledge(proposed).state.lifecycle).toBe("failed");
      expect(replayWorkflowControl([root, ...pending.facts])).toEqual(pending.proposedCommitted);
      expect(() => replayWorkflowControl([root, ...pending.facts.filter(({ type }) => type !== "attempt.insertion_rejected")])).toThrow();
    }
  });

  it("preserves blocked and retry outcomes when their continuation exceeds the queue cap", () => {
    for (const kind of ["blocked", "retry"] as const) {
      const base = runningControl({ then: { step: "follow", when: null, then: null }, retry: { max: 2, stuck: true } });
      const root = buildWorkflowControlInitializedFact({ ...base, guardrails: { ...base.guardrails, maxAttempts: 1 } });
      const state = replayWorkflow(root.payload.control);
      const proposed = kind === "blocked" ? block(state, "attempt", "follow") : transitionWorkflow(state, {
        type: "ATTEMPT_FAILED",
        failure: { attemptId: "attempt", kind: "handoff", reason: "missing evidence", conversationId: "conversation" },
      });
      const pending = proposed.state.context.pending;
      if (!pending) throw new Error("Expected refusal commit");
      // A blocked step fails the run. A retry that does not fit fails only
      // its step, and the run fails because the parent reads that step.
      expect(pending.facts.map(({ type }) => type)).toEqual(kind === "blocked"
        ? ["attempt.blocked", "attempt.insertion_rejected", "workflow.failed", "workflow.control.committed"]
        : ["attempt.failed", "workflow.failed", "workflow.control.committed"]);
      expect(pending.proposedCommitted.attempts).toHaveLength(1);
      expect(pending.proposedCommitted.attempts[0]).toMatchObject({
        state: kind === "blocked"
          ? { _tag: "blocked", reason: blocker.reason }
          : { _tag: "failed", reason: 'missing evidence. Workflow control "retry" rejected insert_after: max attempts (1)' },
        handoff: kind === "blocked" ? blockedHandoff : null,
        conversationId: "conversation",
      });
      expect(pending.proposedCommitted.guardrails).toEqual(root.payload.control.guardrails);
      expect(acknowledge(proposed).state.lifecycle).toBe("failed");
      expect(replayWorkflowControl([root, ...pending.facts])).toEqual(pending.proposedCommitted);
    }
  });

  it("still throws for missing insertion accounting", () => {
    const base = runningControl({ then: { step: "follow", when: null, then: null } });
    expect(() => success(replayWorkflow({ ...base, guardrails: { ...base.guardrails, attemptMutationsUsed: [] } }), {}))
      .toThrow('missing guardrail accounting for attempt "attempt"');
  });

  it("inserts one nested follow-up per completion and applies empty-value gating", () => {
    const then = { step: "follow", when: "gate", then: { step: "nested", when: null, then: null } } as const;
    for (const gate of [null, undefined, "", []]) {
      const proposed = success(replayWorkflow(runningControl({ then })), { gate });
      expect(proposed.state.context.pending?.proposedCommitted.attempts).toHaveLength(1);
    }

    const first = startPreparedAttempt(acknowledge(success(replayWorkflow(runningControl({ then })), { gate: "yes" })));
    expect(first.command).toMatchObject({ kind: "run_attempts", attempts: [{ definitionId: "follow" }] });
    const followId = first.state.context.committed.attempts[1]?.id;
    if (!followId) throw new Error("follow-up attempt missing");
    const second = startPreparedAttempt(acknowledge(success(first.state, {}, followId)));
    expect(second.command).toMatchObject({ kind: "run_attempts", attempts: [{ definitionId: "nested" }] });
  });

  it("distinguishes authored handoff retry, ordinary failure, and context overflow", () => {
    const retryState = replayWorkflow(runningControl({ retry: { max: 2, stuck: true } }));
    const retried = startPreparedAttempt(acknowledge(transitionWorkflow(retryState, {
      type: "ATTEMPT_FAILED",
      failure: { attemptId: "attempt", kind: "handoff", reason: "missing evidence", conversationId: "conversation" },
    })));
    expect(retried.command).toMatchObject({
      kind: "run_attempts",
      attempts: [{ iteration: 2, priorRetryFeedback: "missing evidence", provenance: { _tag: "retry" } }],
    });
    const retryBase = runningControl({ retry: { max: 2, stuck: true } });
    const uncharged = transitionWorkflow(replayWorkflow({
      ...retryBase,
      guardrails: { ...retryBase.guardrails, maxInserts: 0, maxMutationsPerAttempt: 1, attemptMutationsUsed: [{ attemptId: "attempt", used: 1 }] },
    }), {
      type: "ATTEMPT_FAILED",
      failure: { attemptId: "attempt", kind: "handoff", reason: "missing evidence", conversationId: "conversation" },
    });
    expect(uncharged.state.context.pending?.proposedCommitted.attempts).toHaveLength(2);
    expect(uncharged.state.context.pending?.proposedCommitted.guardrails.insertsUsed).toBe(0);

    for (const kind of ["fatal", "transient", "context_overflow", "missing_handoff"] as const) {
      const proposed = transitionWorkflow(replayWorkflow(runningControl()), {
        type: "ATTEMPT_FAILED",
        failure: { attemptId: "attempt", kind, reason: "unauthorized", conversationId: "conversation" },
      });
      expect(proposed.state.context.pending?.facts.map(({ type, version }) => `${type}@${version}`)).toContain("attempt.failed@3");
      const failed = acknowledge(proposed);
      expect(failed.state.lifecycle).toBe("failed");
      expect(failed.state.context.committed.attempts).toHaveLength(1);
      // An overflowed conversation cannot hold the step again, so a Resume starts it in a new one.
      expect(failed.state.context.committed.attempts[0]).toMatchObject({ state: { _tag: "failed", reason: "unauthorized" }, conversationId: kind === "context_overflow" ? null : "conversation" });
    }
  });

  it("keeps for expansion transactional and accounts for per-item follow-ups", () => {
    const base = runningControl();
    const sourceNode = { ...workOf(base).node, definitionId: "source", name: "Source" };
    const forNode = {
      kind: "for",
      id: "for-node",
      workflowDefinitionId: "semantic",
      order: 1,
      ownership,
      state: { _tag: "pending" },
      source: { step: "source", field: "items" },
      body: [{ step: "work" }, { step: "follow" }],
    } as const;
    const control: CommittedWorkflowControl = {
      ...base,
      definitionIdentity: {
        ...base.definitionIdentity,
        bindings: ["follow", "source", "work"].map((bindingId) => ({ bindingId, sha256: "b".repeat(64) })),
      },
      graph: {
        ...base.graph,
        nodes: [sourceNode, forNode],
        dependencies: [{ nodeId: "for-node", dependsOn: "node" }],
      },
      attempts: [{ ...workOf(base).attempt, definitionId: "source" }],
    };

    const expanded = acknowledge(success(replayWorkflow(control), { items: [{ id: "one" }] }));
    const body = expanded.state.context.committed.attempts[1];
    if (!body) throw new Error("for body attempt missing");
    const bodyRun = startPreparedAttempt(expanded);
    const followed = startPreparedAttempt(acknowledge(success(bodyRun.state, {}, body.id)));
    expect(followed.command).toMatchObject({
      kind: "run_attempts",
      attempts: [{ definitionId: "follow", item: null }],
    });
  });

  it("commits the source and pauses when a zero expansion budget rejects for fan-out", () => {
    const base = runningControl();
    const control: CommittedWorkflowControl = {
      ...base,
      definitionIdentity: {
        ...base.definitionIdentity,
        bindings: ["source", "work"].map((bindingId) => ({ bindingId, sha256: "b".repeat(64) })),
      },
      graph: {
        ...base.graph,
        nodes: [
          { ...workOf(base).node, definitionId: "source", name: "Source" },
          {
            kind: "for", id: "for-node", workflowDefinitionId: "semantic", order: 1, ownership,
            state: { _tag: "pending" }, source: { step: "source", field: "items" }, body: [{ step: "work" }],
          },
        ],
        dependencies: [{ nodeId: "for-node", dependsOn: "node" }],
      },
      attempts: [{ ...workOf(base).attempt, definitionId: "source" }],
      guardrails: { ...base.guardrails, maxInserts: 0 },
    };

    const root = buildWorkflowControlInitializedFact(control);
    for (const encoding of [2, 3, 4, 6] as const) {
      const proposal = transitionDecodedWorkflow(replayWorkflow(root.payload.control), {
        type: "ATTEMPT_SUCCEEDED",
        outcome: { attemptId: "attempt", conversationId: "conversation", handoff: { items: [{ id: "one" }] }, reassessment: null },
      }, encoding);
      const pending = proposal.state.context.pending;
      if (!pending) throw new Error("Expected expansion refusal");
      expect(pending.facts.map(({ type, version }) => [type, version])).toEqual([
        ["attempt.succeeded", encoding === 6 ? 2 : 1], ["for.expansion_rejected", 1], ["workflow.control.committed", encoding],
      ]);
      expect(replayWorkflowControl([root, ...pending.facts])).toEqual(pending.proposedCommitted);
    }
    const rejected = acknowledge(success(replayWorkflow(control), { items: [{ id: "one" }] }));
    expect(rejected.state.lifecycle).toBe("paused");
    expect(rejected.state.context.committed.attempts).toMatchObject([{ definitionId: "source", state: { _tag: "completed" } }]);
    expect(rejected.state.context.committed.graph.nodes[1]?.state._tag).toBe("ready");
  });

  it("drops an ineligible reassessment target before charging its budget", () => {
    const state = replayWorkflow({
      ...runningControl(),
      guardrails: { ...runningControl().guardrails, maxMutationsPerAttempt: 1 },
    });
    const proposed = transitionWorkflow(state, {
      type: "REASSESSMENT_PROPOSED",
      proposal: {
        proposalId: "reassess-1", ownerNodeId: "node", reason: "change",
        changes: [{
          kind: "replace", targetAttemptId: "attempt", attemptId: "replacement-attempt",
          forItem: null,
          reason: "replace",
        }],
      },
    });
    expect(proposed.state.context.pending?.proposedCommitted.attempts).toHaveLength(1);
    expect(proposed.state.context.pending?.proposedCommitted.guardrails.attemptMutationsUsed[0]?.used).toBe(0);
  });

  it("rejects an eligible reassessment mutation group atomically", () => {
    const base = runningControl();
    const target = { ...workOf(base).node, id: "target", order: 1, state: { _tag: "pending" } } as const;
    const targetAttempt = {
      ...workOf(base).attempt, id: "target-attempt", logicalNodeId: target.id, state: { _tag: "pending" },
    } as const;
    const state = replayWorkflow({
      ...base,
      graph: { ...base.graph, nodes: [...base.graph.nodes, target] },
      attempts: [...base.attempts, targetAttempt],
      guardrails: {
        ...base.guardrails,
        maxMutationsPerAttempt: 1,
        attemptMutationsUsed: [...base.guardrails.attemptMutationsUsed, { attemptId: targetAttempt.id, used: 0 }],
      },
    });
    const before = JSON.stringify(state);
    expect(() => transitionWorkflow(state, {
      type: "REASSESSMENT_PROPOSED",
      proposal: {
        proposalId: "reassess-2", ownerNodeId: "node", reason: "change",
        changes: [{
          kind: "replace", targetAttemptId: targetAttempt.id, attemptId: "replacement-attempt",
          forItem: null, reason: "replace",
        }],
      },
    })).toThrow(/reassess:reassess-2.*mutation cap/);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("creates reassessment attempts without artifact-selection state", () => {
    const base = runningControl();
    const proposed = transitionWorkflow(replayWorkflow(base), {
      type: "REASSESSMENT_PROPOSED",
      proposal: {
        proposalId: "reassess-add-node",
        ownerNodeId: "node",
        reason: "add discovered work",
        changes: [{
          kind: "add_node",
          node: {
            kind: "step",
            id: "added-node",
            workflowDefinitionId: "semantic",
            order: 1,
            ownership,
            state: { _tag: "pending" },
            definitionId: "follow",
            name: "Added work",
            then: null,
            retry: null,
          },
          forItem: null,
        }],
      },
    });

    expect(proposed.state.context.pending?.proposedCommitted.attempts.at(-1)).toMatchObject({
      definitionId: "follow",
      provenance: { _tag: "reassessment" },
    });
  });

  it("executes replacement and inserted work before workflow completion", () => {
    const base = runningControl();
    const ownerNode = { ...workOf(base).node, state: { _tag: "completed" } } as const;
    const ownerAttempt = { ...workOf(base).attempt, state: { _tag: "completed" } } as const;
    const targetA = { ...ownerNode, id: "target-a", order: 1, state: { _tag: "pending" } } as const;
    const targetB = { ...ownerNode, id: "target-b", order: 2, state: { _tag: "pending" } } as const;
    const targetAttemptA = { ...ownerAttempt, id: "attempt-a", logicalNodeId: targetA.id, state: { _tag: "pending" } } as const;
    const targetAttemptB = { ...ownerAttempt, id: "attempt-b", logicalNodeId: targetB.id, state: { _tag: "pending" } } as const;
    const control: CommittedWorkflowControl = {
      ...base,
      graph: {
        ...base.graph,
        nodes: [ownerNode, targetA, targetB],
        dependencies: [
          { nodeId: targetA.id, dependsOn: ownerNode.id },
          { nodeId: targetB.id, dependsOn: targetA.id },
        ],
      },
      attempts: [ownerAttempt, targetAttemptA, targetAttemptB],
      guardrails: {
        ...base.guardrails,
        attemptMutationsUsed: [ownerAttempt, targetAttemptA, targetAttemptB].map(({ id: attemptId }) => ({ attemptId, used: 0 })),
      },
    };
    const proposed = transitionWorkflow(replayWorkflow(control), {
      type: "REASSESSMENT_PROPOSED",
      proposal: {
        proposalId: "reassess-work", ownerNodeId: ownerNode.id, reason: "change",
        changes: [
          {
            kind: "replace", targetAttemptId: targetAttemptA.id, attemptId: "replacement-attempt",
            forItem: { id: "replacement" }, reason: "replace",
          },
          {
            kind: "insert_after", targetAttemptId: targetAttemptB.id, afterAttemptId: targetAttemptB.id, attemptId: "inserted-attempt",
            forItem: { id: "inserted" }, reason: "insert",
          },
        ],
      },
    });
    expect(proposed.command.kind).toBe("commit");
    const replacementRun = startPreparedAttempt(acknowledge(proposed));
    expect(replacementRun.command).toMatchObject({ kind: "run_attempts", attempts: [{ attemptId: "replacement-attempt" }] });
    expect(replacementRun.state.context.committed.graph.nodes.map(({ id }) => id)).toEqual([
      ownerNode.id, targetA.id, targetB.id,
    ]);
    expect(replacementRun.state.context.committed.attempts.map(({ logicalNodeId }) => logicalNodeId)).toEqual([
      ownerNode.id, targetA.id, targetA.id, targetB.id, targetB.id,
    ]);
    expect(replacementRun.state.context.committed.attempts.find(({ id }) => id === targetAttemptA.id)?.state._tag).toBe("skipped");
    const replacementAttempt = replacementRun.state.context.committed.attempts.find(({ id }) => id === "replacement-attempt");
    const insertedAttempt = replacementRun.state.context.committed.attempts.find(({ id }) => id === "inserted-attempt");
    if (!replacementAttempt || !insertedAttempt) throw new Error("reassessment attempt missing");
    expect(replacementAttempt).toMatchObject({
      provenance: { _tag: "reassessment" },
      state: { _tag: "running" },
    });
    expect(replacementRun.state.context.committed.guardrails.insertsUsed).toBe(2);
    expect(replacementRun.state.context.committed.guardrails.attemptMutationsUsed).toEqual([
      { attemptId: ownerAttempt.id, used: 3 },
      { attemptId: targetAttemptA.id, used: 0 },
      { attemptId: targetAttemptB.id, used: 0 },
      { attemptId: replacementAttempt.id, used: 0 },
      { attemptId: insertedAttempt.id, used: 0 },
    ]);

    const targetRun = startPreparedAttempt(acknowledge(success(replacementRun.state, {}, replacementAttempt.id)));
    expect(targetRun.command).toMatchObject({ kind: "run_attempts", attempts: [{ attemptId: targetAttemptB.id }] });
    const insertedRun = startPreparedAttempt(acknowledge(success(targetRun.state, {}, targetAttemptB.id)));
    expect(insertedRun.command).toMatchObject({ kind: "run_attempts", attempts: [{ attemptId: insertedAttempt.id }] });
    const completed = acknowledge(success(insertedRun.state, {}, insertedAttempt.id));
    expect(completed.command.kind).toBe("none");
    expect(completed.state.lifecycle).toBe("completed");
    expect(completed.state.context.committed.attempts.find(({ id }) => id === replacementAttempt.id)?.state._tag).toBe("completed");
  });

  it("commits authored then work, loop continuation, and reassessment in one completion proposal", () => {
    const base = runningControl();
    const loopNode = {
      kind: "while", id: "loop", workflowDefinitionId: "semantic", order: 0, ownership,
      state: { _tag: "running" }, evaluator: { step: "work", field: "continue" },
      body: [{ step: "work" }, { step: "follow" }], maxIterations: 3, detectStuck: true, iteration: 1, priorNormalizedSignal: null,
    } as const;
    const review = { ...workOf(base).attempt, logicalNodeId: loopNode.id } as const;
    const authoredThen = {
      ...review, id: "attempt:then", definitionId: "follow", sequence: 2, state: { _tag: "pending" },
    } as const;
    const target = { ...workOf(base).node, id: "target", order: 1, state: { _tag: "pending" } } as const;
    const targetAttempt = {
      ...workOf(base).attempt, id: "attempt:target", logicalNodeId: target.id, state: { _tag: "pending" },
    } as const;
    const control: CommittedWorkflowControl = {
      ...base,
      graph: { ...base.graph, nodes: [loopNode, target], dependencies: [{ nodeId: target.id, dependsOn: loopNode.id }] },
      attempts: [review, authoredThen, targetAttempt],
      guardrails: {
        ...base.guardrails,
        maxMutationsPerAttempt: 4,
        attemptMutationsUsed: [review, authoredThen, targetAttempt].map(({ id: attemptId }) => ({ attemptId, used: 0 })),
      },
    };
    const proposal = transitionWorkflow(replayWorkflow(control), {
      type: "ATTEMPT_SUCCEEDED",
      outcome: {
        attemptId: review.id,
        conversationId: "conversation",
        handoff: { continue: "yes" },
        reassessment: {
          proposalId: "atomic", ownerNodeId: loopNode.id, reason: "new work",
          changes: [{
            kind: "insert_after", targetAttemptId: targetAttempt.id, afterAttemptId: targetAttempt.id, attemptId: "reassessed-attempt",
            forItem: null, reason: "insert",
          }],
        },
      },
    });
    expect(proposal.command.kind).toBe("commit");
    const pending = proposal.state.context.pending;
    if (!pending) throw new Error("completion proposal missing");
    expect(pending.proposedCommitted.attempts.map(({ definitionId }) => definitionId)).toEqual([
      "work", "follow", "work", "work", "work",
    ]);
    expect(pending.facts.filter(({ type }) => type === "workflow.reassessed")).toHaveLength(1);
    const authoredRun = startPreparedAttempt(acknowledge(proposal));
    expect(authoredRun.command).toMatchObject({ kind: "run_attempts", attempts: [{ attemptId: authoredThen.id }] });
  });

  it("records the blocked source durably and runs only the eligible reassessment", () => {
    const then = { step: "follow", when: null, then: null } as const;
    const proposed = block(replayWorkflow(runningControl({ then })), "attempt", "follow");
    const pending = proposed.state.context.pending;
    if (!pending) throw new Error("blocked event must propose a commit");

    expect(pending.facts.map(({ type }) => type)).toEqual(["attempt.blocked", "workflow.control.committed"]);
    expect(pending.proposedCommitted.attempts).toMatchObject([
      { id: "attempt", state: { _tag: "blocked", reason: blocker.reason }, handoff: blockedHandoff },
      { definitionId: "follow", provenance: { _tag: "followUpV10" }, parentAttemptId: "attempt", state: { _tag: "pending" } },
    ]);

    const reassessRun = startPreparedAttempt(acknowledge(proposed));
    expect(reassessRun.command).toMatchObject({ kind: "run_attempts", attempts: [{ definitionId: "follow" }] });
  });

  it("fails instead of routing a block to a follow-up that cannot correct it", () => {
    const then = { step: "follow", when: null, then: null } as const;
    const proposed = block(replayWorkflow(runningControl({ then })));
    const pending = proposed.state.context.pending;
    if (!pending) throw new Error("blocked event must propose a commit");

    expect(pending.facts.map(({ type }) => type)).toEqual([
      "attempt.blocked",
      "workflow.failed",
      "workflow.control.committed",
    ]);
    expect(pending.proposedCommitted.attempts.map(({ state }) => state._tag)).toEqual(["blocked"]);
    expect(acknowledge(proposed).state.lifecycle).toBe("failed");
  });

  it("rejects a corrective continuation the authored graph does not name", () => {
    const then = { step: "follow", when: null, then: null } as const;
    expect(() => block(replayWorkflow(runningControl({ then })), "attempt", "unrelated"))
      .toThrow(/corrective continuation "unrelated"/);
    expect(() => block(replayWorkflow(runningControl()), "attempt", "follow"))
      .toThrow(/the authored continuation is absent/);
  });

  it("fails with typed blocker evidence when the blocked node has no next step", () => {
    const proposed = block(replayWorkflow(runningControl()));
    const pending = proposed.state.context.pending;
    if (!pending) throw new Error("blocked event must propose a commit");

    expect(pending.facts.map(({ type }) => type)).toEqual([
      "attempt.blocked",
      "workflow.failed",
      "workflow.control.committed",
    ]);
    expect(pending.facts[0]).toMatchObject({
      type: "attempt.blocked",
      payload: { attemptId: "attempt", reason: blocker.reason, evidence: blocker.evidence },
    });

    const failed = acknowledge(proposed);
    expect(failed.state.lifecycle).toBe("failed");
    expect(failed.state.context.committed.graph.nodes[0]?.state).toMatchObject({ _tag: "blocked" });
  });

  it("keeps the blocked source immutable and lineage-links its corrective replacement", () => {
    const proposal = transitionWorkflow(replayWorkflow(blockedThenReassessing()), {
      type: "ATTEMPT_SUCCEEDED",
      outcome: {
        attemptId: "attempt:reassess",
        conversationId: "conversation",
        handoff: { verdict: "adjusted" },
        reassessment: {
          proposalId: "corrective", ownerNodeId: "node", reason: "correct the blocked milestone",
          changes: [{
            kind: "replace", targetAttemptId: "attempt", attemptId: "attempt:corrected",
            forItem: { id: "phase-1" }, reason: "Re-spec milestone 1 around the file that exists",
          }],
        },
      },
    });
    const pending = proposal.state.context.pending;
    if (!pending) throw new Error("corrective completion must propose a commit");

    expect(pending.proposedCommitted.attempts).toMatchObject([
      { id: "attempt", state: { _tag: "blocked", reason: blocker.reason }, handoff: blockedHandoff },
      {
        id: "attempt:corrected", state: { _tag: "pending" }, provenance: { _tag: "reassessment" },
        parentAttemptId: "attempt", item: { id: "phase-1" },
      },
      { id: "attempt:reassess", state: { _tag: "completed" } },
    ]);
    expect(pending.nextLifecycle).toBe("ready");
  });

  it("never settles a blocked source through a confirming reassessment", () => {
    const proposal = transitionWorkflow(replayWorkflow(blockedThenReassessing()), {
      type: "ATTEMPT_SUCCEEDED",
      outcome: {
        attemptId: "attempt:reassess",
        conversationId: "conversation",
        handoff: { verdict: "confirmed" },
        reassessment: null,
      },
    });
    const pending = proposal.state.context.pending;
    if (!pending) throw new Error("confirming completion must propose a commit");

    expect(pending.proposedCommitted.attempts[0]?.state).toMatchObject({ _tag: "blocked" });
    expect(pending.facts.map(({ type }) => type)).toContain("workflow.failed");
    expect(pending.nextLifecycle).toBe("failed");
  });

  it("settles the blocked node once its lineage-linked correction completes", () => {
    const base = runningControl();
    const corrected = {
      ...workOf(base).attempt, id: "attempt:corrected", sequence: 2, provenance: { _tag: "reassessment" },
      parentAttemptId: "attempt", state: { _tag: "running" },
    } as const;
    const control: CommittedWorkflowControl = {
      ...base,
      attempts: [blockedAttempt(base), corrected],
      guardrails: {
        ...base.guardrails,
        attemptMutationsUsed: [{ attemptId: "attempt", used: 0 }, { attemptId: corrected.id, used: 0 }],
      },
    };
    const proposal = success(replayWorkflow(control), { summary: "corrected" }, corrected.id);
    const pending = proposal.state.context.pending;
    if (!pending) throw new Error("corrected completion must propose a commit");

    expect(pending.proposedCommitted.graph.nodes[0]?.state).toMatchObject({ _tag: "completed" });
    expect(pending.nextLifecycle).toBe("completed");
  });
});
