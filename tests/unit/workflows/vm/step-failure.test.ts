import { describe, expect, it } from "bun:test";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import { replayWorkflow, transitionDecodedWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js";
import { acknowledge, runningControl, startPreparedAttempt, success } from "./_machine-semantics-fixtures.js";
import { createMemoryStore, initialFacts, sequentialWorkflow, testHost } from "./host-test-support.js";
import { replayWorkflowControl, resumesFailedAgents } from "../../../../src/workflows/vm/fact-fold.js";
import { failedAgents, agentResults, workflowCompletionContent } from "../../../../src/workflows/output-contract/workflow-completion.js";
import { loadQueueFromEvents } from "../../../../src/workflows/view/view-projection.js";

// A step that fails after its retries fails only itself, and the work that
// does not need it goes on. Work that needs its output cannot run, and the run fails once nothing more
// can run. Runs recorded at encoding 7 or earlier paused at the failure, and
// replay re-derives that pause.
describe("a failed workflow step", () => {
  /** One running step, a step that reads its output, and a step that does not. */
  function failingSourceControl(): CommittedWorkflowControl {
    const base = runningControl();
    const step = base.graph.nodes[0];
    if (step?.kind !== "agent") throw new Error("The fixture runs one agent");
    return {
      ...base,
      graph: {
        ...base.graph,
        nodes: [
          step,
          { ...step, id: "reader", order: 1, state: { _tag: "pending" }, definitionId: "follow", name: "Reader" },
          { ...step, id: "independent", order: 2, state: { _tag: "pending" }, definitionId: "nested", name: "Independent" },
        ],
        dependencies: [{ nodeId: "reader", dependsOn: "node" }],
      },
      attempts: [
        base.attempts[0]!,
        ...(["reader", "independent"] as const).map((node, index) => ({
          ...base.attempts[0]!, id: `${node}:attempt`, logicalNodeId: node, definitionId: index === 0 ? "follow" : "nested",
          sequence: index + 2, state: { _tag: "pending" }, conversationId: null,
        } as const)),
      ],
      guardrails: {
        ...base.guardrails,
        attemptMutationsUsed: ["attempt", "reader:attempt", "independent:attempt"].map((attemptId) => ({ attemptId, used: 0 })),
      },
    };
  }

  it("fails only the failed step, runs the work that does not need it, and fails the run that needed it", () => {
    const failed = acknowledge(transitionWorkflow(replayWorkflow(failingSourceControl()), {
      type: "ATTEMPT_FAILED",
      failure: { attemptId: "attempt", kind: "fatal", reason: "unauthorized", conversationId: "conversation" },
    }));
    expect(failed.state.lifecycle).not.toBe("paused");
    const nodes = failed.state.context.committed.graph.nodes;
    expect(nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "failed"], ["reader", "blocked"], ["independent", "ready"]]);

    const independent = startPreparedAttempt(failed);
    expect(independent.command).toMatchObject({ kind: "run_attempts", attempts: [{ definitionId: "nested" }] });
    const settled = acknowledge(success(independent.state, {}, "independent:attempt"));
    expect(settled.state.lifecycle).toBe("failed");
    expect(settled.state.context.committed.attempts.map(({ definitionId, state }) => [definitionId, state._tag]))
      .toEqual([["work", "failed"], ["follow", "pending"], ["nested", "completed"]]);
  });

  /** `base` with a step after its one node that reads that node's output. */
  function withReader(base: CommittedWorkflowControl): CommittedWorkflowControl {
    const step = base.graph.nodes.find(({ kind }) => kind === "agent");
    if (step?.kind !== "agent") throw new Error("The fixture holds one agent");
    return {
      ...base,
      graph: {
        ...base.graph,
        nodes: [...base.graph.nodes, { ...step, id: "reader", order: 1, state: { _tag: "pending" }, definitionId: "nested", name: "Reader" }],
        dependencies: [{ nodeId: "reader", dependsOn: base.graph.nodes[0]!.id }],
      },
      attempts: [...base.attempts, {
        ...base.attempts[0]!, id: "reader:attempt", logicalNodeId: "reader", definitionId: "nested",
        sequence: base.attempts.length + 1, state: { _tag: "pending" }, conversationId: null,
      }],
      guardrails: {
        ...base.guardrails,
        attemptMutationsUsed: [...base.guardrails.attemptMutationsUsed, { attemptId: "reader:attempt", used: 0 }],
      },
    };
  }

  const fatal = (attemptId: string) => ({
    type: "ATTEMPT_FAILED",
    failure: { attemptId, kind: "fatal", reason: "unauthorized", conversationId: "conversation" },
  } as const);

  it("fails the run when its last step fails, because the parent reads that step's output", () => {
    const failed = acknowledge(transitionWorkflow(replayWorkflow(runningControl()), fatal("attempt")));
    expect(failed.state.lifecycle).toBe("failed");
    expect(failed.state.context.committed.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "failed"]]);
  });

  it("completes the run when a failed step's output is read by no step and is not the result", () => {
    const control = failingSourceControl();
    const free: CommittedWorkflowControl = { ...control, graph: { ...control.graph, dependencies: [{ nodeId: "independent", dependsOn: "reader" }] } };
    const failed = acknowledge(transitionWorkflow(replayWorkflow(free), fatal("attempt")));
    const reader = acknowledge(success(startPreparedAttempt(failed).state, {}, "reader:attempt"));
    const settled = acknowledge(success(startPreparedAttempt(reader).state, {}, "independent:attempt"));
    expect(settled.state.lifecycle).toBe("completed");
    expect(settled.state.context.committed.attempts.map(({ definitionId, state }) => [definitionId, state._tag]))
      .toEqual([["work", "failed"], ["follow", "completed"], ["nested", "completed"]]);
  });

  // A follow-up exists only in control from before phases.
  it("fails the node of a failed follow-up step, so the step that reads it does not run", () => {
    const followed = acknowledge(success(replayWorkflow(withReader(runningControl({ then: { step: "follow", when: null, then: null } }))), {}));
    const follow = startPreparedAttempt(followed);
    const followId = follow.state.context.committed.attempts.find(({ definitionId }) => definitionId === "follow")!.id;
    const failed = acknowledge(transitionWorkflow(follow.state, fatal(followId)));
    expect(failed.state.context.committed.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "failed"], ["reader", "blocked"]]);
    expect(failed.state.lifecycle).toBe("failed");
  });

  it("skips the rest of a node's attempts after one fails, so a loop of control from before phases stops at its failed step", () => {
    const base = runningControl();
    const loop: CommittedWorkflowControl = withReader({
      ...base,
      attempts: [base.attempts[0]!, {
        ...base.attempts[0]!, id: "attempt-2", definitionId: "follow", sequence: 2,
        state: { _tag: "pending" }, conversationId: null, provenance: { _tag: "round", index: 1 },
      }],
      guardrails: { ...base.guardrails, attemptMutationsUsed: ["attempt", "attempt-2"].map((attemptId) => ({ attemptId, used: 0 })) },
    });
    const failed = acknowledge(transitionWorkflow(replayWorkflow(loop), fatal("attempt")));
    expect(failed.state.context.committed.attempts.map(({ id, state }) => [id, state._tag]))
      .toEqual([["attempt", "failed"], ["attempt-2", "skipped"], ["reader:attempt", "pending"]]);
    expect(failed.state.context.committed.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "failed"], ["reader", "blocked"]]);
    expect(failed.state.lifecycle).toBe("failed");
  });

  it("resumes a failed run by running only its failed step and the work that waited on it", () => {
    const failed = acknowledge(transitionWorkflow(replayWorkflow(failingSourceControl()), fatal("attempt")));
    const ended = acknowledge(success(startPreparedAttempt(failed).state, {}, "independent:attempt"));
    expect(ended.state.lifecycle).toBe("failed");

    const resumed = acknowledge(transitionWorkflow(ended.state, { type: "RESUME", readers: {} }));
    expect(resumed.state.context.committed.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "ready"], ["reader", "pending"], ["independent", "completed"]]);
    expect(resumed.command).toMatchObject({ kind: "prepare_attempt", attempt: { conversationId: null } });
    if (resumed.command.kind !== "prepare_attempt") throw new Error("Expected a continuation");
    const continuationId = resumed.command.attempt.attemptId;
    expect(continuationId).not.toBe("attempt");
    expect(resumed.state.context.committed.attempts.find(({ id }) => id === continuationId)).toMatchObject({
      id: continuationId, parentAttemptId: "attempt",
      provenance: { _tag: "continuation", reason: "reopen", sourceConversationId: "conversation", chargeAttemptId: "attempt" },
    });
    const source = acknowledge(success(startPreparedAttempt(resumed).state, {}, continuationId));
    const settled = acknowledge(success(startPreparedAttempt(source).state, {}, "reader:attempt"));
    expect(settled.state.lifecycle).toBe("completed");
    expect(settled.state.context.committed.attempts.map(({ id, state }) => [id, state._tag]))
      .toEqual([["attempt", "failed"], [continuationId, "completed"], ["reader:attempt", "completed"], ["independent:attempt", "completed"]]);
  });

  it("runs the attempts that a failure skipped again on Resume, and starts an overflowed step in a new conversation", () => {
    const base = runningControl();
    const loop: CommittedWorkflowControl = {
      ...base,
      attempts: [base.attempts[0]!, {
        ...base.attempts[0]!, id: "attempt-2", definitionId: "follow", sequence: 2,
        state: { _tag: "pending" }, conversationId: null, provenance: { _tag: "round", index: 1 },
      }],
      guardrails: { ...base.guardrails, attemptMutationsUsed: ["attempt", "attempt-2"].map((attemptId) => ({ attemptId, used: 0 })) },
    };
    const failed = acknowledge(transitionWorkflow(replayWorkflow(loop), {
      type: "ATTEMPT_FAILED",
      failure: { attemptId: "attempt", kind: "context_overflow", reason: "context overflow", conversationId: "conversation" },
    }));
    expect(failed.state.context.committed.attempts[0]).toMatchObject({ state: { _tag: "failed" }, conversationId: null });

    const resumed = acknowledge(transitionWorkflow(failed.state, { type: "RESUME", readers: {} }));
    expect(resumed.state.context.committed.attempts.filter(({ provenance }) => provenance._tag !== "continuation").map(({ id, state }) => [id, state._tag])).toEqual([["attempt", "failed"], ["attempt-2", "pending"]]);
    expect(resumed.command).toMatchObject({ kind: "prepare_attempt", attempt: { conversationId: null } });
    expect(resumed.state.context.committed.attempts.find(({ provenance }) => provenance._tag === "continuation")).toMatchObject({
      parentAttemptId: "attempt", state: { _tag: "pending" },
      provenance: { _tag: "continuation", reason: "overflow", chargeAttemptId: "attempt", sourceConversationId: null },
    });
  });

  it("continues an agent whose conversation overflowed after tool calls in a new conversation, and fails one that made none", () => {
    const overflow = (toolUses: number) => ({
      type: "ATTEMPT_FAILED",
      failure: { attemptId: "attempt", kind: "context_overflow", reason: "context overflow", conversationId: "conversation", toolUses },
    } as const);
    const continued = acknowledge(transitionWorkflow(replayWorkflow(failingSourceControl()), overflow(4)));
    expect(continued.state.context.committed.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "running"], ["reader", "pending"], ["independent", "ready"]]);
    expect(continued.state.context.committed.attempts.slice(0, 2)).toMatchObject([
      { id: "attempt", state: { _tag: "failed" }, conversationId: null },
      { parentAttemptId: "attempt", state: { _tag: "pending" }, conversationId: null, provenance: { _tag: "continuation", reason: "overflow", sourceConversationId: null, chargeAttemptId: "attempt" } },
    ]);
    expect(continued.command).toMatchObject({ kind: "prepare_attempt", attempt: { definitionId: "work", provenance: { _tag: "continuation", reason: "overflow" } } });

    const failed = acknowledge(transitionWorkflow(replayWorkflow(failingSourceControl()), overflow(0)));
    expect(failed.state.context.committed.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "failed"], ["reader", "blocked"], ["independent", "ready"]]);
    expect(failed.state.context.committed.attempts).toHaveLength(failingSourceControl().attempts.length);
    expect(failed.state.context.committed.attempts[0]?.state).toMatchObject({ _tag: "failed", reason: "context overflow" });
    // A proposal of encoding 13 failed the step for every overflow, and strict replay keeps that.
    const recorded = acknowledge(transitionDecodedWorkflow(replayWorkflow(failingSourceControl()), overflow(4), 13));
    expect(recorded.state.context.committed.graph.nodes[0]?.state._tag).toBe("failed");
  });

  it("keeps a completed run complete: a Resume proposes nothing", () => {
    const completed = acknowledge(success(replayWorkflow(runningControl()), {}));
    expect(completed.state.lifecycle).toBe("completed");
    const resumed = transitionWorkflow(completed.state, { type: "RESUME", readers: {} });
    expect(resumed.state.lifecycle).toBe("completed");
    expect(resumed.state.context.pending).toBeNull();
    expect(resumed.command).toEqual({ kind: "none" });
  });

  it("re-derives a recorded encoding 7 failure as the pause that it recorded", () => {
    const failure = { attemptId: "attempt", kind: "fatal", reason: "unauthorized", conversationId: "conversation" } as const;
    const proposed = transitionDecodedWorkflow(replayWorkflow(failingSourceControl()), { type: "ATTEMPT_FAILED", failure }, 7);
    expect(proposed.state.context.pending?.facts.map(({ type, version }) => `${type}@${version}`)).toEqual(["attempt.reverted@1", "workflow.control.committed@7"]);
    const paused = acknowledge(proposed);
    expect(paused.state.lifecycle).toBe("paused");
    expect(paused.state.context.committed.attempts[0]).toMatchObject({ state: { _tag: "pending" }, conversationId: "conversation" });

    const overflow = acknowledge(transitionDecodedWorkflow(replayWorkflow(runningControl()), {
      type: "ATTEMPT_FAILED",
      failure: { ...failure, kind: "context_overflow" },
    }, 7));
    expect(overflow.state.context.committed.attempts[0]).toMatchObject({ state: { _tag: "pending" }, conversationId: null });
  });
});

