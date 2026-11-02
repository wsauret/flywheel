import { describe, expect, it } from "bun:test";
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js";
import { Schema } from "effect";
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js";
import { composeWorkflowCompanions } from "../../../../src/workflows/vm/companions.js";
import type { RequestAddendumMessage } from "../../../../src/workflows/context-bundle/context-facts.js";
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js";
import { testResolvedAgent, testResolvedAgents, testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { initializeWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js";

const workWrites = [{ id: "artifact", lifetime: "durable" as const, supersedes: [] }];
const workSkill = testSkill("work", { name: "Work", body: "Work." });
const skills = testSkillRevision([workSkill]);

const work = testResolvedAgent("work", workSkill, { writes: workWrites });

const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "companions",
  name: "Companions",
  phases: [{ phase: "work", name: "Work", brief: "Work.", writes: workWrites }],
});
function running() {
  const compiled = compileWorkflowControl(workflow, testResolvedAgents([work]), { skills });
  const started = transitionWorkflow(initializeWorkflow(compiled).state, {
    type: "ATTEMPT_STARTED",
    attemptId: compiled.attempts[0]?.id ?? "missing",
    conversationId: "conversation-1",
  });
  const pending = started.state.context.pending;
  if (!pending) throw new Error("start proposal missing");
  const acknowledged = transitionWorkflow(started.state, {
    type: "COMMIT_SUCCEEDED",
    proposalId: pending.proposalId,
    aggregateSeq: pending.proposedCommitted.aggregateSeq,
  });
  return { control: acknowledged.state.context.committed, state: acknowledged.state };
}

function factsFor(event: Parameters<typeof transitionWorkflow>[1], addenda: readonly RequestAddendumMessage[] = []) {
  const active = running();
  const proposal = transitionWorkflow(active.state, event);
  return composeWorkflowCompanions(proposal, {
    queue: flattenWorkflowView(active.control, testResolvedAgents([work])),
    resolvedAgents: testResolvedAgents([work]),
    timestamp: 100,
    addenda,
  });
}

const parentMessages: readonly RequestAddendumMessage[] = [
  { key: "msg:parent:call-1", source: { kind: "parent", name: "Planner" }, text: "Also cover Windows." },
  { key: "msg:parent:call-2", source: { kind: "parent", name: "Planner" }, text: "Skip the docs.", personWords: "no docs", attachmentCount: 1 },
];

function attemptFailure(attemptId: string, kind: "handoff" | "transient" | "context_overflow" | "fatal" | "invalid_handoff" | "missing_handoff") {
  const fields = { attemptId, reason: "failed", conversationId: "conversation-1" };
  if (kind === "invalid_handoff") return { ...fields, kind, content: { raw: true }, issues: [] };
  return { ...fields, kind };
}

