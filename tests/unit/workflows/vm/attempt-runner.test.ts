import { describe, expect, it } from "bun:test";
import { InvariantViolation } from "../../../../src/infra/invariant.js";
import { HandoffError } from "../../../../src/workflows/context-bundle/handoff-errors.js";
import { createContextAccumulator } from "../../../../src/workflows/context-bundle/context.js";
import type { ResolvedAgent } from "../../../../src/workflows/agent-resolution.js";
import {
  createAttemptExecutor,
  type AttemptExecutorDeps,
  type AttemptRunOutcome,
} from "../../../../src/workflows/vm/attempt-runner.js";
import { testResolvedAgent } from "../../../helpers/skill-fixtures.js";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";
import {
  attempt,
  binding,
  committedControl,
  completed,
  deps,
  run,
  workerReturning,
  workSkill,
} from "./attempt-runner-test-support.js";
import { EVERY_CAPABILITY } from "../../../helpers/attempt-brief.js";
interface PhaseUnit {
  readonly id: string;
  readonly goal: string;
}

/** The item type of the phases the reassess step corrects. */
const phaseItem = {
  type: "object",
  fields: {
    id: { type: "string", description: "The phase id." },
    goal: { type: "string", description: "What the phase delivers." },
  },
} as const;

function expectFailure(outcome: AttemptRunOutcome): Exclude<AttemptRunOutcome, { kind: "success" }> {
  if (outcome.kind === "success") throw new Error("Expected failure");
  return outcome;
}

/** Every reassessment test drives the same position through the reassess
 *  slot contract; only the output and control differ. */
const reassessBindings: ReadonlyMap<string, ResolvedAgent> = new Map([[
  binding.definitionId,
  testResolvedAgent("work", workSkill, {
    reassess: phaseItem,
    writes: [{ id: "artifact", lifetime: "transient" }],
  }),
]]);

/** The reassess attempt of a `for` node of control from before phases: its
 *  agent reads the frozen contract that names phases. */
const reassessAttempt = { ...attempt, logicalNodeId: "phase-node" } as const;

function phaseUnit(id: string): PhaseUnit {
  return {
    id,
    goal: `Implement ${id}`,
  };
}

type ControlAttempt = Pick<CommittedWorkflowControl, "attempts">["attempts"][number];

/** Committed control shaped like the running reassess attempt of one settled
 *  phase: the only shape from which a corrective proposal reaches that phase. */
function reassessingAfter(
  state: ControlAttempt["state"],
  sourcePhaseId: string,
  otherAttempts: readonly ControlAttempt[] = [],
) {
  const base = committedControl();
  const source: ControlAttempt = { ...base.attempts[0]!, state, item: { id: sourcePhaseId } };
  const reassess: ControlAttempt = {
    ...source,
    id: attempt.attemptId,
    definitionId: "reassess",
    sequence: 2,
    provenance: { _tag: "followUpV10" },
    state: { _tag: "running" },
    handoff: null,
    parentAttemptId: source.id,
    item: null,
  };
  return { source, control: () => ({ ...base, attempts: [source, reassess, ...otherAttempts] }) };
}

/** A phase that a build before blocked retirement stopped: only a stored
 *  corrective chain carries one. */
const blockedState = { _tag: "blocked", reason: "The phase packet names src/missing.ts, which the repository does not contain" } as const;

/** One queued phase besides the reassessment's own source phase. */
const pendingPhaseTwo: ControlAttempt = {
  ...committedControl().attempts[0]!,
  id: "phase-2-attempt",
  item: { id: "phase-2" },
};

/** One queued phase attempt carrying the same phase id as the blocked source
 *  phase a reassessment must correct. */
const pendingPhaseOne: ControlAttempt = {
  ...committedControl().attempts[0]!,
  id: "phase-1-attempt",
  item: { id: "phase-1" },
};

