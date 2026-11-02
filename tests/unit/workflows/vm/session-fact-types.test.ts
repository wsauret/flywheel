import { describe, expect, it } from "bun:test";
import { hashContent } from "../../../../src/workflows/definition-hash.js";
import { buildWorkflowCompilationFacts } from "../../../../src/workflows/definition-provenance-fact-writers.js";
import { buildHandoffValidatedFact, buildHandoffWrittenFact } from "../../../../src/workflows/output-contract/facts.js";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import {
  DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID,
  DEFINITION_IDENTITY_CONTEXT_MIGRATION_REASON,
} from "../../../../src/workflows/vm/definition-identity.js";
import { buildWorkflowControlCommittedFact, committedWorkflowEvent, buildWorkflowControlInitializedFact, buildWorkflowControlRecoveredFact, buildDefinitionIdentityMigratedFact, buildDefinitionIdentityAdoptedFact, parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js";
import { buildAttemptBlockedFact, buildAttemptFailedFact, buildAttemptInsertionRejectedFact, buildAttemptResumeCapExceededFact, buildAttemptResumeRecoveredFact, buildAttemptRetryInsertedFact, buildAttemptRevertedFact, buildAttemptStartedFact, buildAttemptSucceededFact, buildFollowUpFailedFact, buildFollowUpRequestedFact, buildFollowUpSucceededFact, buildFollowUpTransferredFact, buildForExpandedFact, buildForExpansionRejectedFact, buildWorkflowAbortedFact, buildWorkflowCompletedFact, buildAttemptRecoveredFact, buildWorkflowFailedFact, buildWorkflowPausedFact, buildWorkflowReassessedFact, buildWorkflowResumedFact } from "../../../../src/workflows/vm/fact-drafts.js";
import { controlBeforePhases } from "../../../helpers/control-before-phases.js";
import { testResolvedAgent, testSkill } from "../../../helpers/skill-fixtures.js";
import { nonEmpty } from "../../../helpers/non-empty.js"

const ownership = { _tag: "workflow", workflowDefinitionId: "workflow" } as const;

function control(): CommittedWorkflowControl {
  return {
    definitionIdentity: {
      workflowDefinitionId: "workflow", workflowSha256: "a".repeat(64),
      bindings: [{ bindingId: "step", sha256: "b".repeat(64) }], vmVersion: "1", handoffRegistry: [], skills: [], personas: [],
    },
    workflowName: "Workflow",
    graph: {
      nodes: [{
        kind: "agent", id: "node", workflowDefinitionId: "workflow", order: 0, ownership,
        state: { _tag: "ready" }, definitionId: "step", name: "Step", condition: null, retry: null,
      }],
      dependencies: [], joins: [], budgets: [],
    },
    attempts: [{
      id: "attempt", logicalNodeId: "node", workflowDefinitionId: "workflow", definitionId: "step",
      sequence: 1, iteration: 1, resumeRevertCount: 0, provenance: { _tag: "authored" }, ownership,
      state: { _tag: "pending" }, parentAttemptId: null, conversationId: null, handoff: null,
      priorRetryFeedback: null, item: null,
    }],
    frontier: ["node"],
    guardrails: {
      maxAttempts: 50, maxMutationsPerAttempt: 3, maxInserts: 20, insertsUsed: 0,
      attemptMutationsUsed: [{ attemptId: "attempt", used: 0 }],
    },
    status: "ready",
    followUp: null,
    aggregateSeq: 0,
  };
}

describe("workflow session facts", () => {
  it("preserves unknown counts in previous outcome shapes and decodes measured counts", () => {
    const previous = [
      { type: "attempt.succeeded", version: 2, actor: "flywheel", payload: { attemptId: "attempt" } },
      { type: "attempt.failed", version: 2, actor: "flywheel", payload: { attemptId: "attempt", kind: "fatal", reason: "failed" } },
      { type: "attempt.retry_inserted", version: 1, actor: "flywheel", payload: { attemptId: "attempt", retryAttemptId: "retry", feedback: "feedback" } },
    ];
    for (const fact of previous) {
      expect(parseWorkflowSessionFact(fact).payload).not.toHaveProperty("toolUses");
      expect(() => parseWorkflowSessionFact({ ...fact, payload: { ...fact.payload, toolUses: 0 } })).toThrow();
      const current = { ...fact, version: fact.version + 1 };
      expect(parseWorkflowSessionFact(current).payload).not.toHaveProperty("toolUses");
      expect(parseWorkflowSessionFact({ ...current, payload: { ...fact.payload, toolUses: 0 } }).payload).toHaveProperty("toolUses", 0);
      expect(() => parseWorkflowSessionFact({ ...current, payload: { ...fact.payload, toolUses: -1 } })).toThrow();
    }
  });
  it("builds the complete current control vocabulary as strict typed facts", () => {
    const initialized = buildWorkflowControlInitializedFact(control());
    const drafts = [
      buildForExpansionRejectedFact("node", "budget"),
      buildForExpandedFact("node", 2),
      buildAttemptStartedFact("attempt"),
      buildAttemptSucceededFact("attempt"),
      buildAttemptBlockedFact("attempt", "The plan names a file the repository lacks", "list src/ reports no missing.ts"),
      buildAttemptRetryInsertedFact("attempt", "retry", "feedback"),
      buildAttemptInsertionRejectedFact("attempt", "max queue length (1)"),
      buildAttemptRevertedFact("attempt", "retry later", true),
      buildAttemptResumeCapExceededFact(),
      buildAttemptResumeRecoveredFact(),
      buildWorkflowReassessedFact("proposal", [{ kind: "skip", targetAttemptId: "attempt", reason: "obsolete" }]),
      buildWorkflowPausedFact("operator"),
      buildWorkflowResumedFact(),
      buildWorkflowAbortedFact("operator"),
      buildWorkflowCompletedFact(),
      buildWorkflowFailedFact(),
      buildFollowUpRequestedFact({ type: "FOLLOW_UP_REQUESTED", input: { text: "Explain" }, identity: { kind: "identified", inputID: "input" }, conversationId: "conversation", requestSequence: 1 }),
      buildFollowUpSucceededFact("conversation", 1),
      buildFollowUpFailedFact("failed", "conversation", 1),
      buildFollowUpTransferredFact({
        type: "FOLLOW_UP_TRANSFERRED",
        source: {
          conversationId: "conversation",
          requestSequence: 1,
          identity: { kind: "identified", inputID: "input" },
        },
        destination: {
          parentSessionId: "parent",
          parentConversationId: "parent-conversation",
          inputEntryId: "input-entry",
          turnEndEntryId: "turn-end-entry",
        },
        queuedMappings: [{ sourceKey: "queued", destinationEntryId: "queued-entry" }],
      }),
    ];
    const facts = [
      initialized,
      ...drafts,
      buildWorkflowControlCommittedFact("proposal", { type: "START" }),
    ].map(parseWorkflowSessionFact);
    expect(initialized.version).toBe(12);
    expect(drafts.find(({ type }) => type === "workflow.reassessed")?.version).toBe(3);
    expect(facts.at(-1)?.version).toBe(14);

    expect(facts.map(({ type }) => type)).toEqual([
      "workflow.control.initialized",
      "for.expansion_rejected",
      "for.expanded",
      "attempt.started",
      "attempt.succeeded",
      "attempt.blocked",
      "attempt.retry_inserted",
      "attempt.insertion_rejected",
      "attempt.reverted",
      "attempt.resume_cap_exceeded",
      "attempt.resume_recovered",
      "workflow.reassessed",
      "workflow.paused",
      "workflow.resumed",
      "workflow.aborted",
      "workflow.completed",
      "workflow.failed",
      "follow_up.requested",
      "follow_up.succeeded",
      "follow_up.failed",
      "follow_up.transferred",
      "workflow.control.committed",
    ]);
    expect(facts.map(parseWorkflowSessionFact)).toEqual(facts);
  });

  it("round-trips a strict paused recovery root and recovered attempt evidence", () => {
    const paused = { ...control(), status: "paused" as const, frontier: [], attempts: [] };
    const identity = { source: "recovered" as const, value: "workflow" };
    const root = buildWorkflowControlRecoveredFact({
      supersededThroughSeq: 7,
      degradationReasons: [{ kind: "malformed_fact", seq: 3 }],
      runtimeIdentity: { version: "0.0.7", buildId: "build" },
      identities: {
        workflow: identity,
        step: { source: "synthesized", value: "step" },
        attempt: { source: "recovered", value: "attempt" },
        conversation: { source: "recovered", value: "conversation" },
      },
      control: paused,
    });
    if (root.type !== "workflow.control.recovered") throw new Error("Expected recovery root");
    const attempt = buildAttemptRecoveredFact("attempt", "conversation");

    expect(root.version).toBe(12);
    expect(parseWorkflowSessionFact(root)).toEqual(root);
    // Version 1 control is frozen with the inert issue and seal lists.
    const v1 = { ...root, version: 1, payload: { ...root.payload, control: { ...controlBeforePhases(paused), issues: [], seals: [] } } };
    expect(parseWorkflowSessionFact(v1)).toEqual<unknown>(v1);
    expect(parseWorkflowSessionFact(attempt)).toEqual(attempt);
    expect(() => parseWorkflowSessionFact({
      ...root, version: 1,
      payload: { ...root.payload, control: { ...controlBeforePhases(paused), issues: [], seals: [], status: "executing" } },
    })).toThrow();
    expect(() => parseWorkflowSessionFact({
      ...root,
      payload: { ...root.payload, runtimeIdentity: undefined },
    })).toThrow();
    const initial = control();
    const first = initial.attempts[0];
    if (!first) throw new Error("Expected pending attempt");
    const multiPending = { ...paused, attempts: [first, { ...first, id: "second", sequence: 2 }] };
    const followUp = { conversationId: "follow-up", requestSequence: 2, identity: { kind: "identified" as const, inputID: "input" }, pendingInput: { text: "Explain the result" } };
    for (const recovered of [
      initial,
      multiPending,
      { ...paused, followUp },
      { ...paused, status: "follow_up" as const, followUp },
      { ...paused, status: "completed" as const },
      { ...paused, status: "failed" as const },
      { ...paused, attempts: [{ ...first, state: { _tag: "blocked" as const, reason: "Missing input" } }] },
      { ...paused, attempts: [{ ...first, state: { _tag: "running" as const } }] },
      { ...paused, status: "executing" as const, attempts: [{ ...first, state: { _tag: "running" as const } }] },
    ]) {
      const fact = { ...root, payload: { ...root.payload, control: recovered } };
      expect(parseWorkflowSessionFact(fact)).toEqual(fact);
    }
    for (const rejectedV1 of [
      initial,
      multiPending,
      { ...paused, followUp },
      { ...paused, frontier: ["node"] },
      { ...paused, status: "completed" },
      { ...paused, attempts: [{ ...first, state: { _tag: "running" } }] },
    ]) {
      expect(() => parseWorkflowSessionFact({
        ...root, version: 1, payload: { ...root.payload, control: { ...rejectedV1, issues: [], seals: [] } },
      })).toThrow();
    }
  });

  it("adopts a skills-aware identity through a migration fact whose evidence it derives", () => {
    const prior = control().definitionIdentity;
    const adopted = { ...prior, skills: [{ skillId: "implementation", sha256: "c".repeat(64) }] };
    const fact = buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID, prior, adopted);
    if (fact.type !== "workflow.definition_identity.migrated") throw new Error("Migration fact type is wrong");

    expect(fact.payload).toEqual({
      migrationId: "workflow-definition-identity-context-v1",
      reason: DEFINITION_IDENTITY_CONTEXT_MIGRATION_REASON,
      prior,
      adopted,
      evidence: [{ component: "skill", skillId: "implementation", recorded: "<missing>", current: "c".repeat(64) }],
    });
    expect(parseWorkflowSessionFact(fact)).toEqual(fact);
  });

  it("records an adoption with empty evidence when the bridged prior already equals the adopted identity", () => {
    const prior = control().definitionIdentity;
    const fact = buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID, prior, { ...prior });
    if (fact.type !== "workflow.definition_identity.migrated") throw new Error("Migration fact type is wrong");

    expect(fact.payload.prior).toEqual(prior);
    expect(fact.payload.adopted).toEqual(prior);
    expect(fact.payload.evidence).toEqual([]);
    expect(parseWorkflowSessionFact(fact)).toEqual(fact);
  });

  it("admits a repeatable skill-content definition identity adoption fact", () => {
    const prior = { ...control().definitionIdentity, skills: [{ skillId: "step", sha256: "c".repeat(64) }] };
    const adopted = {
      ...prior,
      skills: prior.skills.map((skill) => ({ ...skill, sha256: "d".repeat(64) })),
    };
    const fact = buildDefinitionIdentityAdoptedFact(prior, adopted);

    expect(fact).toMatchObject({
      type: "workflow.definition_identity.adopted",
      version: 1,
      payload: {
        prior,
        adopted,
        evidence: [{ component: "skill", recorded: "c".repeat(64), current: "d".repeat(64) }],
      },
    });
    expect(parseWorkflowSessionFact(fact)).toEqual(fact);
  });

  it("admits facts from the existing pure workflow builders", () => {
    const workflow = {
      id: "workflow",
      name: "Workflow",
      phases: nonEmpty([{ phase: "step", brief: "Do the step work.", name: "step", writes: [] }]),
      provenance: { layer: "project" as const, filePath: "/definitions/workflow.yaml", id: "workflow" },
    };
    const skill = testSkill("step", { name: "Step", body: "Do the work." });
    const compilation = buildWorkflowCompilationFacts({
      workflow,
      agents: [testResolvedAgent("step", skill)],
      skills: [skill],
      attempts: [{
        id: "attempt", definitionId: "step", briefId: "step", workflowDefinitionId: "workflow", name: "Step",
        status: "pending", writes: [], resumeRevertCount: 0,
      }],
      userRequestSha256: hashContent("Do the work").sha256,
      worstCaseAttempts: 1,
      verification: null,
      warnings: [],
    });
    const handoffs = [
      buildHandoffWrittenFact({
        attemptId: "attempt", agentName: "Step", definitionId: "step", workflowDefinitionId: "workflow",
        content: { summary: "done" },
      }),
      buildHandoffValidatedFact({
        attemptId: "attempt", agentName: "Step", definitionId: "step", workflowDefinitionId: "workflow",
        status: "passed", issues: [],
      }),
    ];

    expect(compilation.map(({ type }) => type)).toEqual([
      "definition.loaded", "definition.hash_recorded",
      "definition.loaded", "definition.hash_recorded",
      "definition.loaded", "definition.hash_recorded",
      "workflow.compiled",
    ]);
    expect([...compilation, ...handoffs].map(parseWorkflowSessionFact)).toEqual([...compilation, ...handoffs]);
  });

  it("rejects invalid actors across owned workflow fact families", () => {
    expect(() => parseWorkflowSessionFact({
      type: "queue.deleted", version: 1, actor: "worker", payload: {},
    })).toThrow();
    expect(() => parseWorkflowSessionFact({
      type: "context.accumulated", version: 3, actor: "worker",
      payload: {
        entry: {
          stepId: "attempt", stepName: "Step", definitionId: "step", workflowDefinitionId: "workflow",
          writes: [], timestamp: 1, handoff: {},
        },
      },
    })).toThrow();

    expect(() => parseWorkflowSessionFact({
      type: "definition.drift_rejected", version: 1, actor: "worker",
      payload: {
        workflowId: "workflow", latestSeq: 1,
        changes: [{ component: "version", recorded: "1", current: "2" }],
      },
    })).toThrow();
    expect(() => parseWorkflowSessionFact({
      ...buildHandoffWrittenFact({
        attemptId: "attempt", agentName: "Step", definitionId: "step", workflowDefinitionId: "workflow",
        content: {},
      }),
      actor: "flywheel",
    })).toThrow();
    expect(() => parseWorkflowSessionFact({
      ...buildHandoffValidatedFact({
        attemptId: "attempt", agentName: "Step", definitionId: "step", workflowDefinitionId: "workflow",
        status: "passed", issues: [],
      }),
      actor: "worker",
    })).toThrow();
  });

  it("reads previous attempt failures and writes each failure kind at its proposal encoding", () => {
    // The shape that builds of encoding 7 and earlier wrote for a stage
    // whose handoff failed after its retries.
    const previous = { type: "attempt.failed", version: 1, actor: "flywheel", payload: { attemptId: "stage", kind: "handoff", reason: "missing evidence" } };
    expect<unknown>(parseWorkflowSessionFact(previous)).toEqual(previous);
    expect(() => parseWorkflowSessionFact({ ...previous, payload: { ...previous.payload, kind: "fatal" } })).toThrow();

    // Strict replay of a run at encoding 7 re-derives the version 1 fact.
    expect<unknown>(buildAttemptFailedFact("stage", "handoff", "missing evidence", 7)).toEqual(previous);
    expect(() => buildAttemptFailedFact("stage", "fatal", "unauthorized", 7)).toThrow("only a handoff failure fails an attempt before encoding 8");

    for (const kind of ["handoff", "missing_handoff", "invalid_handoff", "transient", "context_overflow", "fatal"] as const) {
      for (const encoding of [8, 9] as const) {
        const fact = buildAttemptFailedFact("step", kind, "failed for good", encoding);
        expect(fact).toEqual({ type: "attempt.failed", version: encoding === 8 ? 2 : 3, actor: "flywheel", payload: { attemptId: "step", kind, reason: "failed for good" } });
        expect<unknown>(parseWorkflowSessionFact(fact)).toEqual(fact);
      }
    }
    for (const encoding of [7, 8, 9] as const) {
      const fact = buildAttemptRetryInsertedFact("step", "retry", "feedback", 2, encoding);
      expect(fact).toEqual({
        type: "attempt.retry_inserted", version: encoding === 9 ? 2 : 1, actor: "flywheel",
        payload: { attemptId: "step", retryAttemptId: "retry", feedback: "feedback", ...(encoding === 9 ? { toolUses: 2 } : {}) },
      });
      expect<unknown>(parseWorkflowSessionFact(fact)).toEqual(fact);
    }
  });

  it("reads a stored RECOVER and RESUME of encoding 10 to 13 as no progressed attempt and no reader, and re-encodes them at their version", () => {
    for (const [event, current] of [
      [{ type: "RECOVER" }, { type: "RECOVER", progressed: [] }],
      [{ type: "RESUME" }, { type: "RESUME", readers: {} }],
    ] as const) {
      for (const version of [10, 11, 12, 13] as const) {
        const stored = { type: "workflow.control.committed", version, actor: "flywheel", payload: { proposalId: "proposal", event } };
        const fact = parseWorkflowSessionFact(stored);
        if (fact.type !== "workflow.control.committed") throw new Error("Expected a committed fact");
        expect(committedWorkflowEvent(fact)).toEqual(current);
        expect<unknown>(buildWorkflowControlCommittedFact("proposal", committedWorkflowEvent(fact), version)).toEqual(stored);
      }
    }
    for (const event of [{ type: "RECOVER", progressed: ["attempt"] }, { type: "RESUME", readers: { report: { reads: ["node"], transient: true } } }] as const) {
      const current = buildWorkflowControlCommittedFact("proposal", event);
      if (current.type !== "workflow.control.committed") throw new Error("Expected a committed fact");
      expect(current.version).toBe(14);
      expect(committedWorkflowEvent(current)).toEqual(event);
    }
  });

  it("rejects the retired context fact version", () => {
    expect(() => parseWorkflowSessionFact({
      type: "context.accumulated", version: 2, actor: "flywheel",
      payload: {
        entry: {
          stepId: "attempt", stepName: "Step", definitionId: "step", workflowDefinitionId: "workflow",
          writes: [], timestamp: 1, handoff: {},
        },
      },
    })).toThrow();
  });

  it("admits current facts and rejects malformed or incompatible versions", () => {
    expect(parseWorkflowSessionFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} }).type).toBe("queue.deleted");
    expect(() => parseWorkflowSessionFact({ type: "unknown", version: 1, actor: "flywheel", payload: {} })).toThrow("unknown fact unknown@1; not registered");
    expect(() => parseWorkflowSessionFact({
      type: "attempt.started", version: 1, actor: "flywheel", payload: { attemptId: "attempt", excess: true },
    })).toThrow();
    const malformedStep = {
      id: "attempt", definitionId: "step", contentId: "step", workflowDefinitionId: "workflow", name: "Step",
      status: "pending", writes: [], resumeRevertCount: 0, reads: ["legacy"],
    } as const;
    for (const fact of [
      {
        type: "definition.loaded", version: 8, actor: "flywheel",
        payload: { kind: "workflow", id: "workflow", definition: { id: "workflow", name: "Workflow", phases: [{ phase: "step", brief: "Do it.", name: "Step", retired: ["legacy"] }] } },
      },
      {
        type: "workflow.compiled", version: 8, actor: "flywheel",
        payload: {
          workflowDefinitionId: "workflow", workflowName: "Workflow", userRequestArtifactId: "user-request",
          userRequestSha256: "a".repeat(64), stepIds: ["step"], skillIds: [], steps: [], userDescription: "duplicate request bytes",
        },
      },
      {
        type: "queue.created", version: 9, actor: "flywheel",
        payload: { queue: { steps: [malformedStep], cursor: 0, status: "idle", mutationLog: [] } },
      },
      {
        type: "queue.mutated", version: 9, actor: "flywheel",
        payload: {
          mutation: { timestamp: 1, action: "insert", actor: "test", reason: "test", stepIds: ["attempt"] },
          insertedSteps: [malformedStep], insertIndex: 0,
        },
      },
      {
        type: "workflow.control.initialized", version: 2, actor: "flywheel",
        payload: { control: { ...control(), reads: ["legacy"] } },
      },
      {
        type: "workflow.control.committed", version: 2, actor: "flywheel",
        payload: { proposalId: "proposal", event: { type: "START", reads: ["legacy"] } },
      },
      {
        type: "workflow.reassessed", version: 2, actor: "flywheel",
        payload: { proposalId: "proposal", changes: [{ kind: "skip", targetAttemptId: "attempt", reason: "obsolete", reads: ["legacy"] }] },
      },
    ] as const) {
      expect(() => parseWorkflowSessionFact(fact)).toThrow();
    }
    for (const { type, version, payload } of [
      { type: "definition.loaded", version: 1, payload: { definition: { steps: [{ step: "work", reads: ["legacy"] }] } } },
      { type: "definition.loaded", version: 2, payload: { kind: "step", id: "work", definition: { id: "work", name: "Work", promptBody: "Work.", writes: [], handoffFilename: "spec.json" } } },
      { type: "workflow.compiled", version: 1, payload: { steps: [{ reads: ["legacy"] }] } },
      { type: "queue.created", version: 3, payload: { queue: { steps: [{ reads: ["legacy"] }] } } },
      { type: "queue.mutated", version: 3, payload: { insertedSteps: [{ reads: ["legacy"] }] } },
      { type: "workflow.control.initialized", version: 1, payload: { control: { attempts: [{ reads: ["legacy"] }] } } },
      { type: "workflow.control.committed", version: 1, payload: { event: { proposal: { changes: [{ reads: ["legacy"] }] } } } },
      { type: "workflow.reassessed", version: 1, payload: { changes: [{ reads: ["legacy"] }] } },
    ] as const) {
      expect(() => parseWorkflowSessionFact({ type, version, actor: "flywheel", payload }))
        .toThrow(`unknown fact ${type}@${version}; not registered`);
    }
  });
});
