import { describe, expect, it } from "bun:test";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/facts/committed-control.js";
import { initializeWorkflow, replayDecodedWorkflow, transitionDecodedWorkflow } from "../../../../src/workflows/vm/control/transition.js";
import { acknowledge, runningControl, startPreparedAttempt, success } from "./_machine-semantics-fixtures.js";
import { createMemoryStore, initialFacts, sequentialWorkflow, testHost, waitFor } from "./host-test-support.js";
import { replayWorkflowControl, resumesFailedAgents, resumesFailedAgentsWith, resumesLiveFailedAgents } from "../../../../src/workflows/vm/recovery/fact-fold.js";
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile/compile.js";
import { resolveWorkflowAgents } from "../../../../src/workflows/definitions/agent-resolution.js";
import { buildWorkflowControlInitializedFact, type WorkflowSessionFact } from "../../../../src/workflows/vm/facts/session-facts.js";
import { CURRENT_PROPOSAL_ENCODING } from "../../../../src/workflows/vm/facts/events.js";
import type { WorkflowTransitionResult } from "../../../../src/workflows/vm/control/commands.js";
import type { WorkflowDefinition } from "../../../../src/workflows/schema/workflow-schema.js";
import { testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { loadedWorkflow } from "../../../helpers/workflow-files.js";
import { failedAgents, agentResults, workflowCompletionContent } from "../../../../src/workflows/run/workflow-completion.js";
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
    const failed = acknowledge(transitionDecodedWorkflow(replayDecodedWorkflow(failingSourceControl()), {
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
    const failed = acknowledge(transitionDecodedWorkflow(replayDecodedWorkflow(runningControl()), fatal("attempt")));
    expect(failed.state.lifecycle).toBe("failed");
    expect(failed.state.context.committed.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "failed"]]);
  });

  it("completes the run when a failed step's output is read by no step and is not the result", () => {
    const control = failingSourceControl();
    const free: CommittedWorkflowControl = { ...control, graph: { ...control.graph, dependencies: [{ nodeId: "independent", dependsOn: "reader" }] } };
    const failed = acknowledge(transitionDecodedWorkflow(replayDecodedWorkflow(free), fatal("attempt")));
    const reader = acknowledge(success(startPreparedAttempt(failed).state, {}, "reader:attempt"));
    const settled = acknowledge(success(startPreparedAttempt(reader).state, {}, "independent:attempt"));
    expect(settled.state.lifecycle).toBe("completed");
    expect(settled.state.context.committed.attempts.map(({ definitionId, state }) => [definitionId, state._tag]))
      .toEqual([["work", "failed"], ["follow", "completed"], ["nested", "completed"]]);
  });

  // A follow-up exists only in control from before phases.
  it("fails the node of a failed follow-up step, so the step that reads it does not run", () => {
    const followed = acknowledge(success(replayDecodedWorkflow(withReader(runningControl({ then: { step: "follow", when: null, then: null } }))), {}));
    const follow = startPreparedAttempt(followed);
    const followId = follow.state.context.committed.attempts.find(({ definitionId }) => definitionId === "follow")!.id;
    const failed = acknowledge(transitionDecodedWorkflow(follow.state, fatal(followId)));
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
    const failed = acknowledge(transitionDecodedWorkflow(replayDecodedWorkflow(loop), fatal("attempt")));
    expect(failed.state.context.committed.attempts.map(({ id, state }) => [id, state._tag]))
      .toEqual([["attempt", "failed"], ["attempt-2", "skipped"], ["reader:attempt", "pending"]]);
    expect(failed.state.context.committed.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "failed"], ["reader", "blocked"]]);
    expect(failed.state.lifecycle).toBe("failed");
  });

  it("resumes a failed run by running only its failed step and the work that waited on it", () => {
    const failed = acknowledge(transitionDecodedWorkflow(replayDecodedWorkflow(failingSourceControl()), fatal("attempt")));
    const ended = acknowledge(success(startPreparedAttempt(failed).state, {}, "independent:attempt"));
    expect(ended.state.lifecycle).toBe("failed");

    const resumed = acknowledge(transitionDecodedWorkflow(ended.state, { type: "RESUME", readers: {} }));
    expect(resumed.state.context.committed.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "ready"], ["reader", "pending"], ["independent", "completed"]]);
    // The failed agent continues in its own conversation.
    expect(resumed.command).toMatchObject({ kind: "prepare_attempt", attempt: { conversationId: "conversation" } });
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
    const failed = acknowledge(transitionDecodedWorkflow(replayDecodedWorkflow(loop), {
      type: "ATTEMPT_FAILED",
      failure: { attemptId: "attempt", kind: "context_overflow", reason: "context overflow", conversationId: "conversation" },
    }));
    expect(failed.state.context.committed.attempts[0]).toMatchObject({ state: { _tag: "failed" }, conversationId: null });

    const resumed = acknowledge(transitionDecodedWorkflow(failed.state, { type: "RESUME", readers: {} }));
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
    const continued = acknowledge(transitionDecodedWorkflow(replayDecodedWorkflow(failingSourceControl()), overflow(4)));
    expect(continued.state.context.committed.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "running"], ["reader", "pending"], ["independent", "ready"]]);
    expect(continued.state.context.committed.attempts.slice(0, 2)).toMatchObject([
      { id: "attempt", state: { _tag: "failed" }, conversationId: null },
      { parentAttemptId: "attempt", state: { _tag: "pending" }, conversationId: null, provenance: { _tag: "continuation", reason: "overflow", sourceConversationId: null, chargeAttemptId: "attempt" } },
    ]);
    expect(continued.command).toMatchObject({ kind: "prepare_attempt", attempt: { definitionId: "work", provenance: { _tag: "continuation", reason: "overflow" } } });

    const failed = acknowledge(transitionDecodedWorkflow(replayDecodedWorkflow(failingSourceControl()), overflow(0)));
    expect(failed.state.context.committed.graph.nodes.map(({ id, state }) => [id, state._tag])).toEqual([["node", "failed"], ["reader", "blocked"], ["independent", "ready"]]);
    expect(failed.state.context.committed.attempts).toHaveLength(failingSourceControl().attempts.length);
    expect(failed.state.context.committed.attempts[0]?.state).toMatchObject({ _tag: "failed", reason: "context overflow" });
    // A proposal of encoding 13 failed the step for every overflow, and strict replay keeps that.
    const recorded = acknowledge(transitionDecodedWorkflow(replayDecodedWorkflow(failingSourceControl()), overflow(4), 13));
    expect(recorded.state.context.committed.graph.nodes[0]?.state._tag).toBe("failed");
  });

  it("keeps a completed run complete: a Resume proposes nothing", () => {
    const completed = acknowledge(success(replayDecodedWorkflow(runningControl()), {}));
    expect(completed.state.lifecycle).toBe("completed");
    const resumed = transitionDecodedWorkflow(completed.state, { type: "RESUME", readers: {} });
    expect(resumed.state.lifecycle).toBe("completed");
    expect(resumed.state.context.pending).toBeNull();
    expect(resumed.command).toEqual({ kind: "none" });
  });

  it("re-derives a recorded encoding 7 failure as the pause that it recorded", () => {
    const failure = { attemptId: "attempt", kind: "fatal", reason: "unauthorized", conversationId: "conversation" } as const;
    const proposed = transitionDecodedWorkflow(replayDecodedWorkflow(failingSourceControl()), { type: "ATTEMPT_FAILED", failure }, 7);
    expect(proposed.state.context.pending?.facts.map(({ type, version }) => `${type}@${version}`)).toEqual(["attempt.reverted@1", "workflow.control.committed@7"]);
    const paused = acknowledge(proposed);
    expect(paused.state.lifecycle).toBe("paused");
    expect(paused.state.context.committed.attempts[0]).toMatchObject({ state: { _tag: "pending" }, conversationId: "conversation" });

    const overflow = acknowledge(transitionDecodedWorkflow(replayDecodedWorkflow(runningControl()), {
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

  it("runs only the failed step again, in its own conversation, and the run then completes", async () => {
    const store = await failedRun()
    const failedControl = replayWorkflowControl(store.events)
    expect(resumesFailedAgents(store.events, failedControl)).toBe(true)
    const failedConversation = failedControl.attempts.find(({ definitionId }) => definitionId === "review")?.conversationId
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
    expect(failedConversation).toEqual(expect.any(String))
    expect(ran).toEqual([`review:${failedConversation}`])
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

// A refused expansion fails the run at once. A Resume runs the failed agents
// of such a run again unless the refused list is still ready after the
// reopen, where it would expand again and meet the same refusal first.
describe("a Resume of a failed run that also refused an expansion", () => {
  const itemsList = { type: "list", description: "Items.", max: 2, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "Id." } } } }
  const lister = (phase: string) => ({ phase, brief: `List for ${phase}.`, name: phase, output: { summary: "Listed.", fields: { items: itemsList } }, writes: [] })
  const worker = (phase: string, over: string) => ({ phase, over, brief: `Work one ${phase} item.`, name: phase, writes: [] })

  /** Run `workflow` through the machine until it ends. Each lister lists
   *  the next entry of `lists`, the first item agent fails, and every other
   *  agent succeeds. */
  function refusedRun(workflow: WorkflowDefinition, lists: readonly (readonly string[])[]) {
    const root = buildWorkflowControlInitializedFact(compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: testSkillRevision([]) }))
    const facts: WorkflowSessionFact[] = [root]
    const commit = (result: WorkflowTransitionResult): WorkflowTransitionResult => {
      facts.push(...(result.state.context.pending?.facts ?? []))
      return acknowledge(result)
    }
    let listed = 0
    let failed = false
    let state = commit(transitionDecodedWorkflow(initializeWorkflow(root.payload.control).state, { type: "START" }))
    while (state.command.kind === "prepare_attempt") {
      const { attemptId, definitionId } = state.command.attempt
      state = commit(transitionDecodedWorkflow(state.state, { type: "ATTEMPT_STARTED", attemptId, conversationId: attemptId }))
      const item = state.state.context.committed.attempts.find(({ id }) => id === attemptId)?.ownership._tag === "item"
      if (item && !failed) {
        failed = true
        state = commit(transitionDecodedWorkflow(state.state, { type: "ATTEMPT_FAILED", failure: { attemptId, kind: "fatal", reason: "database or disk is full", conversationId: attemptId } }))
        continue
      }
      const handoff = definitionId.startsWith("list") ? { summary: "Listed.", items: (lists[listed++] ?? []).map((id) => ({ id })) } : { summary: "done" }
      state = commit(transitionDecodedWorkflow(state.state, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId, conversationId: attemptId, handoff, reassessment: null } }))
    }
    const control = state.state.context.committed
    expect(control.status).toBe("failed")
    expect(facts.map(({ type }) => type)).toContain("group.expansion_rejected")
    expect(replayWorkflowControl(facts)).toEqual(control)
    return control
  }

  it("runs the failed item agent again when the refused list waits on it", () => {
    const workflow = loadedWorkflow({ id: "later", name: "Later", phases: [lister("list-a"), worker("work-a", "list-a.items"), lister("list-b"), worker("work-b", "list-b.items")] })
    const control = refusedRun(workflow, [["x", "y"], ["p", "q", "r"]])
    expect(resumesFailedAgentsWith({ endingVersion: CURRENT_PROPOSAL_ENCODING }, control)).toBe(true)
    const resumed = transitionDecodedWorkflow(replayDecodedWorkflow(control), { type: "RESUME", readers: {} })
    expect(resumed.state.context.pending?.proposedCommitted.status).not.toBe("failed")
    expect(resumed.state.context.pending?.facts.map(({ type }) => type)).not.toContain("group.expansion_rejected")
  })

  it("is not offered when the refused list is still ready after the reopen, in a later round of a repeat", () => {
    const workflow = loadedWorkflow({
      id: "rounds", name: "Rounds",
      phases: [lister("list-rounds"), { repeat: { each: "list-rounds.items" }, phases: [lister("list-inner"), worker("work-inner", "list-inner.items")] }],
    })
    const control = refusedRun(workflow, [["a", "b"], ["x", "y"], ["p", "q", "r"]])
    expect(control.attempts.some(({ state }) => state._tag === "failed")).toBe(true)
    expect(resumesFailedAgentsWith({ endingVersion: CURRENT_PROPOSAL_ENCODING }, control)).toBe(false)
    // The Resume that the check refuses would refuse the expansion again.
    const resumed = transitionDecodedWorkflow(replayDecodedWorkflow(control), { type: "RESUME", readers: {} })
    expect(resumed.state.context.pending?.facts.map(({ type }) => type)).toContain("group.expansion_rejected")
  })
})

