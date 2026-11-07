import { afterEach, describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js";
import { createWorkflowContextStore } from "../../../../src/workflows/context-bundle/context-store.js";
import { createWorkflowViewStore } from "../../../../src/workflows/view/view-store.js";
import { testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js";
import { createAttemptExecutor } from "../../../../src/workflows/vm/attempt-runner.js";
import { createWorkflowVmHost } from "../../../../src/workflows/vm/host.js";
import type { WorkflowVmHostDeps, WorkflowVmStartMode } from "../../../../src/workflows/vm/host-types.js";
import type { AttemptExecutionInput } from "../../../../src/workflows/vm/commands.js";
import type { AccumulatedContext } from "../../../../src/workflows/context-bundle/context.js";
import { agentResults, terminalHandoff, workflowCompletionContent, workflowStopContent } from "../../../../src/workflows/output-contract/workflow-completion.js";
import { renderWorkflowRequest, renderWorkflowRequestSection } from "../../../../src/workflows/context-bundle/workflow-request.js";
import { attemptOf, branch, INPUT_GROUP, INPUT_TAIL, inputBranch, inputMapWorkflow, inputStage, items, MAP_GROUP, mapSkills, mapWorkflow, oneAtATime, PLAN, stage, SURVEY_GROUP, SURVEY_SYNTHESIZE, surveyAnswer, surveyStage, surveyWorkflow, TAIL, type SurveyTarget } from "./_map-fixtures.js";
import { fourLaneControl, listJoin, targets, wideMapWorkflow } from "./_tree-fixtures.js";
import type { AddressedAddendum } from "../../../../src/workflows/context-bundle/context-facts.js";
import { mapHost, SqliteVmDriver } from "./_sqlite-vm-driver.js";
import { EVERY_CAPABILITY } from "../../../helpers/attempt-brief.js";
import { workflowTree } from "../../../../src/workflows/vm/view-tree.js";
import { renderAgentOutput } from "../../../../src/workflows/output-contract/render.js";
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";

const REQUEST = "SQLite VM acceptance";
/** Decodes a workflow the way a project file is loaded, so the fixtures state
 *  only the keys an author writes. */
const authoredWorkflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema);
const drivers: SqliteVmDriver[] = [];

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close();
});

interface RunResult {
  order: string[];
  /** The attempt id of each worker call, in call order. */
  attempts: string[];
  prompts: string[];
  enrichmentCalls: number;
  /** How many times the run paused and an operator resumed it. */
  resumes: number;
  /** The committed control the stored facts replay to. */
  control: CommittedWorkflowControl;
}

/** The steps compose no package, so every run pins an empty revision. */
const skills = testSkillRevision([]);

/** A worker answer that stands for a person's Stop mid-attempt: the host
 *  aborts the run, so the VM puts the attempt back to pending and pauses
 *  the workflow. */
const STOP = Symbol("stop");

/** Run a workflow through the production host until it completes. When a
 *  Stop pauses the workflow, a new host resumes it the way an operator's
 *  Resume does. */
async function run(
  workflow: WorkflowDefinition,
  output: (definitionId: string, invocation: number) => { [key: string]: unknown } | typeof STOP,
): Promise<RunResult> {
  const vm = new SqliteVmDriver({ workflow, skills });
  drivers.push(vm);
  await vm.initialize();
  const reader = asAsyncEventReadSurface(vm.store);
  const queueStore = createWorkflowViewStore({ sessionId: vm.sessionId, reader });
  const contextStore = createWorkflowContextStore({ sessionId: vm.sessionId, reader });
  const order: string[] = [];
  const attempts: string[] = [];
  const prompts: string[] = [];
  const invocations = new Map<string, number>();
  let enrichmentCalls = 0;
  const runner = createAttemptExecutor({
    unavailableToolReason: (term) => `${term} is off`,
    earlierCheckpoint: async () => null,
    resolvedAgents: vm.bindings,
    skills: vm.skills,
    context: contextStore,
    worker: async (step, brief, signal) => {
      const { userPrompt } = await brief(EVERY_CAPABILITY);
      order.push(step.definitionId);
      attempts.push(step.id);
      prompts.push(userPrompt);
      const invocation = (invocations.get(step.definitionId) ?? 0) + 1;
      invocations.set(step.definitionId, invocation);
      const handoff = output(step.definitionId, invocation);
      if (handoff === STOP) {
        queueMicrotask(() => { void current.abort("Runtime shutdown"); });
        await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }); });
        throw signal.reason;
      }
      return { output: "completed", handoffContent: handoff, durationMs: 1 };
    },
    recordInvocation: async () => {},
    buildArtifactContext: async () => {
      enrichmentCalls += 1;
      return "## File Enrichment\nSTRUCTURED\nBODY";
    },
  });
  const host = (startMode: WorkflowVmStartMode) => createWorkflowVmHost({
    servedConversations: async () => new Set(),
    requestAddenda: async () => [],
    startMode,
    sessionId: vm.sessionId,
    reader,
    writer: asAsyncEventWriter(vm.store),
    definitionRevision: vm.definitionRevision,
    workflow,
    queueStore,
    contextStore,
    conversationId: (input) => `conversation-${input?.attemptId ?? "follow-up"}`,
    attemptRunner: runner,
    emit: () => {},
  });
  let resumes = 0;
  let current = host("launch");
  let result = await current.run();
  while (result.kind === "paused" && resumes < 3) {
    resumes += 1;
    current = host("operator_resume");
    result = await current.run();
  }
  expect(result.kind, result.kind === "failed" ? result.failure.message : "").toBe("completed");
  return { order, attempts, prompts, enrichmentCalls, resumes, control: replayWorkflowControl(vm.events()) };
}

