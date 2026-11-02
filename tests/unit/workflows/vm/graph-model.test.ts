import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { WorkflowGraphSchema } from "../../../../src/workflows/vm/graph-types.js";
import {
  CommittedWorkflowControlSchema,
  parseCommittedWorkflowControl,
} from "../../../../src/workflows/vm/committed-control.js";
import { parsePendingWorkflowCommit } from "../../../../src/workflows/vm/control-types.js";
import { parseWorkflowCommand } from "../../../../src/workflows/vm/commands.js";
import { parseWorkflowEvent } from "../../../../src/workflows/vm/events.js";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js";

const decodeWorkflowGraph = Schema.decodeUnknownSync(WorkflowGraphSchema, { onExcessProperty: "error" });
const ownership = { _tag: "workflow", workflowDefinitionId: "workflow" } as const;
const graph = {
  nodes: [{
    kind: "agent",
    id: "node-1",
    workflowDefinitionId: "workflow",
    order: 0,
    ownership,
    state: { _tag: "ready" },
    definitionId: "step-one",
    name: "One",
    condition: null,
    retry: null,
  }],
  dependencies: [],
  joins: [],
  budgets: [{ parentNodeId: "node-1", limits: { nodes: 4, depth: 2 } }],
} as const;
// Version 3 graphs recorded counter budgets that no producer wrote.
const counterBudgets = [{
  parentNodeId: "node-1",
  expansion: { used: 0, limit: 4 },
  remediation: { used: 1, limit: 2 },
}] as const;
const control = {
  definitionIdentity: {
    workflowDefinitionId: "workflow",
    workflowSha256: "a".repeat(64),
    bindings: [{ bindingId: "step-one", sha256: "b".repeat(64) }],
    vmVersion: "1",
    handoffRegistry: [],
    skills: [],
    personas: [],
  },
  workflowName: "Workflow",
  graph,
  attempts: [{
    id: "attempt-1",
    logicalNodeId: "node-1",
    workflowDefinitionId: "workflow",
    definitionId: "step-one",
    sequence: 1,
    iteration: 1,
    resumeRevertCount: 0,
    provenance: { _tag: "authored" },
    ownership,
    state: { _tag: "pending" },
    parentAttemptId: null,
    conversationId: null,
    handoff: null,
    priorRetryFeedback: null,
    item: null,
  }],
  frontier: ["node-1"],
  guardrails: {
    maxAttempts: 50,
    maxMutationsPerAttempt: 3,
    maxInserts: 20,
    insertsUsed: 0,
    attemptMutationsUsed: [{ attemptId: "attempt-1", used: 0 }],
  },
  status: "ready",
  followUp: null,
  aggregateSeq: 0,
} as const;

// The same control as a version 3 root recorded it, before phases.
const historicalControl = {
  ...control,
  graph: { ...graph, nodes: [{ ...graph.nodes[0], kind: "step", condition: undefined, then: null }].map(({ condition: _condition, ...node }) => node) },
  attempts: control.attempts.map(({ item, ...attempt }) => ({ ...attempt, forItem: item })),
  guardrails: {
    maxQueueLength: 50, maxMutationsPerAttempt: 3, maxSessionInserts: 20, sessionInsertsUsed: 0,
    attemptMutationsUsed: control.guardrails.attemptMutationsUsed,
  },
};