describe("attempt runner outcomes", () => {
  it("maps a completed worker without a handoff to a missing handoff", async () => {
    expect(expectFailure(await run({ worker: workerReturning({ ...completed(null), toolUses: 2 }) }))).toMatchObject({
      kind: "missing_handoff",
      attemptId: attempt.attemptId,
      conversationId: "conversation-1",
      toolUses: 2,
    });
  });

  it.each([
    ["context overflow", async () => ({ output: "context_overflow", handoffContent: null, durationMs: 1 } as const), "context_overflow"],
    ["transient worker failure", async () => ({
      output: "failed",
      handoffContent: null,
      durationMs: 1,
      failureKind: "transient_disconnect",
      failureMessage: "Provider disconnected",
      failureDetail: "stream closed before completion",
    } as const), "transient"],
    ["fatal worker failure", async () => { throw Object.assign(new Error("Invalid API key"), { status: 401 }); }, "fatal"],
    ["invariant worker failure", async () => { throw new InvariantViolation({ kind: "schema-mismatch", eventType: "test", eventPosition: 1, aggregateId: "test", detail: "broken" }); }, "fatal"],
    ["unknown worker failure", async () => { throw new Error("surprising failure"); }, "fatal"],
    ["generic handoff failure", async () => { throw new HandoffError("handoff contract failed"); }, "handoff"],
  ] satisfies ReadonlyArray<readonly [string, AttemptExecutorDeps["worker"], Exclude<AttemptRunOutcome["kind"], "success">]>) (
    "maps %s to %s",
    async (_name, worker, expectedKind) => {
      const failure = expectFailure(await run({ worker: async (...args) => {
        await args[1](EVERY_CAPABILITY);
        args[4]?.(3);
        const execute: AttemptExecutorDeps["worker"] = worker;
        return execute(...args);
      } }));
      expect(failure.kind).toBe(expectedKind);
      expect(failure.toolUses).toBe(3);
      if (_name.includes("invariant")) expect(failure.reason).toContain("invariant violation");
      if (_name.includes("unknown")) expect(failure.reason).toContain("unexpected error");
      if (_name.includes("fatal")) expect(failure.reason).toContain("fatal error");
      if (_name.includes("handoff")) expect(failure.reason).toContain("agent handoff failed");
    },
  );

  it("maps a reassessment output to a proposal without applying it", async () => {
    const phase = phaseUnit("phase-2");
    const content = {
      summary: "Replace phase 2.",
      changes: [{ action: "replace", phase_id: "phase-2", phase }],
    };
    const outcome = await run({
      resolvedAgents: reassessBindings,
      worker: workerReturning(completed(content)),
    }, reassessAttempt);
    expect(outcome).toMatchObject({
      kind: "success",
      reassessment: {
        proposalId: "attempt-1:reassessment",
        ownerNodeId: "phase-node",
        reason: "Replace phase 2.",
        changes: [{
          kind: "replace",
          targetAttemptId: "phase-attempt",
          attemptId: "attempt-1:reassessment:1",
          forItem: phase,
        }],
      },
    });
  });

  it.each([
    ["completed", { _tag: "completed" } as const],
    ["blocked", blockedState],
  ])("maps insert after the %s source phase onto the reassess relationship", async (_name, state) => {
    const phase = phaseUnit("phase-1b");
    const { source, control } = reassessingAfter(state, "phase-1");
    const outcome = await run({
      resolvedAgents: reassessBindings,
      worker: workerReturning(completed({
        summary: "Insert work learned from phase 1.",
        changes: [{ action: "insert", phase_id: "phase-1", phase }],
      })),
    }, reassessAttempt, control);

    expect(outcome).toMatchObject({
      kind: "success",
      reassessment: {
        changes: [{
          kind: "insert_after",
          targetAttemptId: source.id,
          afterAttemptId: attempt.attemptId,
          attemptId: `${attempt.attemptId}:reassessment:1`,
          forItem: phase,
        }],
      },
    });
  });

  it.each([
    ["the blocked source phase it corrects", "phase-1", []],
    ["a blocked source phase whose id a queued attempt also carries", "phase-1-fixed", [pendingPhaseOne]],
  ] satisfies ReadonlyArray<readonly [string, string, readonly ControlAttempt[]]>)(
    "maps a replace reassessment onto %s",
    async (_name, proposedPhaseId, otherAttempts) => {
      const phase = phaseUnit(proposedPhaseId);
      const { source, control } = reassessingAfter(blockedState, "phase-1", otherAttempts);
      const outcome = await run({
        resolvedAgents: reassessBindings,
        worker: workerReturning(completed({
          summary: "Re-spec phase 1 around the file that exists.",
          changes: [{ action: "replace", phase_id: "phase-1", phase }],
        })),
      }, reassessAttempt, control);

      expect(outcome).toMatchObject({
        kind: "success",
        reassessment: {
          changes: [{
            kind: "replace",
            targetAttemptId: source.id,
            attemptId: `${attempt.attemptId}:reassessment:1`,
            forItem: phase,
          }],
        },
      });
    },
  );

  it("delivers a reassessment whose correction ran out without a plan change when no change can apply", async () => {
    const { control } = reassessingAfter(blockedState, "phase-1", [pendingPhaseOne]);
    const refused = [{ path: "summary", message: "too short" }];
    const outcome = await run({
      resolvedAgents: reassessBindings,
      worker: workerReturning({ ...completed({
        summary: "Re-spec phase 1 around the file that exists.",
        changes: [{ action: "replace", phase_id: "phase-1", phase: phaseUnit("phase-1") }],
      }), handoffIssues: refused }),
    }, reassessAttempt, control);

    expect(outcome).toMatchObject({
      kind: "success",
      reassessment: null,
      issues: [
        ...refused,
        { path: "changes.0.phase.id", message: expect.stringContaining("this change was left out") },
        { path: "changes", message: 'no change was applied, so the remaining items stay as they are, because changes: Phase "phase-1" is blocked, so this reassessment must correct it' },
      ],
    });
  });

  it("names each left-out change of a delivered reassessment by the place the agent gave it", async () => {
    // Round 1 of a repeat over p1, p2, p3 ran p1. The first change fails, and
    // leaving it out breaks the third change, which replaces the item that
    // the first change added; the second change applies.
    const repeatId = "workflow:node:2";
    const roundOne = `${repeatId}:round:1`;
    const items = [{ id: "p1", goal: "First" }, { id: "p2", goal: "Second" }, { id: "p3", goal: "Third" }];
    const base = committedControl();
    const ownership = { _tag: "round", workflowDefinitionId: "workflow", parentNodeId: repeatId, round: 1 } as const;
    const control = () => ({
      graph: {
        ...base.graph,
        nodes: [
          {
            kind: "repeat", id: repeatId, workflowDefinitionId: "workflow", order: 1, ownership: { _tag: "workflow", workflowDefinitionId: "workflow" }, state: { _tag: "running" }, name: "Repeat 2",
            loop: { _tag: "each", source: { nodeId: "workflow:node:1", field: "items" }, width: 3, reassess: `${roundOne}:node:2`, items },
          },
          { kind: "agent", id: `${roundOne}:node:2`, workflowDefinitionId: "workflow", order: 2, definitionId: "work", name: "Reassess", retry: null, condition: null, ownership, state: { _tag: "running" } },
        ],
      },
      attempts: [{ ...base.attempts[0]!, id: attempt.attemptId, logicalNodeId: `${roundOne}:node:2`, ownership, state: { _tag: "running" }, item: items[0]! }],
    } satisfies Pick<CommittedWorkflowControl, "attempts" | "graph">);
    const replaceAdded = { action: "replace", item_id: "p1", item: { id: "p1c", goal: "Revised" } };
    const outcome = await run({
      resolvedAgents: reassessBindings,
      worker: workerReturning({ ...completed({
        summary: "Drop the third item and revise the plan.",
        changes: [{ action: "replace", item_id: "p2", item: { id: "p1", goal: "Clash" } }, { action: "drop", item_id: "p3" }, replaceAdded],
      }), handoffIssues: [{ path: "summary", message: "too short" }] }),
    }, { ...attempt, logicalNodeId: `${roundOne}:node:2` }, control);

    expect(outcome).toMatchObject({
      kind: "success",
      reassessment: { changes: [{ kind: "drop_item", itemId: "p3" }] },
      issues: [
        { path: "summary" },
        { path: "changes.0.item.id", message: expect.stringContaining("this change was left out") },
        { path: "changes.2.item_id", message: expect.stringContaining("this change was left out"), hint: `change: ${JSON.stringify(replaceAdded)}` },
      ],
    });
  });

  it("applies a valid change of a delivered reassessment whose other fields fail their contract", async () => {
    const { control } = reassessingAfter(blockedState, "phase-1", []);
    const refused = [{ path: "files_modified", message: "Expected array, got 3" }];
    const outcome = await run({
      resolvedAgents: reassessBindings,
      worker: workerReturning({ ...completed({
        summary: "Re-spec phase 1 around the file that exists.",
        files_modified: 3,
        changes: [{ action: "replace", phase_id: "phase-1", phase: phaseUnit("phase-1") }],
      }), handoffIssues: refused }),
    }, reassessAttempt, control);

    expect(outcome).toMatchObject({ kind: "success", reassessment: { changes: [{ kind: "replace" }] }, issues: refused });
  });

  it("delivers a reassessment with no plan change when its reason cannot be read", async () => {
    const { control } = reassessingAfter(blockedState, "phase-1", []);
    const outcome = await run({
      resolvedAgents: reassessBindings,
      worker: workerReturning({ ...completed({
        changes: [{ action: "replace", phase_id: "phase-1", phase: phaseUnit("phase-1") }],
      }), handoffIssues: [{ path: "summary", message: "Missing key" }] }),
    }, reassessAttempt, control);

    expect(outcome).toMatchObject({
      kind: "success",
      reassessment: null,
      issues: [{ path: "summary" }, { path: "changes", message: expect.stringContaining("no change was applied, so the remaining items stay as they are, because summary:") }],
    });
  });

  it("delivers a handoff whose correction ran out, with each list a later phase needs salvaged and every other field as sent", async () => {
    const studied = testResolvedAgent("work", workSkill, {
      countedLists: ["sources", "targets"],
      admittedLists: ["exclusions"],
      output: {
        fields: {
          sources: { type: "list", max: 2, unique: "url", description: "Sources.", of: { type: "object", fields: { url: { type: "string" } } } },
          targets: { type: "list", description: "Targets.", of: { type: "string" } },
          exclusions: { type: "list", max: 1, description: "Exclusions.", of: { type: "string" } },
          notes: { type: "list", max: 1, description: "Notes.", of: { type: "string" } },
        },
      },
    });
    const content = {
      summary: "Studied it.",
      sources: [{ url: "a" }, { url: "a" }, { link: "b" }, { url: "c" }, { url: "d" }],
      targets: "every module",
      exclusions: ["x", 7, "y"],
      notes: ["one", "two"],
    };
    const outcome = await run({
      resolvedAgents: new Map([[studied.definitionId, studied]]),
      worker: workerReturning({ ...completed(content), handoffIssues: [{ path: "notes", message: "Expected a value with a length of at most 1" }] }),
    });

    expect(outcome).toMatchObject({
      kind: "success",
      handoff: { summary: "Studied it.", sources: [{ url: "a" }, { url: "c" }], targets: [], exclusions: ["x", "y"], notes: ["one", "two"] },
      issues: [
        { path: "notes", message: "Expected a value with a length of at most 1" },
        { path: "sources.1", message: 'the item was left out because an earlier item has the same "url"', hint: 'item: {"url":"a"}' },
        { path: "sources.2", message: expect.stringContaining("the item was left out because url: Missing key"), hint: 'item: {"link":"b"}' },
        { path: "sources.4", message: "the item was left out because the list holds at most 2 items", hint: 'item: {"url":"d"}' },
        { path: "targets", message: "the value is not a list, so it was read as an empty list", hint: 'value: "every module"' },
        { path: "exclusions.1", message: expect.stringContaining("the item was left out because it:"), hint: "item: 7" },
      ],
    });
  });

  it("rejects a blocked-phase correction whose proposed id also names a queued attempt", async () => {
    const { control } = reassessingAfter(blockedState, "phase-1", [pendingPhaseOne]);
    const outcome = await run({
      resolvedAgents: reassessBindings,
      worker: workerReturning(completed({
        summary: "Re-spec phase 1 around the file that exists.",
        changes: [{ action: "replace", phase_id: "phase-1", phase: phaseUnit("phase-1") }],
      })),
    }, reassessAttempt, control);

    expect(outcome).toMatchObject({
      kind: "invalid_handoff",
      issues: [{
        path: "changes.0.phase.id",
        message: expect.stringContaining('"phase-1" already names live phase work'),
      }],
    });
  });

  it.each([
    ["an empty change list", { summary: "The remaining work is correct.", changes: [] }],
    ["an adjustment to a later phase", {
      summary: "Re-spec the later phase instead.",
      changes: [{ action: "replace", phase_id: "phase-2", phase: phaseUnit("phase-2") }],
    }],
  ])("rejects %s while the source phase is blocked", async (_name, content) => {
    const { control } = reassessingAfter(blockedState, "phase-1", [pendingPhaseTwo]);
    const outcome = await run({
      resolvedAgents: reassessBindings,
      worker: workerReturning(completed(content)),
    }, reassessAttempt, control);

    expect(outcome).toMatchObject({
      kind: "invalid_handoff",
      content,
      issues: [{ path: "changes", message: expect.stringContaining('Phase "phase-1" is blocked') }],
    });
  });

  it.each([
    [
      "reuses a queued phase id",
      [{ action: "insert", phase_id: "phase-1", phase: phaseUnit("phase-2") }],
      { path: "changes.0.phase.id", text: '"phase-2" already names live phase work' },
    ],
    [
      "proposes one phase id twice",
      [
        { action: "insert", phase_id: "phase-1", phase: phaseUnit("phase-1b") },
        { action: "insert", phase_id: "phase-1", phase: phaseUnit("phase-1b") },
      ],
      { path: "changes.1.phase.id", text: '"phase-1b" is proposed twice' },
    ],
  ])("rejects an adjustment that %s", async (_name, changes, issue) => {
    const { control } = reassessingAfter({ _tag: "completed" }, "phase-1", [pendingPhaseTwo]);
    const outcome = await run({
      resolvedAgents: reassessBindings,
      worker: workerReturning(completed({ summary: "Adjust the remaining roadmap.", changes })),
    }, reassessAttempt, control);

    expect(outcome).toMatchObject({
      kind: "invalid_handoff",
      issues: [{ path: issue.path, message: expect.stringContaining(issue.text) }],
    });
  });

  it.each([
    ["drops", { action: "drop", phase_id: "phase-9" }],
    ["replaces", { action: "replace", phase_id: "phase-9", phase: phaseUnit("phase-9b") }],
  ])("returns a repairable issue when a change %s a phase id that names no eligible phase", async (_name, change) => {
    const content = { summary: "Adjust a phase that does not exist.", changes: [change] };
    const outcome = await run({
      resolvedAgents: reassessBindings,
      worker: workerReturning(completed(content)),
    }, reassessAttempt);

    expect(outcome).toMatchObject({
      kind: "invalid_handoff",
      content,
      issues: [{ path: "changes.0.phase_id", message: expect.stringContaining('"phase-9"') }],
    });
  });

  it("refuses to route a phase id that two pending attempts carry", async () => {
    const base = committedControl();
    const duplicate: ControlAttempt = { ...base.attempts[0]!, id: "phase-attempt-duplicate" };
    const failure = expectFailure(await run({
      resolvedAgents: reassessBindings,
      worker: workerReturning(completed({
        summary: "Replace phase 2.",
        changes: [{ action: "replace", phase_id: "phase-2", phase: phaseUnit("phase-2") }],
      })),
    }, reassessAttempt, () => ({ ...base, attempts: [...base.attempts, duplicate] })));

    expect(failure.kind).toBe("fatal");
    expect(failure.reason).toContain('ambiguous reassessment target "phase-2"');
  });

  it("reads committed control once for a confirmed reassessment over an unblocked phase", async () => {
    let controlReads = 0;
    const runner = createAttemptExecutor(deps({
      resolvedAgents: reassessBindings,
      worker: workerReturning(completed({
        summary: "The remaining work is correct.",
        changes: [],
      })),
    }));
    const outcome = await runner.run(reassessAttempt, {
      workflowSessionId: "workflow-session",
      conversationId: "conversation-1",
      signal: new AbortController().signal,
      committedControl: () => {
        controlReads += 1;
        return committedControl();
      },
      conversationsOf: async () => [],
    });

    expect(outcome).toMatchObject({ kind: "success", reassessment: null });
    expect(controlReads).toBe(1);
  });
});