// Failed, but resumable: the run ends as failed and the parent learns at
// once. A later Resume runs only the failed steps again and keeps every
// finished one, so no finished agent call runs twice.
describe("a Resume of a run that a failed step ended", () => {
  /** `work` completes and `review`, the last step, fails. */
  async function failedRun() {
    const store = createMemoryStore(initialFacts(sequentialWorkflow))
    const result = await testHost(store, {
      workflow: sequentialWorkflow,
      attemptRunner: {
        run: async (input, active) => input.definitionId === "work"
          ? { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "work" }, reassessment: null }
          : { kind: "fatal", attemptId: input.attemptId, conversationId: active.conversationId, reason: "fatal error - unauthorized", toolUses: 5 },
      },
    }).run()
    expect(result.kind).toBe("failed")
    expect(loadQueueFromEvents(store.events)?.attempts.find(({ definitionId }) => definitionId === "review")?.toolUses).toBe(5)
    return store
  }

  it("runs only the failed step again, and the run then completes", async () => {
    const store = await failedRun()
    expect(resumesFailedAgents(store.events, replayWorkflowControl(store.events))).toBe(true)
    const ran: string[] = []
    const resumed = await testHost(store, {
      workflow: sequentialWorkflow,
      startMode: "operator_resume",
      conversationId: () => "new-conversation",
      attemptRunner: {
        run: async (input, active) => {
          ran.push(`${input.definitionId}:${active.conversationId}`)
          return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "review" }, reassessment: null }
        },
      },
    }).run()
    expect(resumed.kind).toBe("completed")
    expect(ran).toEqual(["review:new-conversation"])
    const control = replayWorkflowControl(store.events)
    expect(control.attempts.map(({ definitionId, state }) => [definitionId, state._tag])).toEqual([["work", "completed"], ["review", "failed"], ["review", "completed"]])
    expect(store.events.filter(({ type }) => type === "attempt.started")).toHaveLength(3)
    // The parent's completion names no failed step once the step finished.
    const queue = loadQueueFromEvents(store.events)
    expect(failedAgents(store.events, queue?.attempts ?? [])).toEqual([])
  })

  it("tells the parent which agent failed and that a Resume runs it again", async () => {
    const store = await failedRun()
    const queue = loadQueueFromEvents(store.events)
    if (!queue) throw new Error("Expected the failed workflow queue")
    const content = workflowCompletionContent({
      status: "failed", label: "Host sequential", sessionId: "session",
      results: agentResults(store.events, queue), handoff: null, tree: queue.tree,
      failedAgents: failedAgents(store.events, queue?.attempts ?? []),
      resumable: resumesFailedAgents(store.events, replayWorkflowControl(store.events)),
    })
    expect(content).toContain(`1 agent failed: "Review" (fatal error - unauthorized).`)
    // The parent reads each agent's result, failed ones as such, in graph order.
    expect(content).toContain("Agent results, in the order of the workflow:\n\n## work: completed\n\n### Summary\nwork\n\n## review: failed (fatal error - unauthorized)")
    expect(content).toContain(`A Resume runs the failed agents and the agents that wait on them again, and every finished agent that does not read a failed agent's output keeps its result: use process action "resume" with process_id "session".`)
  })

  it("leaves a run that failed at encoding 7 or earlier failed", async () => {
    const store = await failedRun()
    const last = store.events.findLastIndex(({ type }) => type === "workflow.control.committed")
    const recorded = store.events.map((event, index) => index === last ? { ...event, version: 7 } : event)
    expect(resumesFailedAgents(recorded, replayWorkflowControl(store.events))).toBe(false)
  })
})