describe("workflow proposal companions", () => {
  it("orders successful handoff evidence, context, queue, and control atomically", () => {
    const active = running();
    const composed = factsFor({
      type: "ATTEMPT_SUCCEEDED",
      outcome: {
        attemptId: active.control.attempts[0]?.id ?? "missing",
        conversationId: "conversation-1",
        handoff: { summary: "done" },
        reassessment: null,
      },
    });
    if (composed.command.kind !== "commit") throw new Error("completion did not commit");
    const types = composed.command.proposal.facts.map(({ type }) => type);

    expect(types.slice(0, 3)).toEqual([
      "handoff.written",
      "handoff.validated",
      "context.accumulated",
    ]);
    expect(types.indexOf("step.status.changed")).toBeGreaterThan(types.indexOf("context.accumulated"));
    expect(composed.command.proposal.facts.find(({ type }) => type === "context.accumulated")).toMatchObject({
      version: 6,
      payload: { entry: { writes: [{ id: "artifact", lifetime: "durable", supersedes: [] }] } },
    });
    expect(types.at(-1)).toBe("workflow.control.committed");
  });

  it("preserves invalid captured content and typed issues", () => {
    const active = running();
    const composed = factsFor({
      type: "ATTEMPT_FAILED",
      failure: {
        attemptId: active.control.attempts[0]?.id ?? "missing",
        kind: "invalid_handoff",
        reason: "summary is required",
        conversationId: "conversation-1",
        content: { raw: true },
        issues: [{ path: "summary", message: "required" }],
      },
    });
    if (composed.command.kind !== "commit") throw new Error("failure did not commit");
    expect(composed.command.proposal.facts.slice(0, 2)).toMatchObject([
      { type: "handoff.written", payload: { content: { raw: true } } },
      { type: "handoff.validated", payload: { status: "failed", issues: [{ path: "summary", message: "required" }] } },
    ]);
  });

  it("writes no handoff evidence for a missing handoff", () => {
    const active = running();
    const composed = factsFor({
      type: "ATTEMPT_FAILED",
      failure: {
        attemptId: active.control.attempts[0]?.id ?? "missing",
        kind: "missing_handoff",
        reason: "missing handoff",
        conversationId: "conversation-1",
      },
    });
    if (composed.command.kind !== "commit") throw new Error("failure did not commit");
    expect(composed.command.proposal.facts.some(({ type }) => type.startsWith("handoff."))).toBe(false);
  });

  it("records the parent messages of a settled attempt before its handoff evidence", () => {
    const active = running();
    const attemptId = active.control.attempts[0]?.id ?? "missing";
    const composed = factsFor({
      type: "ATTEMPT_SUCCEEDED",
      outcome: { attemptId, conversationId: "conversation-1", handoff: { summary: "done" }, reassessment: null },
    }, parentMessages);
    if (composed.command.kind !== "commit") throw new Error("completion did not commit");
    const facts = composed.command.proposal.facts;
    expect(facts.slice(0, 3).map(({ type }) => type)).toEqual(["step_context.input.added", "step_context.input.added", "handoff.written"]);
    expect(facts.slice(0, 2).map(({ payload }) => payload)).toEqual([
      { ...parentMessages[0], readBy: { attemptId, agentName: "Work", conversationId: "conversation-1" } },
      { ...parentMessages[1], readBy: { attemptId, agentName: "Work", conversationId: "conversation-1" } },
    ]);
  });

  it.each(["handoff", "transient", "context_overflow", "fatal", "invalid_handoff", "missing_handoff"] as const)("records the parent messages of an attempt that failed with %s", (kind) => {
    const attemptId = running().control.attempts[0]?.id ?? "missing";
    const composed = factsFor({ type: "ATTEMPT_FAILED", failure: attemptFailure(attemptId, kind) }, parentMessages);
    if (composed.command.kind !== "commit") throw new Error("failure did not commit");
    const types = composed.command.proposal.facts.map(({ type }) => type);
    expect(types.slice(0, 2)).toEqual(["step_context.input.added", "step_context.input.added"]);
    expect(types.filter((type) => type === "step_context.input.added")).toHaveLength(2);
    expect(composed.command.proposal.facts.slice(0, 2).map(({ payload }) => payload)).toMatchObject([
      { key: "msg:parent:call-1", readBy: { attemptId, conversationId: "conversation-1" } },
      { key: "msg:parent:call-2", readBy: { attemptId, conversationId: "conversation-1" } },
    ]);
  });

  it("records no addendum for a commit that settles no attempt and refuses addenda for one", () => {
    const paused = factsFor({ type: "PAUSE", reason: "operator" });
    if (paused.command.kind !== "commit") throw new Error("pause did not commit");
    expect(paused.command.proposal.facts.some(({ type }) => type === "step_context.input.added")).toBe(false);
    expect(() => factsFor({ type: "PAUSE", reason: "operator" }, parentMessages)).toThrow("settles no attempt");
  });

  it("commits a follow-up conversation identity before the run command", () => {
    const active = running();
    const completedControl = {
      ...active.control,
      graph: {
        ...active.control.graph,
        nodes: active.control.graph.nodes.map((node) => ({ ...node, state: { _tag: "completed" as const } })),
      },
      attempts: active.control.attempts.map((attempt) => ({ ...attempt, state: { _tag: "completed" as const } })),
      status: "completed" as const,
    };
    const completed = initializeWorkflow(completedControl);
    const proposal = transitionWorkflow(completed.state, {
      type: "FOLLOW_UP_REQUESTED",
      input: { text: "Explain" },
      identity: { kind: "identified", inputID: "input-1" },
      conversationId: "follow-up-1",
      requestSequence: 1,
    });
    const composed = composeWorkflowCompanions(proposal, {
      queue: flattenWorkflowView(completedControl, testResolvedAgents([work])),
      resolvedAgents: testResolvedAgents([work]),
      timestamp: 100,
      addenda: [],
    });
    if (composed.command.kind !== "commit") throw new Error("follow-up did not commit");
    expect(composed.command.proposal.facts.map(({ type }) => type)).toEqual([
      "follow_up.resume_state.recorded",
      "follow_up.requested",
      "workflow.control.committed",
    ]);
    const acknowledged = transitionWorkflow(composed.state, {
      type: "COMMIT_SUCCEEDED",
      proposalId: composed.command.proposal.proposalId,
      aggregateSeq: composed.state.context.pending?.proposedCommitted.aggregateSeq ?? 0,
    });
    expect(acknowledged.command).toMatchObject({
      kind: "run_follow_up",
      input: { input: { text: "Explain" }, conversationId: "follow-up-1", requestSequence: 1 },
    });
  });
});
