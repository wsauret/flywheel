import { afterEach, describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { hashDefinition } from "../../../../src/workflows/definition-hash.js";
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js";
import { compileWorkflowControl, launchGuardrailLimits } from "../../../../src/workflows/vm/compile.js";
import { queuedAttempts, worstCaseAttempts } from "../../../../src/workflows/vm/structural-admission.js";
import type { AccumulatedContext } from "../../../../src/workflows/context-bundle/context.js";
import type { WorkflowVmHostDeps } from "../../../../src/workflows/vm/host-types.js";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import { workflowTree } from "../../../../src/workflows/vm/view-tree.js";
import type { WorkflowTree } from "../../../../src/protocol/workflow-view-protocol-types.js";
import { attemptOf, DRY_FILES, DRY_LOOP, dryAnswer, dryDefinition, dryFinding, dryRound, dryStage, dryWorkflow, mapSkills, type DryOptions } from "./_map-fixtures.js";
import { mapHost, SqliteVmDriver } from "./_sqlite-vm-driver.js";

const drivers: SqliteVmDriver[] = [];

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close();
});

const kept = (id: string, file: string) => ({ ...dryFinding(id), branch: file });
const dropped = (id: string, file: string, reason: string) => ({ key: id, branch: file, reason });

/** Run the loop fixture to its end through the production host, with the
 *  context that each attempt received and the item of each verify lane.
 *  Each attempt that `fails` names returns a handoff that does not decode. */
async function runDry(maxIterations: number, verify = false, fails: (attemptId: string) => boolean = () => false) {
  const vm = new SqliteVmDriver({ workflow: dryWorkflow(maxIterations, verify), skills: mapSkills, input: { files: DRY_FILES } });
  drivers.push(vm);
  await vm.initialize();
  const seen = new Map<string, AccumulatedContext>();
  const verified: unknown[] = [];
  const answer: WorkflowVmHostDeps["attemptRunner"]["run"] = async (input, active) => {
    seen.set(input.attemptId, await vm.workflowStores().contextStore.getContext({ attemptId: input.attemptId, scope: input.scope }));
    if (input.definitionId === "checks") verified.push(input.item);
    if (fails(input.attemptId)) {
      return { kind: "invalid_handoff", attemptId: input.attemptId, conversationId: active.conversationId, reason: "no summary", content: {}, issues: [{ path: "summary", message: "missing" }] };
    }
    return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: dryAnswer(input.attemptId).handoff, reassessment: null };
  };
  const result = await mapHost(vm, "launch", answer).run();
  return { vm, seen, verified, result };
}

/** Compile the loop fixture as a chat's file launches it, with `files` as
 *  its launch input. */
function compileDry(options: DryOptions = {}, files: readonly { readonly path: string }[] = DRY_FILES) {
  const workflow: WorkflowDefinition = {
    ...Schema.decodeUnknownSync(WorkflowDefinitionSchema)(dryDefinition(options)),
    provenance: { layer: "session", filePath: "scratch/workflows/dry.workflow.yaml", id: "dry" },
  };
  const limits = launchGuardrailLimits(workflow, 50);
  return compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: mapSkills }, limits, { files });
}