// A failed agent resumes while the other agents of its run still run, so
// a person who fixed the cause, such as a full disk, continues it at once.
// Its kind of failure never decides whether it resumes.
describe("a Resume of a failed agent while its sibling runs", () => {
  const record = (id: string) => ({ brief: `Do the ${id} work.`, name: id, writes: [] })
  const phaseWorkflow = loadedWorkflow({
    id: "live-resume",
    name: "Live resume",
    phases: [{ phase: "build", agents: [{ agent: "left", ...record("left") }, { agent: "right", ...record("right") }] }, { phase: "ship", ...record("ship") }],
  })

  it("continues the failed agent's conversation inside the live run, runs its dependents after it, and completes the run", async () => {
    const store = createMemoryStore(initialFacts(phaseWorkflow))
    const sibling = Promise.withResolvers<void>()
    const ran: string[] = []
    let conversations = 0
    const host = testHost(store, {
      workflow: phaseWorkflow,
      conversationId: () => `conversation-${++conversations}`,
      attemptRunner: {
        run: async (input, active) => {
          ran.push(`${input.definitionId}:${input.attemptId}`)
          if (input.definitionId === "left" && input.provenance._tag !== "continuation") {
            return { kind: "fatal", attemptId: input.attemptId, conversationId: active.conversationId, reason: "unexpected error - database or disk is full" }
          }
          if (input.definitionId === "right") await sibling.promise
          return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: input.definitionId }, reassessment: null }
        },
      },
    })
    const result = host.run()
    const control = () => replayWorkflowControl(store.events)
    await waitFor(() => control().attempts.some(({ definitionId, state }) => definitionId === "left" && state._tag === "failed"))
    expect(resumesLiveFailedAgents(control())).toBe(true)
    const failed = control().attempts.find(({ definitionId }) => definitionId === "left")

    expect(await host.resumeFailedAgents()).toBe(true)
    await waitFor(() => control().attempts.filter(({ definitionId, state }) => definitionId === "left" && state._tag === "completed").length === 1)
    // The run did not fail while the resumed agent ran, and the next phase
    // waits for the sibling that still runs.
    expect(control().status).toBe("executing")
    expect(ran.some((entry) => entry.startsWith("ship:"))).toBe(false)
    sibling.resolve()

    expect((await result).kind).toBe("completed")
    const left = control().attempts.filter(({ definitionId }) => definitionId === "left")
    expect(left.map(({ state }) => state._tag)).toEqual(["failed", "completed"])
    expect(left[1]).toMatchObject({ parentAttemptId: failed?.id, provenance: { _tag: "continuation", reason: "reopen", sourceConversationId: failed?.conversationId } })
    expect(ran.map((entry) => entry.split(":")[0])).toEqual(["left", "right", "left", "ship"])
    expect(store.events.filter(({ type }) => type === "workflow.resumed")).toHaveLength(1)
  })

  it("refuses a live Resume while no agent failed", async () => {
    const store = createMemoryStore(initialFacts(phaseWorkflow))
    const sibling = Promise.withResolvers<void>()
    const host = testHost(store, {
      workflow: phaseWorkflow,
      conversationId: () => `conversation-${crypto.randomUUID()}`,
      attemptRunner: {
        run: async (input, active) => {
          if (input.definitionId === "right") await sibling.promise
          return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: input.definitionId }, reassessment: null }
        },
      },
    })
    const result = host.run()
    await waitFor(() => replayWorkflowControl(store.events).attempts.some(({ definitionId, state }) => definitionId === "left" && state._tag === "completed"))
    expect(await host.resumeFailedAgents()).toBe(false)
    sibling.resolve()
    expect((await result).kind).toBe("completed")
    expect(store.events.filter(({ type }) => type === "workflow.resumed")).toHaveLength(0)
  })
})
