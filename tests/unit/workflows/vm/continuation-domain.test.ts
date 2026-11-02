import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js";
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js";
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js";
import type { WorkflowTransitionResult } from "../../../../src/workflows/vm/commands.js";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import type { WorkflowEvent } from "../../../../src/workflows/vm/events.js";
import { testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { buildWorkflowControlInitializedFact, type WorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import { initializeWorkflow, replayWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js";
import { acknowledge, runningControl } from "./_machine-semantics-fixtures.js";
import histories from "./golden/committed-v2-histories.json";
import { queuedAttempts } from "../../../../src/workflows/vm/structural-admission.js";

const handoff = { outcome: { state: "blocked", reason: "The required contract is missing", evidence: "The referenced contract does not exist in the repository" } };
const review = { step: "review", when: null, then: null } as const;

function driver(control: ReturnType<typeof runningControl>) {
  const root = buildWorkflowControlInitializedFact(control);
  const facts: WorkflowSessionFact[] = [root];
  let state = replayWorkflow(root.payload.control);
  return {
    control: () => state.context.committed,
    send(event: WorkflowEvent) {
      const result = transitionWorkflow(state, event);
      const pending = result.state.context.pending;
      if (!pending) throw new Error("Expected proposal");
      facts.push(...pending.facts);
      state = acknowledge(result).state;
      expect(replayWorkflowControl(facts)).toEqual(state.context.committed);
      expect(pending.facts.at(-1)?.version).toBe(14);
      return state.context.committed;
    },
  };
}

const success = (attemptId: string, conversationId: string): WorkflowEvent => ({ type: "ATTEMPT_SUCCEEDED", outcome: { attemptId, conversationId, handoff: {}, reassessment: null } });

// The blocks below are stored ATTEMPT_BLOCKED commits as a build before blocked
// retirement wrote them, with the corrective definition it resolved. Replay
// still verifies each route against the authored graph.
describe("lineage-selected authored continuation", () => {
  it("reopens at exact attempt and insert bounds without buying another retry or mutation allowance", () => {
    const initial = runningControl({ retry: { max: 2, stuck: false } });
    const run = driver({ ...initial, guardrails: { ...initial.guardrails, maxAttempts: 2, maxInserts: 0, insertsUsed: 0,
      attemptMutationsUsed: initial.guardrails.attemptMutationsUsed.map((entry) => ({ ...entry, used: initial.guardrails.maxMutationsPerAttempt })) } });
    run.send({ type: "ATTEMPT_FAILED", failure: { attemptId: "attempt", kind: "handoff", reason: "retry", conversationId: "conversation" } });
    run.send({ type: "ATTEMPT_STARTED", attemptId: "node:attempt:2", conversationId: "retry" });
    const failed = run.send({ type: "ATTEMPT_FAILED", failure: { attemptId: "node:attempt:2", kind: "fatal", reason: "reopen", conversationId: "retry" } });
    const reopened = run.send({ type: "RESUME", readers: {} });
    const successor = reopened.attempts.at(-1);
    expect(successor).toMatchObject({ id: "node:attempt:3", iteration: 2, resumeRevertCount: failed.attempts[1]?.resumeRevertCount,
      parentAttemptId: "node:attempt:2", provenance: { _tag: "continuation", chargeAttemptId: "node:attempt:2", sourceConversationId: "retry" } });
    expect(queuedAttempts(reopened)).toBe(2);
    expect(reopened.guardrails.insertsUsed).toBe(0);
    run.send({ type: "ATTEMPT_STARTED", attemptId: "node:attempt:3", conversationId: "reopened" });
    const exhausted = run.send({ type: "ATTEMPT_FAILED", failure: { attemptId: "node:attempt:3", kind: "handoff", reason: "no retry remains", conversationId: "reopened" } });
    expect(exhausted.status).toBe("failed");
    expect(exhausted.attempts).toHaveLength(3);
    const again = run.send({ type: "RESUME", readers: {} });
    expect(again.attempts.at(-1)).toMatchObject({ iteration: 2, provenance: { chargeAttemptId: "node:attempt:2" } });
    expect(queuedAttempts(again)).toBe(2);
    run.send({ type: "ATTEMPT_STARTED", attemptId: "node:attempt:4", conversationId: "fixed" });
    const completed = run.send(success("node:attempt:4", "fixed"));
    expect(completed.status).toBe("completed");
    expect(completed.attempts.slice(0, 3).map(({ state }) => state._tag)).toEqual(["failed", "failed", "failed"]);
  });
  it("routes a stored blocked root retry to its unconditional reassessment with parent linkage", () => {
    const run = driver(runningControl({ retry: { max: 3, stuck: false }, then: review }));
    run.send({ type: "ATTEMPT_FAILED", failure: { attemptId: "attempt", reason: "retry", kind: "handoff", conversationId: "conversation" } });
    run.send({ type: "ATTEMPT_STARTED", attemptId: "node:attempt:2", conversationId: "retry" });
    const control = run.send({ type: "ATTEMPT_BLOCKED", blocked: { attemptId: "node:attempt:2", conversationId: "retry", handoff }, correctiveDefinitionId: "review" });
    expect(control.attempts.at(-1)).toMatchObject({ definitionId: "review", parentAttemptId: "node:attempt:2", provenance: { _tag: "followUpV10" }, state: { _tag: "pending" } });
    expect(control.attempts[1]?.state._tag).toBe("blocked");
    expect(control.status).toBe("ready");
  });

  it("verifies a stored corrective route against the authored position, not the first repeated binding", () => {
    const run = driver(runningControl({ then: { step: "work", when: null, then: { step: "work", when: null, then: review } } }));
    run.send(success("attempt", "conversation"));
    run.send({ type: "ATTEMPT_STARTED", attemptId: "node:attempt:2", conversationId: "second" });
    run.send(success("node:attempt:2", "second"));
    run.send({ type: "ATTEMPT_STARTED", attemptId: "node:attempt:3", conversationId: "third" });
    const control = run.control();
    expect(() => transitionWorkflow(replayWorkflow(control), { type: "ATTEMPT_BLOCKED", blocked: { attemptId: "node:attempt:3", conversationId: "third", handoff }, correctiveDefinitionId: "work" })).toThrow("authored continuation");
    const routed = run.send({ type: "ATTEMPT_BLOCKED", blocked: { attemptId: "node:attempt:3", conversationId: "third", handoff }, correctiveDefinitionId: "review" });
    expect(routed.attempts.at(-1)).toMatchObject({ definitionId: "review", parentAttemptId: "node:attempt:3" });
  });

  it.each(["gated", "ineligible"] as const)("fails a stored block when its next unit is %s", (kind) => {
    const run = driver(runningControl({ then: { ...review, when: kind === "gated" ? "completed" : null } }));
    const correctiveDefinitionId = null;
    if (kind === "gated") expect(() => transitionWorkflow(replayWorkflow(run.control()), { type: "ATTEMPT_BLOCKED", blocked: { attemptId: "attempt", conversationId: "conversation", handoff }, correctiveDefinitionId: "review" })).toThrow("authored continuation");
    const failed = run.send({ type: "ATTEMPT_BLOCKED", blocked: { attemptId: "attempt", conversationId: "conversation", handoff }, correctiveDefinitionId });
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toHaveLength(1);
    expect(failed.attempts[0]?.state._tag).toBe("blocked");
  });

  it("uses current lineage when completing a retry from a historical prefix", () => {
    const prefix = histories.retry.slice(0, 5);
    const previous = replayWorkflowControl(prefix);
    const result = transitionWorkflow(replayWorkflow(previous), success("node:attempt:2", "retry-conversation"));
    const pending = result.state.context.pending;
    if (!pending) throw new Error("Expected proposal");
    expect(pending.proposedCommitted.attempts.at(-1)).toMatchObject({ definitionId: "review", parentAttemptId: "node:attempt:2" });
    expect(pending.proposedCommitted.status).toBe("ready");
    expect(replayWorkflowControl([...prefix, ...pending.facts])).toEqual(pending.proposedCommitted);
  });
});

/** Run one repeat through the production machine, after a source phase
 *  that lists two items, with every attempt succeeding. Returns the
 *  repeat's attempts in queue order, each with its node id relative to the
 *  repeat. */
function runRepeat(
  repeat: { readonly [key: string]: unknown },
  phases: readonly string[],
  handoffFor: (definitionId: string, invocation: number) => { [key: string]: unknown } = () => ({ summary: "done" }),
  source: { readonly bounds?: { readonly max?: number; readonly unique?: string }; readonly items?: readonly object[]; readonly status?: CommittedWorkflowControl["status"] } = {},
) {
  const skills = testSkillRevision([]);
  const list = { type: "list", optional: true, description: "Items.", of: { type: "object", fields: { id: { type: "string", description: "Id." } } } };
  const { optional: _optional, ...requiredList } = list;
  const output = { summary: "Done.", fields: { findings: list } };
  const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    id: "loop", name: "Loop",
    phases: [
      { phase: "source", brief: "Plan.", name: "source", output: { summary: "Plan.", fields: { items: { ...requiredList, ...(source.bounds ?? { max: 2, unique: "id" }) } } }, writes: [] },
      {
        repeat,
        phases: phases.map((phase) => phase === "a2"
          ? { phase, runs: "a", name: phase, writes: [] }
          : { phase, brief: `Do ${phase}.`, name: phase, output, writes: [] }),
      },
    ],
  });
  const root = buildWorkflowControlInitializedFact(compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills }));
  const facts: WorkflowSessionFact[] = [root];
  const commit = (result: WorkflowTransitionResult): WorkflowTransitionResult => {
    facts.push(...(result.state.context.pending?.facts ?? []));
    return acknowledge(result);
  };
  const invocations = new Map<string, number>();
  let state = commit(transitionWorkflow(initializeWorkflow(root.payload.control).state, { type: "START" }));
  while (state.command.kind === "prepare_attempt") {
    const { attemptId, definitionId } = state.command.attempt;
    const invocation = (invocations.get(definitionId) ?? 0) + 1;
    invocations.set(definitionId, invocation);
    state = commit(transitionWorkflow(state.state, { type: "ATTEMPT_STARTED", attemptId, conversationId: attemptId }));
    const result = definitionId === "source" ? { summary: "two", items: source.items ?? [{ id: "x" }, { id: "y" }] } : handoffFor(definitionId, invocation);
    state = commit(transitionWorkflow(state.state, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId, conversationId: attemptId, handoff: result, reassessment: null } }));
  }
  const control = state.state.context.committed;
  expect(control.status).toBe(source.status ?? "completed");
  expect(replayWorkflowControl(facts)).toEqual(control);
  const local = (id: string) => id.slice("loop:node:2:".length);
  const rejected = facts.find(({ type }) => type === "group.expansion_rejected")?.payload;
  if (control.status === "failed") return [{ node: "", definitionId: "", provenance: null, item: null, state: rejected !== undefined && "reason" in rejected ? String(rejected.reason) : "" }];
  return control.attempts.filter(({ logicalNodeId }) => logicalNodeId.startsWith("loop:node:2:"))
    .map(({ logicalNodeId, definitionId, provenance, item, state: { _tag } }) => ({ node: local(logicalNodeId), definitionId, provenance, item, state: _tag }));
}