describe("repeat over a list compilation", () => {
  it("compiles the repeat, round 1 of its list with a dedupe@2 join, and no later round", () => {
    const control = compileDry();
    expect(control.graph.nodes.filter(({ kind }) => kind !== "item" && kind !== "agent").map(({ id, kind }) => [id, kind])).toEqual([[DRY_LOOP, "repeat"], [dryRound(1), "list"]]);
    expect(control.graph.nodes.find(({ id }) => id === DRY_LOOP)).toMatchObject({ loop: { _tag: "while", evaluator: dryRound(1), field: "kept", max: 3, stuck: false }, ownership: { _tag: "workflow" } });
    expect(control.graph.nodes.find(({ id }) => id === dryRound(1))).toMatchObject({
      outputId: "finds", ownership: { _tag: "round", parentNodeId: DRY_LOOP, round: 1 }, reducer: { id: "dedupe", version: 2, params: { items: "findings", by: "id" } },
    });
    expect(control.graph.nodes.at(-1)).toMatchObject({ kind: "agent", definitionId: "report" });
  });

  it.each([
    ["a while that names a phase outside the repeat", { loop: { while: "other.kept" } }, 'Repeat 1 while names "other", which is no phase or agent of this workflow'],
    ["a while that names no list of the join output", { loop: { while: "finds.summary" } }, 'Repeat 1 while "finds.summary" names undeclared output field "summary" of "finds"'],
    ["a join other than dedupe", { loop: { while: "finds.items" }, map: { join: { reducer: "collect" } } }, 'reads a join with reducer "collect", but a repeat over a join needs a dedupe join, so a repeated item cannot keep the repeat alive; join "finds" with dedupe'],
    ["stuck on a join", { loop: { stuck: true } }, 'Repeat 1 while "finds.kept" reads a join, whose dedupe already stops a repeat that finds nothing new; remove stuck'],
  ] as const)("refuses %s, naming the remedy", (_name, options, message) => {
    expect(() => compileDry(options)).toThrow(message);
  });

  it("refuses a key that a repeat does not take at decode", () => {
    expect(() => Schema.decodeUnknownSync(WorkflowDefinitionSchema, { onExcessProperty: "error" })(dryDefinition({ loop: { then: "report" } }))).toThrow("Unexpected key");
  });

  it("counts every round in the worst case, and a file's launch takes it as its attempt limit", () => {
    // Two files of one phase each: 2 attempts in round 1, 2 more in each of
    // the 2 later rounds, and the report.
    const control = compileDry();
    expect(queuedAttempts(control)).toBe(3 * 2 + 1);
    expect(worstCaseAttempts(control)).toBe(3 * 2 + 1);
    expect(control.guardrails.maxAttempts).toBe(worstCaseAttempts(control));
    expect(compileDry({ maxIterations: 1 }).guardrails.maxAttempts).toBe(2 + 1);
    // Each retry of a phase counts in every round.
    const retried = compileDry({ map: { retry: { max: 4 } } });
    expect(worstCaseAttempts(retried)).toBe(3 * 2 * 4 + 1);
  });

  it("refuses a repeat whose rounds pass the ceiling of 4096", () => {
    const wide = { maxIterations: 10, map: { retry: { max: 10 } }, filesMax: 50 };
    const files = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `f${index}.ts` }));
    expect(compileDry(wide, files(40)).guardrails.maxAttempts).toBe(10 * 40 * 10 + 1);
    expect(() => compileDry(wide, files(41))).toThrow("attempt_limit_overrun: The workflow needs 4101 attempts for its worst case, more than the ceiling of 4096.");
  });
});

/** The round of the phase that a dry round runs. */
function roundOf(tree: WorkflowTree | undefined, round: number) {
  const phase = tree?.nodes.find(({ id }) => id === `${dryRound(round)}:phase:1`)
  return phase?.kind === "phase" ? phase.round : undefined
}

const settledFacts = (vm: SqliteVmDriver) => vm.events().filter(({ type }) => type === "group.settled");