describe("workflow VM graph model", () => {
  it("strictly decodes and round-trips graph and committed control data", () => {
    const decodedGraph = decodeWorkflowGraph(graph);
    const decodedControl = parseCommittedWorkflowControl(control);

    expect(Schema.encodeUnknownSync(WorkflowGraphSchema)(decodedGraph)).toEqual(graph);
    expect(Schema.encodeUnknownSync(CommittedWorkflowControlSchema)(decodedControl)).toEqual(control);
  });

  it("rejects missing writer fields and excess fields", () => {
    expect(() => decodeWorkflowGraph({ ...graph, extra: true })).toThrow();
    const { joins: _joins, ...missingJoins } = graph;
    expect(() => decodeWorkflowGraph(missingJoins)).toThrow();
    // Only a graph that normalized from control before phases holds budgets.
    const { budgets: _budgets, ...withoutBudgets } = graph;
    expect(decodeWorkflowGraph(withoutBudgets)).not.toHaveProperty("budgets");
    expect(() => parseCommittedWorkflowControl({ ...control, frontier: undefined })).toThrow();
    const { guardrails: _guardrails, ...missingGuardrails } = control;
    expect(() => parseCommittedWorkflowControl(missingGuardrails)).toThrow();
    const [attempt] = control.attempts;
    if (!attempt) throw new Error("test control must contain an attempt");
    const { resumeRevertCount: _resumeRevertCount, ...missingResumeCount } = attempt;
    expect(() => parseCommittedWorkflowControl({ ...control, attempts: [missingResumeCount] })).toThrow();
    const { item: _item, ...missingItem } = attempt;
    expect(() => parseCommittedWorkflowControl({ ...control, attempts: [missingItem] })).toThrow();
  });

  it("requires the durable while stuck-detection signal", () => {
    const whileNode = {
      kind: "while",
      id: "node-2",
      workflowDefinitionId: "workflow",
      order: 1,
      ownership,
      state: { _tag: "pending" },
      evaluator: { step: "step-one", field: "findings" },
      body: [{ step: "step-one" }],
      maxIterations: 3,
      detectStuck: true,
      iteration: 1,
      priorNormalizedSignal: null,
    } as const;
    expect(decodeWorkflowGraph({ ...graph, nodes: [whileNode] }).nodes[0]).toEqual(whileNode);
    const { priorNormalizedSignal: _priorNormalizedSignal, ...missingSignal } = whileNode;
    expect(() => decodeWorkflowGraph({ ...graph, nodes: [missingSignal] })).toThrow();
  });

  it("reads issue and seal records only through the frozen version 3 root", () => {
    const issue = {
      _tag: "issue",
      id: "issue-1",
      ownerNodeId: "node-1",
      gate: "node",
      status: "open",
      summary: "Required evidence is missing",
      evidence: ["test output"],
      createdAt: 1,
      resolvedAt: null,
    } as const;
    const seal = {
      _tag: "seal",
      id: "seal-1",
      checkpointNodeId: "node-1",
      outcome: "sealed",
      evidence: ["all checks passed"],
      versionRefs: ["v1"],
      issuedAt: 2,
      supersededBy: null,
    } as const;

    const root = (issues: readonly unknown[], seals: readonly unknown[]) => ({
      type: "workflow.control.initialized", version: 3, actor: "flywheel",
      payload: { control: { ...historicalControl, graph: { ...historicalControl.graph, budgets: counterBudgets }, aggregateSeq: 1, issues, seals } },
    });

    expect(parseWorkflowSessionFact(root([issue], [seal]))).toEqual<unknown>(root([issue], [seal]));
    // Counter budgets had no producer and no meaning, so they normalize to none.
    const { budgets: _budgets, ...withoutBudgets } = graph;
    expect(replayWorkflowControl([root([issue], [seal])])).toEqual({ ...control, graph: withoutBudgets, aggregateSeq: 1 });
    expect(() => decodeWorkflowGraph({ ...graph, budgets: counterBudgets })).toThrow();
    expect(() => parseWorkflowSessionFact(root([{ ...issue, unknown: true }], []))).toThrow();
    expect(() => parseWorkflowSessionFact(root([], [{ ...seal, evidence: undefined }]))).toThrow();
    expect(() => parseWorkflowSessionFact(root([{ ...issue, _tag: "seal" }], []))).toThrow();
    expect(() => parseWorkflowSessionFact(root([], [{ ...seal, _tag: "issue" }]))).toThrow();
    expect(() => parseCommittedWorkflowControl({ ...control, issues: [], seals: [] })).toThrow();
  });

  it("keeps concrete attempt states distinct from logical node states", () => {
    const [attempt] = control.attempts;
    if (!attempt) throw new Error("test control must contain an attempt");
    expect(parseCommittedWorkflowControl({
      ...control,
      attempts: [{ ...attempt, state: { _tag: "skipped", reason: "Reassessed" } }],
    }).attempts[0]?.state._tag).toBe("skipped");
    expect(() => parseCommittedWorkflowControl({
      ...control,
      attempts: [{ ...attempt, state: { _tag: "blocked", reason: "No", causedBy: [] } }],
    })).toThrow();
  });

  it("keeps previous and proposed controls distinct in pending commits", () => {
    const proposed = { ...control, aggregateSeq: 1 } as const;
    const pending = parsePendingWorkflowCommit({
      proposalId: "proposal-1",
      expectedSeq: 0,
      previousCommitted: control,
      proposedCommitted: proposed,
      facts: [{
        type: "workflow.paused", version: 1, actor: "flywheel",
        payload: { reason: "changed" },
      }],
      nextLifecycle: "executing",
    });

    expect(pending.previousCommitted.aggregateSeq).toBe(0);
    expect(pending.proposedCommitted.aggregateSeq).toBe(1);
  });

  it("discriminates exact command and event variants", () => {
    const commands = [
      { kind: "commit", proposal: { proposalId: "p", expectedSeq: 0, facts: [] } },
      {
        kind: "prepare_attempt",
        attempt: {
          attemptId: "a", logicalNodeId: "n", definitionId: "step-one", workflowDefinitionId: "workflow",
          conversationId: null, iteration: 1, provenance: { _tag: "authored" }, priorRetryFeedback: null, item: null, scope: { _tag: "workflow" },
        },
      },
      { kind: "run_attempts", attempts: [] },
      { kind: "run_follow_up", input: { workflowDefinitionId: "workflow", input: { text: "Continue" }, identity: { kind: "identified", inputID: "follow-up-input" }, conversationId: "follow-up", requestSequence: 1 } },
      { kind: "none" },
    ];
    expect(commands.map((command) => parseWorkflowCommand(command).kind)).toEqual([
      "commit",
      "prepare_attempt",
      "run_attempts",
      "run_follow_up",
      "none",
    ]);

    const events = [
      { type: "START" },
      { type: "ATTEMPT_STARTED", attemptId: "a", conversationId: "conversation-a" },
      { type: "ATTEMPT_FAILED", failure: { attemptId: "a", kind: "fatal", reason: "failed", conversationId: null } },
      { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: "a", conversationId: null, handoff: {}, reassessment: null } },
      { type: "PAUSE", reason: "operator" },
      { type: "RESUME", readers: {} },
      { type: "ABORT", reason: "operator" },
      { type: "FOLLOW_UP_REQUESTED", input: { text: "Explain" }, identity: { kind: "identified", inputID: "follow-up-input" }, conversationId: "follow-up", requestSequence: 1 },
      {
        type: "REASSESSMENT_PROPOSED",
        proposal: {
          proposalId: "r",
          ownerNodeId: "node-1",
          reason: "new evidence",
          changes: [{ kind: "cancel_node", nodeId: "node-1", reason: "obsolete" }],
        },
      },
    ] as const;
    expect(events.map((event) => parseWorkflowEvent(event).type)).toEqual(events.map(({ type }) => type));
    expect(() => parseWorkflowCommand({ kind: "none", extra: true })).toThrow();
    expect(() => parseWorkflowEvent({ type: "RESUME", readers: {}, extra: true })).toThrow();
    expect(() => parseWorkflowCommand({
      kind: "run_follow_up", input: { workflowDefinitionId: "workflow", prompt: "Continue", conversationId: null },
    })).toThrow();
    expect(() => parseWorkflowEvent({ type: "ATTEMPT_STARTED", attemptId: "a", conversationId: null })).toThrow();
    expect(() => parseWorkflowEvent({ type: "FOLLOW_UP_REQUESTED", prompt: "Explain", conversationId: null })).toThrow();
  });
});