describe("repeat rounds", () => {
  it("runs each phase of an each round after the phase before it, one item after another", () => {
    expect(runRepeat({ each: "source.items" }, ["a", "b", "c"]).map(({ node, definitionId, item }) => [node, definitionId, item])).toEqual([
      ["round:1:node:1", "a", { id: "x" }], ["round:1:node:2", "b", { id: "x" }], ["round:1:node:3", "c", { id: "x" }],
      ["round:2:node:1", "a", { id: "y" }], ["round:2:node:2", "b", { id: "y" }], ["round:2:node:3", "c", { id: "y" }],
    ]);
  });

  // A `for` of a build before phases ran over a list that declares no max
  // or unique key, such as the plan list of the shipped plan contract, so a
  // converted file keeps working: the repeat holds the items the list has
  // when it opens, and the attempt limit bounds them.
  it("runs an each repeat over a list without a declared max or unique key, within the attempt limit", () => {
    const rounds = runRepeat({ each: "source.items" }, ["a"], undefined, { bounds: {}, items: [{ id: "x" }, { id: "y" }, { id: "z" }] });
    expect(rounds.map(({ node, item }) => [node, item])).toEqual([["round:1:node:1", { id: "x" }], ["round:2:node:1", { id: "y" }], ["round:3:node:1", { id: "z" }]]);
    // The source attempt and one attempt for each of 50 items pass the
    // default attempt limit of 50.
    const refused = runRepeat({ each: "source.items" }, ["a"], undefined, { bounds: {}, items: Array.from({ length: 50 }, (_, index) => ({ id: `item-${index}` })), status: "failed" });
    expect(refused[0]?.state).toBe('source "loop:node:1.items" holds 50 items, whose rounds need more attempts than the attempt limit of 50');
  });

  it("runs a second phase of one brief as its own agent, with round 1 from compile and each later round from its repeat", () => {
    expect(runRepeat({ each: "source.items" }, ["a", "a2"]).map(({ node, definitionId, provenance }) => [node, definitionId, provenance])).toEqual([
      ["round:1:node:1", "a", { _tag: "authored" }], ["round:1:node:2", "a2", { _tag: "authored" }],
      ["round:2:node:1", "a", { _tag: "round", index: 2 }], ["round:2:node:2", "a2", { _tag: "round", index: 2 }],
    ]);
  });

  it("runs the phases after the while phase in each live round before the bound, and skips them at the bound and when the field is empty", () => {
    const live = () => ({ summary: "open", findings: [{ id: "f" }] });
    // The repeat ends on its check: a live check in the last round stops it.
    const bounded = runRepeat({ while: "b.findings", max: 2 }, ["a", "b", "c"], live);
    expect(bounded.map(({ node, state }) => [node, state])).toEqual([
      ["round:1:node:1", "completed"], ["round:1:node:2", "completed"], ["round:1:node:3", "completed"],
      ["round:2:node:1", "completed"], ["round:2:node:2", "completed"], ["round:2:node:3", "skipped"],
    ]);
    const halted = runRepeat({ while: "b.findings", max: 3 }, ["a", "b", "c"], (_id, invocation) => invocation === 1 ? live() : { summary: "clean", findings: [] });
    expect(halted.map(({ node, state }) => [node, state])).toEqual([
      ["round:1:node:1", "completed"], ["round:1:node:2", "completed"], ["round:1:node:3", "completed"],
      ["round:2:node:1", "completed"], ["round:2:node:2", "completed"], ["round:2:node:3", "skipped"],
    ]);
    const first = runRepeat({ while: "b.findings", max: 3 }, ["a", "b", "c"], () => ({ summary: "clean", findings: [] }));
    expect(first.map(({ node, state }) => [node, state])).toEqual([["round:1:node:1", "completed"], ["round:1:node:2", "completed"], ["round:1:node:3", "skipped"]]);
  });
});