describe("loop until dry through the production host", () => {
  it("runs rounds until one keeps nothing new, drops each item that an earlier round saw, and hands every round to the report", async () => {
    const { vm, seen, result } = await runDry(3);
    expect(result.kind).toBe("completed");

    // Three rounds ran and round 3 kept nothing, so no round 4 exists. Each
    // later round moved its counted attempts into its own group, so the
    // queued count stayed what the launch admitted.
    const control = vm.freshViews().control;
    expect(queuedAttempts(control)).toBe(queuedAttempts(compileDry()));
    expect(control.graph.nodes.filter(({ kind }) => kind === "list").map(({ id }) => id)).toEqual([dryRound(1), dryRound(2), dryRound(3)]);
    expect(control.graph.nodes.find(({ id }) => id === DRY_LOOP)?.state).toEqual({ _tag: "completed" });

    // Each round pins dedupe@2 and drops what an earlier round kept or
    // dropped with the round that first saw it. A repeat within a round is
    // a duplicate, as outside a loop.
    const settled = settledFacts(vm);
    expect(settled.map(({ payload }) => [payload.groupNodeId, payload.reducer])).toEqual([1, 2, 3].map((round) => [dryRound(round), { id: "dedupe", version: 2 }]));
    // Each round's input hash is the hash of its recorded slots, as outside
    // a loop. The earlier rounds that its fold read are the outputs of their
    // own recorded joins.
    for (const { payload } of settled) expect(payload.inputSha256).toBe(hashDefinition(payload.input).sha256);
    expect(settled.map(({ payload }) => payload.output)).toEqual([
      { kept: [kept("F1", "a.ts"), kept("F2", "a.ts")], dropped: [dropped("F1", "b.ts", "duplicate of a.ts")], failed: [] },
      { kept: [kept("F3", "b.ts")], dropped: [dropped("F2", "a.ts", "seen in round 1"), dropped("F1", "b.ts", "seen in round 1")], failed: [] },
      { kept: [], dropped: [dropped("F1", "a.ts", "seen in round 1"), dropped("F3", "b.ts", "seen in round 2")], failed: [] },
    ]);

    // The report reads the loop's output: every round, round 1 first.
    const report = seen.get(attemptOf("dry:node:2"))?.priorHandoff;
    expect(report?.entryId).toBe(`${DRY_LOOP}:join`);
    expect<unknown>(report?.handoff).toEqual({
      kept: [kept("F1", "a.ts"), kept("F2", "a.ts"), kept("F3", "b.ts")],
      dropped: settled.flatMap(({ payload }) => Schema.decodeUnknownSync(Schema.Struct({ dropped: Schema.Array(Schema.Unknown) }))(payload.output).dropped),
      failed: [],
    });

    // Strict replay derives the same control and the same tree again. The
    // tree shows the loop, each round, and how each round ended.
    const events = vm.events();
    expect(replayWorkflowControl(events)).toEqual(control);
    const tree = vm.queue()?.tree;
    expect(tree).toEqual(workflowTree(replayWorkflowControl(events), (id) => vm.queue()!.attempts.find(({ definitionId }) => definitionId === id)!.name));
    const loop = tree?.nodes.find(({ id }) => id === DRY_LOOP);
    expect(loop).toMatchObject({ kind: "repeat", label: "Hunt", disposition: "completed", parentId: null });
    expect(tree?.nodes.flatMap((node) => node.kind === "phase" && node.round !== undefined ? [{ label: node.label, parentId: node.parentId, round: node.round }] : [])).toEqual([
      { label: "Hunt", parentId: DRY_LOOP, round: { number: 1, outcome: "next" } },
      { label: "Hunt", parentId: DRY_LOOP, round: { number: 2, outcome: "next" } },
      { label: "Hunt", parentId: DRY_LOOP, round: { number: 3, outcome: "dry" } },
    ]);
  });

  it("shows each lane of a later round what every earlier round kept and dropped, and round 1 nothing", async () => {
    const { seen } = await runDry(3);
    const lane = (round: number, ordinal: number) => seen.get(attemptOf(dryStage(round, ordinal)))?.earlierRounds;
    const round1 = { round: 1, kept: [dryFinding("F1"), dryFinding("F2")], dropped: [{ key: "F1", reason: "duplicate of a.ts" }], omitted: 0 };
    const round2 = { round: 2, kept: [dryFinding("F3")], dropped: [{ key: "F2", reason: "seen in round 1" }, { key: "F1", reason: "seen in round 1" }], omitted: 0 };
    expect([lane(1, 1), lane(1, 2)]).toEqual([[], []]);
    expect([lane(2, 1), lane(2, 2)]).toEqual([[round1], [round1]]);
    expect([lane(3, 1), lane(3, 2)]).toEqual([[round1, round2], [round1, round2]]);
    // The step after the loop reads the loop's output, not earlier rounds.
    expect(seen.get(attemptOf("dry:node:2"))?.earlierRounds).toEqual([]);
  });

  it("stops at max while a round still keeps items", async () => {
    const { vm, result } = await runDry(2);
    expect(result.kind).toBe("completed");
    const control = vm.freshViews().control;
    expect(control.graph.nodes.filter(({ kind }) => kind === "list").map(({ id }) => id)).toEqual([dryRound(1), dryRound(2)]);
    expect(roundOf(vm.queue()?.tree, 2)).toEqual({ number: 2, outcome: "bound" });
    expect(replayWorkflowControl(vm.events())).toEqual(control);
  });

  it("runs the next round after a round that kept nothing because a finder failed", async () => {
    // In round 2, b.ts fails and a.ts repeats F2, so round 2 keeps nothing.
    // The failed finder did not search, so round 2 is not dry: round 3 finds
    // F3, and round 4 is dry.
    const failsInRound2 = (attemptId: string) => attemptId === attemptOf(dryStage(2, 2));
    const { vm, result } = await runDry(4, false, failsInRound2);
    // The failed item agent fails the run once nothing more can run, so a Resume can run it again.
    expect(result.kind).toBe("failed");
    expect(settledFacts(vm).map(({ payload }) => [payload.groupNodeId, payload.summary])).toEqual([
      [dryRound(1), { total: 2, completed: 2, failed: 0 }],
      [dryRound(2), { total: 2, completed: 1, failed: 1 }],
      [dryRound(3), { total: 2, completed: 2, failed: 0 }],
      [dryRound(4), { total: 2, completed: 2, failed: 0 }],
    ]);
    expect(vm.queue()?.tree?.nodes.flatMap((node) => node.kind === "phase" && node.round !== undefined ? [node.round] : [])).toEqual([
      { number: 1, outcome: "next" }, { number: 2, outcome: "next" }, { number: 3, outcome: "next" }, { number: 4, outcome: "dry" },
    ]);
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);

    // At the bound, a round with a failed finder that kept nothing ends the
    // loop as the bound, never as dry.
    const bounded = await runDry(2, false, failsInRound2);
    expect(roundOf(bounded.vm.queue()?.tree, 2)).toEqual({ number: 2, outcome: "bound" });
  });

  it("runs a phase after the repeat over the kept items of every round", async () => {
    const { vm, verified, result } = await runDry(3, true);
    expect(result.kind).toBe("completed");
    expect(verified).toEqual([kept("F1", "a.ts"), kept("F2", "a.ts"), kept("F3", "b.ts")]);
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
  });

  it("pauses in round 2, replays strictly, and completes the loop on operator resume", async () => {
    const vm = new SqliteVmDriver({ workflow: dryWorkflow(3), skills: mapSkills, input: { files: DRY_FILES } });
    drivers.push(vm);
    await vm.initialize();
    const answer: WorkflowVmHostDeps["attemptRunner"]["run"] = async (input, active) =>
      ({ kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: dryAnswer(input.attemptId).handoff, reassessment: null });
    const { promise: cut, resolve: reached } = Promise.withResolvers<void>();
    const first = mapHost(vm, "launch", async (input, active) => {
      if (input.attemptId !== attemptOf(dryStage(2, 2))) return answer(input, active);
      reached();
      await new Promise<void>((resolve) => active.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw active.signal.reason;
    });
    const running = first.run();
    await cut;
    await first.abort("Runtime shutdown");
    await running;
    const paused = vm.freshViews().control;
    expect(paused.graph.nodes.filter(({ kind }) => kind === "list").map(({ id }) => id)).toEqual([dryRound(1), dryRound(2)]);
    expect(settledFacts(vm)).toHaveLength(1);
    expect(replayWorkflowControl(vm.events())).toEqual(paused);

    expect((await mapHost(vm, "operator_resume", answer).run()).kind).toBe("completed");
    expect(settledFacts(vm).map(({ payload }) => payload.groupNodeId)).toEqual([dryRound(1), dryRound(2), dryRound(3)]);
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
  });
});