describe("attempt runner boundaries", () => {
  it("names every conversation of each prior writer that the host reports for its file edits", async () => {
    const context = createContextAccumulator();
    context.seedInput({ workflowDefinitionId: "workflow", userRequest: "Implement secure login.", timestamp: 1 });
    context.accumulate({
      entryId: "phase-attempt", agentName: "Implement", definitionId: "work", workflowDefinitionId: "workflow",
      recipientAttemptId: null, writes: [{ id: "artifact", lifetime: "transient" }], timestamp: 2,
      handoff: { summary: "done", files_modified: ["src/login.ts"] },
    });
    const writers: Parameters<NonNullable<AttemptExecutorDeps["buildArtifactContext"]>>[0][] = [];
    const runner = createAttemptExecutor(deps({
      context: { getContext: async (recipient) => context.getContext(recipient) },
      buildArtifactContext: async (received) => { writers.push(received); return null; },
    }));
    const outcome = await runner.run(attempt, {
      workflowSessionId: "workflow-session",
      conversationId: "conversation-1",
      signal: new AbortController().signal,
      committedControl,
      conversationsOf: async (attemptId) => attemptId === "phase-attempt" ? ["conversation-overflowed", "conversation-implement"] : [],
    });
    expect(outcome).toMatchObject({ kind: "success" });
    expect(writers).toEqual([[{ agentName: "Implement", conversationIds: ["conversation-overflowed", "conversation-implement"], handoffs: [{ summary: "done", files_modified: ["src/login.ts"] }] }]]);
  });

  it("awaits invocation accounting before the worker", async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    let accountingStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { accountingStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = run({
      recordInvocation: async () => {
        order.push("accounting-start");
        accountingStarted?.();
        await gate;
        order.push("accounting-done");
      },
      worker: async (_step, brief) => {
        await brief(EVERY_CAPABILITY);
        order.push("worker");
        return completed();
      },
    });
    await started;
    expect(order).toEqual(["accounting-start"]);
    release?.();
    const outcome = await pending;
    expect(order).toEqual(["accounting-start", "accounting-done", "worker"]);
    expect(outcome).toMatchObject({ kind: "success" });
  });

  it("rejects an aborted turn instead of returning an outcome", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let workerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { workerStarted = resolve; });
    const runner = createAttemptExecutor(deps({
      worker: async (_step, brief, signal) => {
        await brief(EVERY_CAPABILITY);
        observedSignal = signal;
        workerStarted?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return completed();
      },
    }));
    const pending = runner.run(attempt, {
      workflowSessionId: "workflow-session",
      conversationId: "conversation-1",
      signal: controller.signal,
      committedControl,
      conversationsOf: async () => [],
    });
    await started;
    controller.abort(new Error("operator abort"));
    await expect(pending).rejects.toThrow("operator abort");
    expect(observedSignal).toBe(controller.signal);
  });

  it("rejects an aborted turn only after the worker promise settles", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    let workerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { workerStarted = resolve; });
    let releaseWorker: (() => void) | undefined;
    const unwinding = new Promise<void>((resolve) => { releaseWorker = resolve; });
    const runner = createAttemptExecutor(deps({
      worker: async (_step, brief, signal) => {
        await brief(EVERY_CAPABILITY);
        workerStarted?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await unwinding;
        order.push("worker-settled");
        throw new DOMException("Aborted", "AbortError");
      },
    }));
    const pending = runner.run(attempt, {
      workflowSessionId: "workflow-session",
      conversationId: "conversation-1",
      signal: controller.signal,
      committedControl,
      conversationsOf: async () => [],
    });
    const settled = pending.then(() => order.push("run-settled"), () => order.push("run-settled"));
    await started;
    controller.abort(new DOMException("Aborted", "AbortError"));
    await Bun.sleep(5);
    expect(order).toEqual([]);

    releaseWorker?.();
    await settled;
    expect(order).toEqual(["worker-settled", "run-settled"]);
  });

});