/** The request section every prompt opens with. An inline step has no
 *  description, so no step instructions section comes before it. */
const request = renderWorkflowRequestSection({ original: REQUEST, addenda: [] });

const prior = (body: { [key: string]: unknown }): string =>
  `${request}\n\n## Output of the Phase Before\n\n${renderAgentOutput(body, [])}\n\n## File Enrichment\nSTRUCTURED\nBODY`;

const inherited = (artifactId: string, writer: string, body: { [key: string]: unknown }): string =>
  `${request}\n\n## Inherited Artifacts\n\n### ${artifactId}\nProduced by: ${writer}\n\n${renderAgentOutput(body, [])}\n\n## File Enrichment\nSTRUCTURED\nBODY`;

describe("production pipeline ordering and prompt goldens", () => {
  it("runs phases in order and settles a phase of named agents after its agents", async () => {
    const record = (name: string) => ({ brief: `Do the ${name} work.`, name, writes: [{ id: `${name}-result`, lifetime: "transient" }] });
    const workflow = authoredWorkflow({
      id: "pipeline-phases",
      name: "Phases",
      phases: [
        { phase: "plan", ...record("plan") },
        { phase: "build", agents: [{ agent: "left", ...record("left") }, { agent: "right", ...record("right") }] },
        { phase: "check", ...record("check") },
        { phase: "ship", ...record("ship") },
      ],
    });
    const result = await run(workflow, (id) => ({ summary: `${id} done` }));

    // The named agents have no order between them, so graph order picks left.
    expect(result.order).toEqual(["plan", "left", "right", "check", "ship"]);
    expect(result.resumes).toBe(0);
    expect(result.control.status).toBe("completed");
    expect(result.control.graph.nodes.map(({ id, kind, state }) => [id, kind, state._tag])).toEqual([
      ["pipeline-phases:node:1", "agent", "completed"],
      ["pipeline-phases:node:2", "phase", "completed"],
      ["pipeline-phases:node:2:node:1", "agent", "completed"],
      ["pipeline-phases:node:2:node:2", "agent", "completed"],
      ["pipeline-phases:node:3", "agent", "completed"],
      ["pipeline-phases:node:4", "agent", "completed"],
    ]);
    expect(result.attempts).toEqual([
      "pipeline-phases:node:1:attempt:1",
      "pipeline-phases:node:2:node:1:attempt:1",
      "pipeline-phases:node:2:node:2:attempt:1",
      "pipeline-phases:node:3:attempt:1",
      "pipeline-phases:node:4:attempt:1",
    ]);
  });

  it("gives each phase the durable output of the phase before it and supersedes the raw plan", async () => {
    const structured = { type: "object", optional: true, description: "Structured plan data.", fields: { keep: { type: "string", description: "Kept text." } } };
    const workflow = authoredWorkflow({
      id: "pipeline-linear",
      name: "Linear",
      phases: [
        { phase: "spec-create", brief: "Write the plan.", name: "Spec Create", output: { summary: "The plan.", fields: { structured } }, writes: [{ id: "plan", lifetime: "durable", supersedes: [] }] },
        { phase: "spec-review", brief: "Review the plan.", name: "Spec Review", output: { summary: "The reviewed plan.", fields: { structured } }, writes: [{ id: "reviewed-plan", lifetime: "durable", supersedes: ["plan"] }] },
        { phase: "implement", brief: "Implement the plan.", name: "Implement", writes: [{ id: "implementation", lifetime: "durable", supersedes: [] }] },
      ],
    });
    const rawPlan = { summary: "RAW PLAN BODY" };
    const reviewedPlan = { summary: "REVIEWED PLAN BODY", structured: { keep: "verbatim" } };
    const result = await run(workflow, (id) => id === "spec-create" ? rawPlan : id === "spec-review" ? reviewedPlan : { summary: "implemented" });

    expect(result.order).toEqual(["spec-create", "spec-review", "implement"]);
    expect(result.prompts).toEqual([
      request,
      inherited("plan", "Spec Create", rawPlan),
      inherited("reviewed-plan", "Spec Review", reviewedPlan),
    ]);
    expect(result.prompts[2]).not.toContain("RAW PLAN BODY");
    expect(result.prompts[2]).toContain('### Structured\n```json\n{\n  "keep": "verbatim"\n}\n```');
    expect(result.enrichmentCalls).toBe(2);
    expect(result.prompts.slice(1).every((prompt) => prompt.split("## File Enrichment").length - 1 === 1)).toBe(true);
  });

  it("runs a repeat while its field is not empty, and skips the rest of the round that ends it", async () => {
    const workflow = authoredWorkflow({
      id: "pipeline-while",
      name: "While",
      phases: [{
        repeat: { while: "review.findings", max: 2, stuck: true },
        phases: [
          { phase: "review", brief: "Do the review work.", name: "review", output: { summary: "The review.", fields: { findings: { type: "list", description: "Open findings.", of: { type: "object", fields: { id: { type: "string", description: "The finding id." } } } } } }, writes: [{ id: "review-result", lifetime: "transient" }] },
          { phase: "fix", brief: "Do the fix work.", name: "fix", writes: [{ id: "fix-result", lifetime: "transient" }] },
        ],
      }],
    });
    const firstReview = { summary: "review one", findings: [{ id: "finding-1" }] };
    const fix = { summary: "fixed finding-1" };
    const cleanReview = { summary: "clean", findings: [] };
    const result = await run(workflow, (id, invocation) => id === "review" ? invocation === 1 ? firstReview : cleanReview : fix);

    expect(result.order).toEqual(["review", "fix", "review"]);
    expect(result.prompts).toEqual([
      request,
      prior(firstReview),
      prior(fix),
    ]);
    expect(result.enrichmentCalls).toBe(2);
  });

  it("runs each round of a repeat over items with its reassessment before the next item", async () => {
    const milestones = { type: "list", description: "The milestones.", max: 2, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The milestone id." } } } };
    const workflow = authoredWorkflow({
      id: "pipeline-reassessment",
      name: "Reassessment",
      phases: [
        { phase: "source", brief: "Plan the milestones.", name: "Source", output: { summary: "The plan.", fields: { milestones } }, writes: [{ id: "plan", lifetime: "durable", supersedes: [] }] },
        {
          repeat: { each: "source.milestones", reassess: "reassess" },
          phases: [
            { phase: "implement", brief: "Implement the milestone.", name: "Implement", writes: [{ id: "implementation", lifetime: "durable", supersedes: [] }] },
            { phase: "reassess", brief: "Reassess the remaining milestones.", name: "Reassess", writes: [{ id: "reassess-result", lifetime: "transient" }] },
          ],
        },
        { phase: "tail", brief: "Finish.", name: "Tail", writes: [{ id: "tail-result", lifetime: "transient" }] },
      ],
    });
    const result = await run(workflow, (id) => id === "source"
      ? { summary: "milestone source", milestones: [{ id: "p1" }, { id: "p2" }] }
      : id === "reassess"
        ? { summary: "confirmed", changes: [] }
        : { summary: `${id} complete` });

    expect(result.order).toEqual(["source", "implement", "reassess", "implement", "reassess", "tail"]);
    expect(result.prompts).toHaveLength(6);
    expect(result.prompts[1]).toStartWith(`## Item\n\n{\n  "id": "p1"\n}`);
    expect(result.prompts[3]).toStartWith(`## Item\n\n{\n  "id": "p2"\n}`);
    expect(result.prompts[2]).toContain("### implementation");
    expect(result.prompts[3]).toContain("## Output of the Phase Before");
    expect(result.prompts[5]).toContain("### implementation");
    expect(result.prompts.every((prompt) => prompt.split("## File Enrichment").length - 1 <= 1)).toBe(true);
  });

  it("runs each phase of a round in order and runs a stopped middle phase again as itself", async () => {
    const transient = (id: string) => ({ phase: id, brief: `Do the ${id} work.`, name: id, writes: [{ id: `${id}-result`, lifetime: "transient" }] });
    const findings = { type: "list", optional: true, description: "Open findings.", of: { type: "object", fields: { id: { type: "string", description: "The finding id." } } } };
    const whileChain = authoredWorkflow({
      id: "pipeline-while-chain",
      name: "While chain",
      phases: [{
        repeat: { while: "review.findings", max: 3 },
        phases: [transient("plan"), { ...transient("review"), output: { summary: "The review.", fields: { findings } } }, transient("fix")],
      }],
    });
    const review = (invocation: number) => invocation <= 2 ? { summary: "review one", findings: [{ id: "finding-1" }] } : { summary: "clean", findings: [] };
    // A Stop interrupts the first review mid-round; the resumed run runs
    // that attempt again.
    const looped = await run(whileChain, (id, invocation) => id === "review"
      ? invocation === 1 ? STOP : review(invocation)
      : { summary: `${id} ${invocation}` });
    const round = (index: number, phase: number) => `pipeline-while-chain:node:1:round:${index}:node:${phase}:attempt:1`;

    expect(looped.resumes).toBe(1);
    expect(looped.order).toEqual(["plan", "review", "review", "fix", "plan", "review"]);
    expect(looped.attempts).toEqual([round(1, 1), round(1, 2), round(1, 2), round(1, 3), round(2, 1), round(2, 2)]);
    expect(looped.prompts).toEqual([
      request,
      prior({ summary: "plan 1" }),
      prior({ summary: "plan 1" }),
      prior(review(2)),
      prior({ summary: "fix 1" }),
      prior({ summary: "plan 2" }),
    ]);

    const eachChain = authoredWorkflow({
      id: "pipeline-each-chain",
      name: "Each chain",
      phases: [
        { phase: "source", brief: "Plan the milestones.", name: "Source", output: { summary: "The plan.", fields: { milestones: { type: "list", description: "The milestones.", max: 2, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The milestone id." } } } } } }, writes: [{ id: "plan", lifetime: "durable", supersedes: [] }] },
        { repeat: { each: "source.milestones" }, phases: [transient("draft"), transient("build"), transient("check")] },
      ],
    });
    const chain = await run(eachChain, (id, invocation) => id === "source"
      ? { summary: "milestone source", milestones: [{ id: "p1" }, { id: "p2" }] }
      : id === "build" && invocation === 1 ? STOP : { summary: `${id} ${invocation}` });
    const item = (index: number, phase: number) => `pipeline-each-chain:node:2:round:${index}:node:${phase}:attempt:1`;

    expect(chain.resumes).toBe(1);
    expect(chain.order).toEqual(["source", "draft", "build", "build", "check", "draft", "build", "check"]);
    expect(chain.attempts).toEqual([
      "pipeline-each-chain:node:1:attempt:1",
      item(1, 1), item(1, 2), item(1, 2), item(1, 3),
      item(2, 1), item(2, 2), item(2, 3),
    ]);
    expect(chain.prompts[1]).toStartWith(`## Item\n\n{\n  "id": "p1"\n}`);
    expect(chain.prompts[5]).toStartWith(`## Item\n\n{\n  "id": "p2"\n}`);
    for (const [index, predecessor] of [[2, "draft 1"], [3, "draft 1"], [4, "build 2"], [6, "draft 2"], [7, "build 3"]] as const) {
      expect(chain.prompts[index]).toContain(`## Output of the Phase Before\n\n${renderAgentOutput({ summary: predecessor }, [])}`);
    }
  });

  it("runs a phase with if only when the field it names is not empty", async () => {
    const workflow = authoredWorkflow({
      id: "pipeline-conditional",
      name: "Conditional",
      phases: [
        { phase: "work", brief: "Do the work work.", name: "work", output: { summary: "The work.", fields: { route: { type: "string", description: "Why the follow-up runs, or empty.", optional: true }, structured: { type: "object", optional: true, description: "Structured data.", fields: { body: { type: "string", description: "Body text." } } } } }, writes: [{ id: "work-result", lifetime: "transient" }] },
        { phase: "follow", if: "work.route", brief: "Do the follow work.", name: "follow", writes: [{ id: "follow-result", lifetime: "transient" }] },
        { phase: "tail", brief: "Do the tail work.", name: "tail", writes: [{ id: "tail-result", lifetime: "transient" }] },
      ],
    });
    const work = { summary: "work complete", route: "follow now", structured: { body: "A\nB" } };
    const follow = { summary: "follow complete" };
    const result = await run(workflow, (id) => id === "work" ? work : id === "follow" ? follow : { summary: "tail complete" });

    expect(result.order).toEqual(["work", "follow", "tail"]);
    expect(result.prompts).toEqual([
      request,
      prior(work),
      prior(follow),
    ]);
    expect(result.prompts[1]).toContain('"body": "A\\nB"');
    expect(result.enrichmentCalls).toBe(2);

    const noRoute = { summary: "work complete", route: "" };
    const skipped = await run(workflow, (id) => id === "work" ? noRoute : { summary: `${id} complete` });
    expect(skipped.order).toEqual(["work", "tail"]);
    expect(skipped.control.graph.nodes.map(({ state }) => state._tag)).toEqual(["completed", "skipped", "completed"]);
    expect(skipped.prompts).toEqual([
      request,
      prior(noRoute),
    ]);
    // A skipped phase skips each attempt of the agents it owns, so no row
    // of a finished run stays pending.
    expect(skipped.control.attempts.map(({ state }) => state._tag)).toEqual(["completed", "skipped", "completed"]);

    const gated = authoredWorkflow({
      id: "pipeline-gated",
      name: "Gated",
      phases: [
        { phase: "work", brief: "Do the work work.", name: "work", output: { summary: "The work.", fields: { route: { type: "string", description: "Why the gates run, or empty.", optional: true } } }, writes: [] },
        { phase: "gates", if: "work.route", agents: [{ agent: "lint", brief: "Lint.", writes: [] }, { agent: "tsc", brief: "Check types.", writes: [] }] },
        { phase: "tail", brief: "Do the tail work.", name: "tail", writes: [] },
      ],
    });
    const owned = await run(gated, (id) => id === "work" ? noRoute : { summary: `${id} complete` });
    expect(owned.order).toEqual(["work", "tail"]);
    expect(owned.control.graph.nodes.map(({ state }) => state._tag)).toEqual(["completed", "skipped", "skipped", "skipped", "completed"]);
    expect(owned.control.attempts.map(({ state }) => state._tag)).toEqual(["completed", "skipped", "skipped", "completed"]);
  });
});

/** Answers for a map run: the plan lists three items, the first stage of
 *  the second branch writes an invalid handoff, and every other attempt
 *  succeeds. Each attempt's scoped context is recorded. */
function mapRunner(vm: SqliteVmDriver, seen: Map<string, AccumulatedContext>, ran: string[]): WorkflowVmHostDeps["attemptRunner"]["run"] {
  return async (input: AttemptExecutionInput, active) => {
    ran.push(input.attemptId);
    seen.set(input.attemptId, await vm.workflowStores().contextStore.getContext({ attemptId: input.attemptId, scope: input.scope }));
    if (input.attemptId === attemptOf(stage(2, 1))) {
      return { kind: "invalid_handoff", attemptId: input.attemptId, conversationId: active.conversationId, reason: "summary is required", content: {}, issues: [{ path: "summary", message: "summary is required" }] };
    }
    const handoff = input.definitionId === "plan"
      ? { summary: "The plan.", items: items("a", "b", "c") }
      : { summary: `${input.definitionId} of ${JSON.stringify(input.item)}` };
    return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff, reassessment: null };
  };
}

/** Answers for a survey run from the survey fixture, recording each
 *  attempt's scoped context in `seen`. */
function surveyRunner(vm: SqliteVmDriver, survey: readonly SurveyTarget[], exclusions: readonly string[], seen = new Map<string, AccumulatedContext>()): WorkflowVmHostDeps["attemptRunner"]["run"] {
  const answer = surveyAnswer(survey, exclusions);
  return async (input: AttemptExecutionInput, active) => {
    seen.set(input.attemptId, await vm.workflowStores().contextStore.getContext({ attemptId: input.attemptId, scope: input.scope }));
    const outcome = answer(input.attemptId);
    if ("fail" in outcome) {
      return { kind: "invalid_handoff", attemptId: input.attemptId, conversationId: active.conversationId, reason: outcome.fail, content: {}, issues: [{ path: "summary", message: outcome.fail }] };
    }
    return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: outcome.handoff, reassessment: null };
  };
}

const factsOf = (vm: SqliteVmDriver, type: string) => vm.events().filter((event) => event.type === type);

describe("map pipeline through the production host", () => {
  it("runs a phase with a map over a two-stage chain, fails one branch, and joins the rest with collect", async () => {
    const vm = new SqliteVmDriver({ workflow: mapWorkflow, skills: mapSkills });
    drivers.push(vm);
    await vm.initialize();
    const seen = new Map<string, AccumulatedContext>();
    const ran: string[] = [];

    // The failed item agent fails the run once nothing more can run, so a Resume can run it again.
    expect((await mapHost(vm, "launch", mapRunner(vm, seen, ran)).run()).kind).toBe("failed");

    // Every branch starts its first stage at once, each branch runs its own
    // chain in order, and the failed first stage blocks only its own second
    // stage. The join waits for every branch before the tail starts.
    expect(ran).toEqual([PLAN, stage(1, 1), stage(2, 1), stage(3, 1), stage(1, 2), stage(3, 2), TAIL].map(attemptOf));
    const control = vm.freshViews().control;
    expect(Object.fromEntries(control.graph.nodes.map(({ id, state }) => [id, state._tag]))).toEqual({
      [PLAN]: "completed", [MAP_GROUP]: "completed",
      [branch(1)]: "completed", [stage(1, 1)]: "completed", [stage(1, 2)]: "completed",
      [branch(2)]: "failed", [stage(2, 1)]: "failed", [stage(2, 2)]: "blocked",
      [branch(3)]: "completed", [stage(3, 1)]: "completed", [stage(3, 2)]: "completed",
      [TAIL]: "completed",
    });
    expect(control.graph.dependencies).toEqual(expect.arrayContaining([1, 2, 3].map((ordinal) => ({ nodeId: stage(ordinal, 2), dependsOn: stage(ordinal, 1) }))));
    expect(control.graph.joins).toEqual([{ kind: "collect_all", nodeId: MAP_GROUP, requiredNodeIds: [1, 2, 3].map(branch) }]);

    // Every disposition is recorded and the denominator is the item count.
    expect(factsOf(vm, "group.expanded").map(({ payload }) => payload.itemCount)).toEqual([3]);
    expect(factsOf(vm, "attempt.failed").map(({ payload }) => payload)).toEqual([{ attemptId: attemptOf(stage(2, 1)), kind: "invalid_handoff", reason: "summary is required" }]);
    const [settled, ...more] = factsOf(vm, "group.settled");
    expect(more).toEqual([]);
    expect(settled?.payload).toMatchObject({
      groupNodeId: MAP_GROUP,
      reducer: { id: "collect", version: 1 },
      summary: { total: 3, completed: 2, failed: 1 },
      output: { total: 3, completed: 2, failed: 1 },
    });
    expect(settled?.payload.input).toMatchObject([
      { ordinal: 1, key: "a", disposition: "completed", handoff: { stepId: attemptOf(stage(1, 2)) } },
      { ordinal: 2, key: "b", disposition: "failed", handoff: null },
      { ordinal: 3, key: "c", disposition: "completed", handoff: { stepId: attemptOf(stage(3, 2)) } },
    ]);
    expect(factsOf(vm, "workflow.failed")).toHaveLength(1);

    // A branch reads exactly the frozen shared bundle, its own predecessor,
    // and its own item. Branch 3's second stage starts after branch 1's
    // first stage recorded, and never reads it.
    const firstOfC = seen.get(attemptOf(stage(3, 1)));
    expect(firstOfC?.artifacts.map(({ id }) => id)).toEqual(["plan"]);
    expect(firstOfC?.priorHandoff).toBeNull();
    const secondOfC = seen.get(attemptOf(stage(3, 2)));
    expect(secondOfC?.artifacts.map(({ id }) => id)).toEqual(["plan"]);
    expect(secondOfC?.priorHandoff?.entryId).toBe(attemptOf(stage(3, 1)));
    expect(secondOfC?.exclusions).toEqual(expect.arrayContaining([
      { kind: "entry", id: attemptOf(stage(1, 1)), reason: "sibling_item" },
    ]));
    expect(seen.get(attemptOf(stage(1, 2)))?.priorHandoff?.entryId).toBe(attemptOf(stage(1, 1)));

    // After the join, the workflow scope reads one post-join artifact that
    // expands the branch handoffs, never the branch entries themselves.
    const tail = seen.get(attemptOf(TAIL));
    expect(tail?.artifacts.map(({ id, writerEntryId }) => [id, writerEntryId])).toEqual([["plan", attemptOf(PLAN)], ["reviews", `${MAP_GROUP}:join`]]);
    expect(tail?.artifacts.find(({ id }) => id === "reviews")?.value.items).toMatchObject([
      { key: "a", disposition: "completed", handoff: { step_id: attemptOf(stage(1, 2)), content: { summary: `review of ${JSON.stringify(items("a")[0])}` } } },
      { key: "b", disposition: "failed", handoff: null },
      { key: "c", disposition: "completed", handoff: { step_id: attemptOf(stage(3, 2)), content: { summary: `review of ${JSON.stringify(items("c")[0])}` } } },
    ]);
    expect(tail?.exclusions).toEqual(expect.arrayContaining([
      { kind: "entry", id: attemptOf(stage(1, 1)), reason: "item_evidence" },
      { kind: "entry", id: attemptOf(stage(1, 2)), reason: "folded_into_join" },
    ]));

    // Stop and completion read the last workflow-scope handoff: never a
    // branch handoff, and the post-join artifact once the group settled.
    const events = vm.events();
    const failedAt = events.findIndex(({ type }) => type === "attempt.failed");
    expect(terminalHandoff(events.slice(0, failedAt))?.attemptId).toBe(attemptOf(PLAN));
    const tailWritten = events.findIndex(({ type, payload }) => type === "handoff.written" && payload.attemptId === attemptOf(TAIL));
    const joined = terminalHandoff(events.slice(0, tailWritten));
    expect(joined?.attemptId).toBe(`${MAP_GROUP}:join`);
    // The parent reads the post-join artifact as the tail step reads it: each
    // reference expanded, in item order.
    expect(joined?.content?.items).toEqual(tail?.artifacts.find(({ id }) => id === "reviews")?.value.items);
    expect(joined?.unexpandedReferences).toEqual([]);
    expect(terminalHandoff(events)?.attemptId).toBe(attemptOf(TAIL));

    // Strict replay derives the same control again, every time.
    expect(replayWorkflowControl(events)).toEqual(control);
    expect(replayWorkflowControl(vm.events())).toEqual(replayWorkflowControl(events));

    // The tree that the run's tree facts carry is the tree of the replayed
    // control, and it settles with every slot accounted for.
    expect(factsOf(vm, "queue.tree.changed").length).toBeGreaterThan(1);
    expect(vm.queue()?.tree).toEqual(workflowTree(replayWorkflowControl(events), (id) => vm.queue()!.attempts.find(({ definitionId }) => definitionId === id)!.name));
    expect(listJoin(vm.queue()?.tree, MAP_GROUP)).toEqual({ reducer: "collect@1", state: "settled", slots: 3, completed: 2, failed: 1, pending: 0, missing: 0 });
  });

  it("resumes a partial group after ABORT with the same pending identities and its join unsettled", async () => {
    // One at a time, so the abort cuts the run where branch 1 completed and
    // branch 2 runs.
    const vm = new SqliteVmDriver({ workflow: oneAtATime(mapWorkflow), skills: mapSkills });
    drivers.push(vm);
    await vm.initialize();
    const seen = new Map<string, AccumulatedContext>();
    const ran: string[] = [];
    const answer = mapRunner(vm, seen, ran);
    const { promise: cut, resolve: reached } = Promise.withResolvers<void>();
    const first = mapHost(vm, "launch", async (input, active) => {
      if (input.attemptId !== attemptOf(stage(2, 1))) return answer(input, active);
      reached();
      await new Promise<void>((resolve) => active.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw active.signal.reason;
    });
    const running = first.run();
    await cut;
    const partial = vm.freshViews().control;
    expect(Object.fromEntries(partial.graph.nodes.map(({ id, state }) => [id, state._tag]))).toMatchObject({ [MAP_GROUP]: "running", [branch(1)]: "completed", [branch(2)]: "running" });
    await first.abort("Runtime shutdown");
    await running;
    const paused = vm.freshViews().control;
    expect(paused.attempts.map(({ id }) => id)).toEqual(partial.attempts.map(({ id }) => id));
    expect(factsOf(vm, "group.settled")).toEqual([]);

    // The failed item agent fails the run once nothing more can run, so a Resume can run it again.
    expect((await mapHost(vm, "operator_resume", answer).run()).kind).toBe("failed");
    expect(factsOf(vm, "group.expanded")).toHaveLength(1);
    expect(factsOf(vm, "group.settled")).toHaveLength(1);
    expect(factsOf(vm, "group.settled")[0]?.payload.summary).toEqual({ total: 3, completed: 2, failed: 1 });
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
  });

  it("records a message without targets once at workflow scope, so lanes that have not started, a later step of the running lane, and the step after the join each read it once", async () => {
    // One at a time, so the run stands where the four-lane fixture stands
    // when the message arrives.
    const vm = new SqliteVmDriver({ workflow: oneAtATime(wideMapWorkflow), skills: mapSkills, input: { items: targets(4), goal: "Survey every target." } });
    drivers.push(vm);
    await vm.initialize();
    const message = { key: "msg:parent:call-1", source: { kind: "parent" as const, name: "Planner" }, text: "Use the new API." };
    // A message that an older build accepted reaches the run only as the
    // reading of the step that read it.
    const earlier = { key: "msg:parent:call-0", source: { kind: "parent" as const, name: "Planner" }, text: "Keep the old flag names." };
    let held: AddressedAddendum[] = [];
    const running = attemptOf(inputStage(2, 1));
    const seen = new Map<string, readonly string[]>();
    const answer: WorkflowVmHostDeps["attemptRunner"]["run"] = async (input, active) => {
      if (input.attemptId === running) {
        // The run stands where the four-lane fixture stands: lane t1 finished,
        // lane t2 runs its first step, and lanes t3 and t4 wait.
        const states = (control: CommittedWorkflowControl) => Object.fromEntries(control.graph.nodes.map(({ id, state }) => [id, state._tag]));
        expect(states(vm.freshViews().control)).toEqual(states(fourLaneControl()));
        held = [{ ...message, addressedTo: [{ _tag: "workflow" }] }];
      }
      const context = await vm.workflowStores().contextStore.getContext({ attemptId: input.attemptId, nodeId: input.logicalNodeId, scope: input.scope });
      seen.set(input.attemptId, context.request?.addenda.map(({ key }) => key) ?? []);
      return { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "done" }, reassessment: null };
    };
    const host = mapHost(vm, "launch", answer, {
      addressedMessages: { read: async () => held, retire: async (keys) => { held = held.filter(({ key }) => !keys.includes(key)) } },
      // The steps of two lanes read the message live, and the running step
      // also read the earlier message.
      requestAddenda: async ({ attemptId }) => attemptId === running ? [message, earlier] : attemptId === attemptOf(inputStage(3, 1)) ? [message] : [],
    });

    expect((await host.run()).kind).toBe("completed");

    const added = factsOf(vm, "step_context.input.added").map(({ version, payload }) => ({ version, key: payload.key, ...("addressedTo" in payload ? { addressedTo: payload.addressedTo } : {}), ...("scope" in payload ? { scope: payload.scope } : {}) }));
    expect(added).toEqual([
      { version: 4, key: message.key, addressedTo: [{ _tag: "workflow" }] },
      { version: 4, key: earlier.key },
    ]);
    expect(held).toEqual([]);
    const both = [message.key, earlier.key];
    expect(Object.fromEntries(seen)).toEqual({
      [attemptOf(inputStage(1, 1))]: [],
      [attemptOf(inputStage(1, 2))]: [],
      [running]: [],
      [attemptOf(inputStage(2, 2))]: both,
      [attemptOf(inputStage(3, 1))]: both,
      [attemptOf(inputStage(3, 2))]: both,
      [attemptOf(inputStage(4, 1))]: both,
      [attemptOf(inputStage(4, 2))]: both,
      [attemptOf(INPUT_TAIL)]: both,
    });
    expect(replayWorkflowControl(vm.events())).toEqual(vm.freshViews().control);
  });

  it("surveys each target through the fan-out and folds coverage at the join, never counting a failed or inaccessible target as surveyed", async () => {
    const survey: readonly SurveyTarget[] = [
      { id: "a", priority: "required", report: "surveyed" },
      { id: "b", priority: "required", report: "fail" },
      { id: "c", priority: "supporting", report: "inaccessible" },
      { id: "d", priority: "required", report: "surveyed" },
    ];
    const vm = new SqliteVmDriver({ workflow: surveyWorkflow, skills: mapSkills });
    drivers.push(vm);
    await vm.initialize();
    const seen = new Map<string, AccumulatedContext>();
    // The failed item agent fails the run once nothing more can run, so a Resume can run it again.
    expect((await mapHost(vm, "launch", surveyRunner(vm, survey, ["x"], seen)).run()).kind).toBe("failed");

    // The reducer read every slot, and the join records references only.
    const [settled, ...more] = factsOf(vm, "group.settled");
    expect(more).toEqual([]);
    expect(settled?.payload).toMatchObject({ groupNodeId: SURVEY_GROUP, reducer: { id: "coverage", version: 1 }, summary: { total: 4, completed: 3, failed: 1 } });
    expect(settled?.payload.input).toEqual(Array.from({ length: 4 }, () => expect.not.objectContaining({ item: expect.anything(), content: expect.anything() })));
    expect(settled?.payload.output).toMatchObject({
      status: "partial",
      required: { numerator: 2, denominator: 3, surveyed: ["a", "d"], unsurveyed: ["b"] },
      supporting: { numerator: 0, denominator: 1, surveyed: [], unsurveyed: ["c"] },
      inaccessible: ["c"],
      excluded: ["x"],
      failed: ["b"],
    });
    // The failed survey of `b` fails the run, which a Resume can run again;
    // incomplete coverage alone never fails it.
    expect(factsOf(vm, "workflow.failed")).toHaveLength(1);
    expect(vm.freshViews().control.status).toBe("failed");

    // The step after the join reads the transient coverage as its prior
    // handoff, with each report expanded from its reference, in key order.
    const synthesis = seen.get(attemptOf(SURVEY_SYNTHESIZE))?.priorHandoff;
    expect(synthesis?.entryId).toBe(`${SURVEY_GROUP}:join`);
    expect(synthesis?.handoff["items"]).toMatchObject([
      { key: "a", outcome: "surveyed", handoff: { step_id: attemptOf(surveyStage(1, 2)), content: { summary: "verdict on a", outcome: "surveyed" } } },
      { key: "b", outcome: null, handoff: null },
      { key: "c", outcome: "inaccessible", handoff: { step_id: attemptOf(surveyStage(3, 2)) } },
      { key: "d", outcome: "surveyed", handoff: { step_id: attemptOf(surveyStage(4, 2)) } },
    ]);

    // The tree carries the reducer's coverage, and strict replay derives the
    // same control and the same tree again.
    const events = vm.events();
    expect(replayWorkflowControl(events)).toEqual(vm.freshViews().control);
    expect(vm.queue()?.tree).toEqual(workflowTree(replayWorkflowControl(events), (id) => vm.queue()!.attempts.find(({ definitionId }) => definitionId === id)!.name));
    expect(listJoin(vm.queue()?.tree, SURVEY_GROUP)).toEqual({
      reducer: "coverage@1", state: "settled", slots: 4, completed: 3, failed: 1, pending: 0, missing: 0,
      coverage: { status: "partial", required: { surveyed: 2, total: 3 }, unsurveyed: ["b"] },
    });
  });

  it("refuses a survey whose exclusions name a target, and commits no expansion", async () => {
    const survey: readonly SurveyTarget[] = [{ id: "a", priority: "required", report: "surveyed" }];
    const vm = new SqliteVmDriver({ workflow: surveyWorkflow, skills: mapSkills });
    drivers.push(vm);
    await vm.initialize();
    expect((await mapHost(vm, "launch", surveyRunner(vm, survey, ["a"])).run()).kind).toBe("failed");
    expect(factsOf(vm, "group.expansion_rejected").map(({ payload }) => payload)).toEqual([{ groupNodeId: SURVEY_GROUP, reason: 'exclusion "a" is also a target' }]);
    expect(factsOf(vm, "group.expanded")).toEqual([]);
    expect(vm.freshViews().control.graph.nodes.some(({ kind }) => kind === "item")).toBe(false);
  });

  it("launches with structured input, maps over input.items to completion, and lists each lane in the completion message", async () => {
    // The stream is the whole workflow, so the post-join artifact is the result.
    const encoded = Schema.encodeSync(WorkflowDefinitionSchema)(inputMapWorkflow);
    const workflow = authoredWorkflow({ ...encoded, phases: encoded.phases.slice(0, 2) });
    const input = { goal: "Ship both.", items: items("a", "b") };
    const vm = new SqliteVmDriver({ workflow, skills: mapSkills, input });
    drivers.push(vm);
    await vm.initialize();
    const seen = new Map<string, AccumulatedContext>();
    const ran: string[] = [];
    const answer: WorkflowVmHostDeps["attemptRunner"]["run"] = async (attempt, active) => {
      ran.push(attempt.attemptId);
      seen.set(attempt.attemptId, await vm.workflowStores().contextStore.getContext({ attemptId: attempt.attemptId, scope: attempt.scope }));
      const handoff = { summary: `${attempt.definitionId} of ${JSON.stringify(attempt.item)}` };
      return { kind: "success", attemptId: attempt.attemptId, conversationId: active.conversationId, handoff, reassessment: null };
    };

    expect((await mapHost(vm, "launch", answer).run()).kind).toBe("completed");

    // The launch expanded exactly one branch per input item, and the group
    // opened them when it was ready.
    expect(ran).toEqual([inputStage(1, 1), inputStage(2, 1), inputStage(1, 2), inputStage(2, 2)].map(attemptOf));
    const events = vm.events();
    expect(events.find(({ type }) => type === "context.input.seeded")).toMatchObject({ version: 2, payload: { input } });
    expect(factsOf(vm, "group.expanded").map(({ payload }) => payload.itemCount)).toEqual([2]);
    expect(factsOf(vm, "group.settled")[0]?.payload.summary).toEqual({ total: 2, completed: 2, failed: 0 });
    expect(vm.freshViews().control.graph.joins).toEqual([{ kind: "collect_all", nodeId: INPUT_GROUP, requiredNodeIds: [inputBranch(1), inputBranch(2)] }]);

    // Every stage, in every branch, reads the input as workflow-scope
    // request context beside its own item.
    for (const attemptId of ran) expect(seen.get(attemptId)?.request).toEqual({ original: "SQLite VM acceptance", input, addenda: [] });
    const rendered = renderWorkflowRequest({ original: "SQLite VM acceptance", input, addenda: [] });
    expect(rendered).toStartWith("SQLite VM acceptance\n\n### Workflow input\n\n```json\n");
    expect(rendered).toContain('"goal": "Ship both."');

    // A Stop expands each branch handoff that the join references, in item
    // order. The completion lists each lane's handoff under its lane.
    const result = terminalHandoff(events);
    expect(result?.attemptId).toBe(`${INPUT_GROUP}:join`);
    expect(result?.content?.items).toMatchObject([
      { key: "a", disposition: "completed", handoff: { step_id: attemptOf(inputStage(1, 2)), content: { summary: `review of ${JSON.stringify(items("a")[0])}` } } },
      { key: "b", disposition: "completed", handoff: { step_id: attemptOf(inputStage(2, 2)), content: { summary: `review of ${JSON.stringify(items("b")[0])}` } } },
    ]);
    const queue = vm.queue();
    if (!queue) throw new Error("Expected the completed workflow queue");
    const completion = workflowCompletionContent({ status: "completed", label: "Input mapped", sessionId: vm.sessionId, results: agentResults(events, queue), handoff: result, tree: queue.tree, failedAgents: [], resumable: false });
    expect(completion).toContain(`, item b: completed\n\n### Summary\nreview of ${JSON.stringify(items("b")[0])}`);
    expect(completion).not.toContain("did not fit");
    // A reference past the cap stays a reference, and the message names it.
    const capped = workflowStopContent({ label: "Input mapped", sessionId: vm.sessionId, stoppedBy: "agent", handoff: result && { ...result, unexpandedReferences: [attemptOf(inputStage(2, 2))] } });
    expect(capped).toContain(`did not fit the expansion cap. Read them in the workflow: ${attemptOf(inputStage(2, 2))}`);

    expect(replayWorkflowControl(events)).toEqual(vm.freshViews().control);
  });
});
