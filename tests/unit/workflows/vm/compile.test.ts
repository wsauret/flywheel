import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { compileWorkflowControl, launchGuardrailLimits } from "../../../../src/workflows/vm/compile.js";
import { WorkflowStructureRejectedError } from "../../../../src/workflows/vm/structural-admission.js";
import { definitionIdentityMismatches, identityDefinitionIds } from "../../../../src/workflows/vm/definition-identity.js";
import { hashDefinition } from "../../../../src/workflows/definition-hash.js";
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js";
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { retainedDefinitions, retainedProject } from "../../../fixtures/retired-workflows/retained-project.js";
import { retiredFixtureWorkflow } from "../../../helpers/retired-fixture-briefs.js";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js";
import { FINDINGS_CHECKS, FINDINGS_REVIEWS, findingsWorkflow, INPUT_GROUP, INPUT_TAIL, inputBranch, inputMapWorkflow, inputStage, itemList, items, MAP_GROUP, mapSkills, mapWorkflow, PLAN, reviewFindingsFields, SURVEY_GROUP, surveyInventoryFields, surveyWorkflow } from "./_map-fixtures.js";

const skills = testSkillRevision(["work", "follow", "residual", "review", "fix", "other", "source", "reassess"].map((id) => testSkill(id)));

/** The record of one phase or named agent with an inline brief. */
const record = (id: string, extra: { readonly [key: string]: unknown } = {}) => ({ brief: `Do the ${id} work.`, name: id, writes: [], ...extra });

/** A list output field of objects keyed by `id`. */
const listField = (max: number) => ({ type: "list", description: "The items.", max, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The id." } } } });

/** A definition that a test change may leave invalid, which the decode
 *  under test judges. */
interface Draft {
  readonly phases: readonly unknown[];
}

/** The changes applied in order, each to the definition the one before it
 *  returned. */
const both = (...changes: readonly ((definition: Draft) => Draft)[]) => (definition: Draft) =>
  changes.reduce((current, change) => change(current), definition);

/** Whether a draft element is the phase `id`. */
const isPhase = <Phase>(id: string, value: unknown): value is Phase & { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && "phase" in value && value.phase === id;

/** One authored workflow of `phases` and its resolved agents. */
function authored(phases: readonly unknown[]) {
  const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({ id: "test-workflow", name: "Test Workflow", phases });
  return { workflow, agents: resolveWorkflowAgents(workflow) };
}

function compile(phases: readonly unknown[]) {
  const { workflow, agents } = authored(phases);
  return compileWorkflowControl(workflow, agents, { skills });
}

describe("workflow VM compiler", () => {
  it("keeps the compiled identity of the retained raindrop audit workflow", () => {
    // The retained bytes must keep their original graph and control identity.
    const pinned = new Map(Object.entries({
      "raindrop-audit": { graph: "23a18d1af2339dc83d8430a37da47ab9ddfaf4f11b5c0f0dfd95e8edeff07258", control: "550c0382f5a772cc60f9560e5771dc19144a44d3143af679b77f0c80c523cc5d" },
    }));
    const project = retainedProject();
    const definitions = retainedDefinitions(project);
    const repoSkills = definitions.skills();

    for (const id of pinned.keys()) {
      const definition = retiredFixtureWorkflow(definitions.captureRevision(), id, project);
      const control = compileWorkflowControl(definition, resolveWorkflowAgents(definition), { skills: repoSkills });
      const { definitionIdentity, ...compiled } = control;
      expect({
        graph: "graphSha256" in definitionIdentity ? definitionIdentity.graphSha256 : null,
        control: hashDefinition(compiled).sha256,
      }).toEqual(pinned.get(definition.id) ?? { graph: "unpinned", control: "unpinned" });
      expect(control.definitionIdentity.workflowDefinitionId).toBe(definition.id);
      expect(identityDefinitionIds(control.definitionIdentity)).toEqual(identityDefinitionIds(control.definitionIdentity).toSorted());
      expect(control.frontier).toEqual([`${definition.id}:node:1`]);
      expect(control.guardrails).toMatchObject({ maxAttempts: 50, maxMutationsPerAttempt: 3, maxInserts: 20, insertsUsed: 0 });
      expect(control.guardrails.attemptMutationsUsed).toEqual(control.attempts.map(({ id: attemptId }) => ({ attemptId, used: 0 })));
    }
  });

  it("compiles each phase of one agent to an agent node with its name, retry, and if", () => {
    const control = compile([
      { phase: "work", ...record("work", { name: "Custom work", retry: { max: 3, stuck: true }, output: { summary: "The work.", fields: { follow_up: { type: "string", nullable: true, description: "Why a follow-up runs." } } } }) },
      { phase: "follow", if: "work.follow_up", ...record("follow") },
      { phase: "residual", if: "follow", ...record("residual") },
    ]);

    expect(control.graph.nodes).toMatchObject([
      { kind: "agent", id: "test-workflow:node:1", definitionId: "work", name: "Custom work", retry: { max: 3, stuck: true }, condition: null },
      { kind: "agent", id: "test-workflow:node:2", definitionId: "follow", condition: { _tag: "field", nodeId: "test-workflow:node:1", field: "follow_up" } },
      { kind: "agent", id: "test-workflow:node:3", definitionId: "residual", condition: { _tag: "completed", nodeId: "test-workflow:node:2" } },
    ]);
    expect(control.graph.nodes[0]).not.toHaveProperty("followUpV10");
    expect(control.graph.dependencies).toEqual([
      { nodeId: "test-workflow:node:2", dependsOn: "test-workflow:node:1" },
      { nodeId: "test-workflow:node:3", dependsOn: "test-workflow:node:2" },
    ]);
    expect(control.attempts[0]).toMatchObject({
      id: "test-workflow:node:1:attempt:1",
      logicalNodeId: "test-workflow:node:1",
      definitionId: "work",
      iteration: 1,
      resumeRevertCount: 0,
      provenance: { _tag: "authored" },
      handoff: null,
      priorRetryFeedback: null,
      item: null,
    });
    expect(identityDefinitionIds(control.definitionIdentity)).toEqual(["follow", "residual", "work"]);
    expect(control.frontier).toEqual(["test-workflow:node:1"]);
  });

  it("refuses an if that names a field which is never empty", () => {
    expect(() => compile([
      { phase: "work", ...record("work", { output: { summary: "The work.", fields: { done: { type: "boolean", description: "Whether it is done." } } } }) },
      { phase: "follow", if: "work.done", ...record("follow") },
    ])).toThrow(/if "work.done" names "done" of "work", a boolean, which is never empty/);
  });

  it("compiles a phase of named agents to a phase node that owns one agent node for each agent", () => {
    const control = compile([
      { phase: "source", ...record("source") },
      { phase: "build", name: "Build", agents: [{ agent: "work", ...record("work") }, { agent: "review", ...record("review", { retry: { max: 2 } }) }], retry: { max: 4 } },
      { phase: "follow", ...record("follow") },
    ]);
    const build = "test-workflow:node:2";

    expect(control.graph.nodes.map(({ id, kind, order, ownership }) => [id, kind, order, ownership._tag === "phase" ? ownership.parentNodeId : null])).toEqual([
      ["test-workflow:node:1", "agent", 0, null],
      [build, "phase", 1, null],
      [`${build}:node:1`, "agent", 2, build],
      [`${build}:node:2`, "agent", 3, build],
      ["test-workflow:node:3", "agent", 4, null],
    ]);
    expect(control.graph.nodes[1]).toMatchObject({
      kind: "phase", phaseId: "build", name: "Build",
      join: { reducer: { id: "collect", version: 1 }, write: { id: "build", lifetime: "transient" }, settlement: null },
    });
    // A named agent's own retry replaces the phase's, which is the default.
    expect(control.graph.nodes.slice(2, 4).map((node) => node.kind === "agent" ? node.retry : null)).toEqual([{ max: 4, stuck: false }, { max: 2, stuck: false }]);
    expect(control.graph.dependencies).toEqual([
      { nodeId: build, dependsOn: "test-workflow:node:1" },
      { nodeId: "test-workflow:node:3", dependsOn: build },
    ]);
    // Containers hold no attempts; attempts follow graph preorder.
    expect(control.attempts.map(({ logicalNodeId }) => logicalNodeId)).toEqual(["test-workflow:node:1", `${build}:node:1`, `${build}:node:2`, "test-workflow:node:3"]);
    expect(control.attempts[1]?.ownership).toEqual({ _tag: "phase", workflowDefinitionId: "test-workflow", phaseId: "build", parentNodeId: build });
  });

  it("compiles a while repeat to a repeat node that owns round 1 of its phases", () => {
    const control = compile([
      { repeat: { while: "review.findings", max: 5, stuck: true }, phases: [
        { phase: "review", ...record("review", { output: { summary: "The review.", fields: { findings: listField(4) } } }) },
        { phase: "fix", ...record("fix") },
      ] },
    ]);
    const repeat = "test-workflow:node:1";

    expect(control.graph.nodes).toMatchObject([
      { kind: "repeat", id: repeat, loop: { _tag: "while", evaluator: `${repeat}:round:1:node:1`, field: "findings", max: 5, stuck: true, priorSignal: null } },
      { kind: "agent", id: `${repeat}:round:1:node:1`, definitionId: "review", ownership: { _tag: "round", parentNodeId: repeat, round: 1 } },
      { kind: "agent", id: `${repeat}:round:1:node:2`, definitionId: "fix", ownership: { _tag: "round", parentNodeId: repeat, round: 1 } },
    ]);
    expect(control.graph.dependencies).toEqual([{ nodeId: `${repeat}:round:1:node:2`, dependsOn: `${repeat}:round:1:node:1` }]);
    expect(control.attempts.map(({ definitionId, iteration, item }) => [definitionId, iteration, item])).toEqual([["review", 1, null], ["fix", 1, null]]);
  });

  it("compiles an each repeat with its source, its width, and its reassess phase", () => {
    const control = compile([
      { phase: "source", ...record("source", { output: { summary: "The items.", fields: { items: listField(3) } } }) },
      { repeat: { each: "source.items", reassess: "reassess" }, phases: [{ phase: "work", ...record("work") }, { phase: "reassess", ...record("reassess") }] },
    ]);
    const repeat = "test-workflow:node:2";

    expect(control.graph.nodes[1]).toMatchObject({
      kind: "repeat",
      loop: { _tag: "each", source: { nodeId: "test-workflow:node:1", field: "items" }, width: 3, reassess: `${repeat}:round:1:node:2`, items: null },
    });
    expect(control.graph.dependencies).toEqual([
      { nodeId: `${repeat}:round:1:node:2`, dependsOn: `${repeat}:round:1:node:1` },
      { nodeId: repeat, dependsOn: "test-workflow:node:1" },
    ]);
    expect(identityDefinitionIds(control.definitionIdentity)).toEqual(["reassess", "source", "work"]);
  });

  it("sizes a list after an each repeat by every round of the repeat, and refuses one whose rounds have no bound", () => {
    const phases = (sourceItems: unknown) => [
      { phase: "source", ...record("source", { output: { summary: "The items.", fields: { items: sourceItems } } }) },
      { repeat: { each: "source.items" }, phases: [{ phase: "work", ...record("work", { output: { summary: "The files.", fields: { files: listField(2) } } }) }] },
      { phase: "review", over: "work.files", ...record("review") },
    ];
    // Three rounds of at most two files each.
    expect(compile(phases(listField(3))).graph.nodes.find(({ kind }) => kind === "list")).toMatchObject({ width: 6 });
    const { max: _max, ...unbounded } = listField(3);
    expect(() => compile(phases(unbounded))).toThrow('Workflow "test-workflow": Phase "review" over reads "work.files" from outside a repeat over a list that declares no max, so the number of rounds and the width are unknown; declare max on the list that the repeat runs over');
  });

  it("rejects a reference that names no earlier output", () => {
    expect(() => compile([{ phase: "work", ...record("work") }, { phase: "follow", if: "missing", ...record("follow") }]))
      .toThrow('Workflow "test-workflow": Phase "follow" if names "missing", which is no phase or agent of this workflow');
    expect(() => compile([{ phase: "work", if: "follow", ...record("work") }, { phase: "follow", ...record("follow") }]))
      .toThrow(/if names "follow", which does not finish before this phase starts/);
    expect(() => compile([{ repeat: { while: "other.findings", max: 2 }, phases: [{ phase: "review", ...record("review") }] }, { phase: "other", ...record("other", { output: { summary: "Other.", fields: { findings: listField(2) } } }) }]))
      .toThrow(/while names "other", which is not a phase of the repeat's own phases/);
  });

  it("compiles one method at two places with distinct policy and no ambiguous lookup", () => {
    const control = compile([
      { phase: "strict", brief: "Follow the work method.", name: "Strict work", dependencies: ["work"], writes: [] },
      { phase: "loose", brief: "Follow the work method.", name: "Loose work", dependencies: ["work"], writes: [] },
    ]);

    expect(control.graph.nodes.map((node) => node.kind === "agent" ? [node.definitionId, node.name] : null)).toEqual([
      ["strict", "Strict work"],
      ["loose", "Loose work"],
    ]);
    const identity = control.definitionIdentity;
    if (!("steps" in identity)) throw new Error("A compile records the agent identity");
    const [loose, strict] = identity.steps;
    expect([loose?.stepId, strict?.stepId]).toEqual(["loose", "strict"]);
    expect(strict?.policySha256).not.toBe(loose?.policySha256);
    expect(control.definitionIdentity.skills.map(({ skillId }) => skillId)).toEqual(["work"]);
  });

  it("refuses a workflow that queues more attempts than its attempt limit, with a named finding and remedy", () => {
    const limitOfTwo = { maxAttempts: 2, maxMutationsPerAttempt: 3, maxInserts: 20 };
    const flat = authored([{ phase: "work", ...record("work") }, { phase: "review", ...record("review") }, { phase: "fix", ...record("fix") }]);
    let error: unknown;
    try {
      compileWorkflowControl(flat.workflow, flat.agents, { skills }, limitOfTwo);
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof WorkflowStructureRejectedError)) throw new Error("Expected a structural rejection");
    expect(error.message).toMatch(/attempt_limit_overrun: The workflow queues 3 attempts, more than its attempt limit of 2\. Raise guardrails\.max_attempts \(at most 4096\)/);
    // A repeat counts an attempt for each phase of each of its rounds.
    const loop = authored([{ repeat: { while: "review.findings", max: 2 }, phases: [
      { phase: "work", ...record("work") },
      { phase: "review", ...record("review", { output: { summary: "The review.", fields: { findings: listField(2) } } }) },
      { phase: "fix", ...record("fix") },
    ] }]);
    expect(() => compileWorkflowControl(loop.workflow, loop.agents, { skills }, limitOfTwo)).toThrow(/The workflow queues 6 attempts, more than its attempt limit of 2\./);
    // Without an attempt limit, the run gets the worst case of its rounds.
    expect(compileWorkflowControl(loop.workflow, loop.agents, { skills }, { ...limitOfTwo, maxAttempts: undefined }).guardrails.maxAttempts).toBe(6);
  });

  it("hashes the phase structure as the graph identity, and a display name is not identity", () => {
    const identity = (phases: readonly unknown[]) => authoredIdentity(phases);
    const base = [
      { phase: "work", ...record("work") },
      { phase: "build", agents: [{ agent: "review", ...record("review") }, { agent: "fix", ...record("fix") }] },
      { phase: "follow", ...record("follow") },
    ];
    const changed = (phases: readonly unknown[]) => definitionIdentityMismatches(identity(base), identity(phases)).map(({ component }) => component);

    expect(changed(base)).toEqual([]);
    expect(changed([base[0], { ...base[1], name: "Build it" }, base[2]])).toEqual([]);
    expect(changed([base[0], { phase: "build", agents: [{ agent: "fix", ...record("fix") }, { agent: "review", ...record("review") }] }, base[2]])).toEqual(["graph"]);
    expect(changed([base[0], base[1], { ...base[2], retry: { max: 2 } }])).toEqual(["graph"]);
  });
});

function authoredIdentity(phases: readonly unknown[]) {
  const { workflow, agents } = authored(phases);
  return compileWorkflowControl(workflow, agents, { skills }).definitionIdentity;
}

describe("workflow list compilation", () => {
  const encoded = Schema.encodeSync(WorkflowDefinitionSchema)(mapWorkflow);
  type Encoded = typeof encoded;
  type Phase = Encoded["phases"][number];
  const compileChanged = (change: (definition: Encoded) => object) => {
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)(change(encoded));
    return compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: mapSkills });
  };
  /** The definition with the phase of id `id` changed. */
  const withPhase = (id: string, change: (phase: Phase) => object) => (definition: Encoded) => ({
    ...definition,
    phases: definition.phases.map((phase) => "phase" in phase && phase.phase === id ? change(phase) : phase),
  });

  it("compiles one pending list with its width, key, phases, and join", () => {
    const list = compileChanged((definition) => definition).graph.nodes.find(({ id }) => id === MAP_GROUP);
    expect(list).toMatchObject({
      kind: "list", outputId: "review", source: { nodeId: PLAN, field: "items" }, key: "id", label: "title", width: 3,
      phases: [{ definitionId: "implement" }, { definitionId: "review" }], reducer: { id: "collect", version: 1, params: {} },
      write: { id: "reviews", lifetime: "durable" }, admittedContext: null, settlement: null,
    });
  });

  it("writes one transient artifact named after the last phase of the stream when the join declares no write", () => {
    const list = compileChanged(withPhase("review", (phase) => ({ ...phase, join: { reducer: "collect" } }))).graph.nodes.find(({ kind }) => kind === "list");
    expect(list).toMatchObject({ write: { id: "review", lifetime: "transient" } });
  });

  it.each([
    ["an unknown reducer", withPhase("review", (phase) => ({ ...phase, join: { reducer: "fold" } })), /names unknown reducer "fold"/],
    ["reducer parameters it does not accept", withPhase("review", (phase) => ({ ...phase, join: { reducer: "collect", with: { limit: 2 } } })), /join.with does not fit reducer "collect@1"/],
    ["a source that is not a list", withPhase("implement", (phase) => ({ ...phase, over: "plan.summary" })), /is not a declared list field/],
    ["a label that is not an item field", withPhase("implement", (phase) => ({ ...phase, label: "missing" })), /label "missing" is not a string field/],
  ] as const)("rejects a list with %s", (_name, change, message) => {
    expect(() => compileChanged(change)).toThrow(message);
  });

  // A named workflow launched later, for someone who did not write it,
  // so load time is the only check its author sees. A workflow file may
  // leave both keys out (refer to the path-workflow tests).
  it("rejects a named workflow's source list without a declared max or unique key", () => {
    const { max: _max, ...unbounded } = itemList(3);
    const { unique: _unique, ...unkeyed } = itemList(3);
    const withItems = (list: Partial<ReturnType<typeof itemList>>) => withPhase("plan", (phase) => ({ ...phase, output: { summary: "The plan.", fields: { items: list } } }));
    expect(() => compileChanged(withItems(unbounded))).toThrow(/declares no max/);
    expect(() => compileChanged(withItems(unkeyed))).toThrow(/declares no unique key/);
  });
});

describe("coverage join compilation", () => {
  const encoded = Schema.encodeSync(WorkflowDefinitionSchema)(surveyWorkflow);
  type Encoded = typeof encoded;
  type Phase = Encoded["phases"][number];
  type Fields = { readonly [key: string]: unknown };
  const compileChanged = (change: (definition: Encoded) => object) => {
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)(change(encoded));
    return compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: mapSkills });
  };
  const withPhase = (id: string, change: (phase: Phase & { readonly [key: string]: unknown }) => object) => (definition: Draft) => ({
    ...definition,
    phases: definition.phases.map((phase) => isPhase<Phase>(id, phase) ? change(phase) : phase),
  });
  const PARAMS = { priority: "priority", outcome: "outcome", exclusions: "exclusions" };
  const withParams = (params: Fields) => withPhase("verify", (phase) => ({ ...phase, join: { reducer: "coverage", with: params } }));
  const inventoryFields = surveyInventoryFields;
  const targetFields = inventoryFields.targets.of.fields;
  const withInventory = (fields: Fields) => withPhase("inventory", (phase) => ({ ...phase, output: { summary: "The inventory.", fields } }));
  const withTargetFields = (fields: Fields) => withInventory({ ...inventoryFields, targets: { ...inventoryFields.targets, of: { type: "object", fields } } });
  const withOutcome = (outcome: Fields) => withPhase("verify", (phase) => ({ ...phase, output: { summary: "The verdict.", fields: { outcome } } }));
  const priorityEnum = (values: readonly string[]) => ({ type: "enum", values, description: "How much the target matters." });
  const outcomeEnum = (values: readonly string[], extra: Fields = {}) => ({ type: "enum", values, description: "Whether the target was surveyed.", ...extra });

  it("records the coverage reducer with its decoded parameters", () => {
    expect(compileChanged((definition) => definition).graph.nodes.find(({ id }) => id === SURVEY_GROUP)).toMatchObject({
      kind: "list", key: "id", width: 8, reducer: { id: "coverage", version: 1, params: PARAMS },
    });
    expect(compileChanged(withParams({ priority: "priority", outcome: "outcome" })).graph.nodes.find(({ id }) => id === SURVEY_GROUP)).toMatchObject({
      reducer: { params: { priority: "priority", outcome: "outcome" } },
    });
  });

  it.each([
    ["no outcome parameter", withParams({ priority: "priority" }), /join.with does not fit reducer "coverage@1": Missing key\s+at \["outcome"\]/],
    ["a priority that no item declares", withParams({ ...PARAMS, priority: "rank" }), /join.with does not fit reducer "coverage@1": priority "rank" is not a declared field of the items of "inventory.targets"/],
    ["a priority that is not an enum", withParams({ ...PARAMS, priority: "title" }), /priority "title" must be an enum of required \| supporting, not a string field of the items/],
    ["a priority with a value outside required and supporting", withTargetFields({ ...targetFields, priority: priorityEnum(["required", "optional"]) }), /priority "priority" declares "optional", which is not one of required \| supporting/],
    ["a priority that cannot name a required target", withTargetFields({ ...targetFields, priority: priorityEnum(["supporting"]) }), /priority "priority" must declare "required"/],
    ["an optional priority", withTargetFields({ ...targetFields, priority: { ...priorityEnum(["required", "supporting"]), optional: true } }), /priority "priority" must be a required and not nullable field of the/],
    ["an outcome that the last phase does not declare", withParams({ ...PARAMS, outcome: "verdict" }), /outcome "verdict" is not a declared field of the output of the last phase "verify"/],
    ["an outcome that cannot report surveyed", withOutcome(outcomeEnum(["inaccessible", "excluded"])), /outcome "outcome" must declare "surveyed"/],
    ["an outcome with a foreign value", withOutcome(outcomeEnum(["surveyed", "skipped"])), /outcome "outcome" declares "skipped", which is not one of surveyed \| inaccessible \| excluded/],
    ["a nullable outcome", withOutcome(outcomeEnum(["surveyed"], { nullable: true })), /outcome "outcome" must be a required and not nullable field of the/],
    ["exclusions that the source does not declare", withParams({ ...PARAMS, exclusions: "skipped" }), /exclusions "skipped" is not a declared field of the output of "inventory"/],
    ["exclusions that are not a list", both(withInventory({ ...inventoryFields, note: { type: "string", description: "A note." } }), withParams({ ...PARAMS, exclusions: "note" })), /exclusions "note" must be a list, not a string field of the output of "inventory"/],
    ["exclusions whose items carry no key", withInventory({ ...inventoryFields, exclusions: { type: "list", description: "Excluded.", of: { type: "object", fields: { name: { type: "string", description: "A name." } } } } }), /exclusions "exclusions" must hold strings, or objects with a required string "id"/],
  ] as const)("rejects a coverage join with %s", (_name, change, message) => {
    expect(() => compileChanged(change)).toThrow(message);
  });

  it("admits exclusions as a list of keys, and refuses them on a list of the launch input", () => {
    expect(() => compileChanged(withInventory({ ...inventoryFields, exclusions: { type: "list", description: "Excluded.", of: { type: "string" } } }))).not.toThrow();
    const overInput = (definition: Encoded) => ({
      ...definition,
      input: { fields: { targets: inventoryFields.targets } },
      phases: definition.phases.filter((phase) => !("phase" in phase) || phase.phase !== "inventory").map((phase) => "phase" in phase && phase.phase === "survey" ? { ...phase, over: "input.targets" } : phase),
    });
    expect(() => compileChanged(overInput)).toThrow(/exclusions "exclusions" needs a source phase; the launch input holds no exclusions list/);
  });

  it("refuses exclusions over a workflow file's list without a unique key, whose targets have no key to exclude", () => {
    const { unique: _unique, ...unkeyed } = inventoryFields.targets;
    const encodedFile = withInventory({ ...inventoryFields, targets: unkeyed, exclusions: { type: "list", description: "Excluded.", of: { type: "string" } } })(encoded);
    const workflow = { ...Schema.decodeUnknownSync(WorkflowDefinitionSchema)(encodedFile), provenance: { layer: "session" as const, filePath: "/s/scratch/workflows/survey.workflow.yaml", id: "survey" } };

    expect(() => compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: mapSkills }))
      .toThrow(/exclusions "exclusions" names targets by their unique key, and the source list declares none/);
  });
});

describe("selecting join compilation", () => {
  const encoded = Schema.encodeSync(WorkflowDefinitionSchema)(findingsWorkflow);
  type Encoded = typeof encoded;
  type Phase = Encoded["phases"][number];
  type Fields = { readonly [key: string]: unknown };
  const compileChanged = (change: (definition: Encoded) => object) => {
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)(change(encoded));
    return compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: mapSkills });
  };
  const withPhase = (id: string, change: (phase: Phase & { readonly [key: string]: unknown }) => object) => (definition: Draft) => ({
    ...definition,
    phases: definition.phases.map((phase) => isPhase<Phase>(id, phase) ? change(phase) : phase),
  });
  const withJoin = (join: Fields) => withPhase("reviews", (phase) => ({ ...phase, join }));
  const withVote = (params: Fields) => withPhase("checks", (phase) => ({ ...phase, join: { reducer: "quorum", with: params } }));
  const withReviewOutput = (fields: Fields) => withPhase("reviews", (phase) => ({ ...phase, output: { summary: "The review.", fields } }));
  const withFinding = (fields: Fields) => withReviewOutput({ findings: { ...reviewFindingsFields.findings, of: { type: "object", fields } } });
  const withVerdict = (verdict: Fields) => withPhase("checks", (phase) => ({ ...phase, output: { summary: "The verdict.", fields: { verdict } } }));
  const findingFields = reviewFindingsFields.findings.of.fields;
  const text = (description: string) => ({ type: "string", description });
  const VOTE = { vote: "verdict", min_valid: 1, max_refuted: 0 };

  it("compiles review, dedupe, and verify each kept finding, and pins each join's output contract on its list", () => {
    const control = compileChanged((definition) => definition);
    const reviews = control.graph.nodes.find(({ id }) => id === FINDINGS_REVIEWS);
    const checks = control.graph.nodes.find(({ id }) => id === FINDINGS_CHECKS);
    expect(reviews).toMatchObject({ kind: "list", width: 3, reducer: { id: "dedupe", version: 2, params: { items: "findings", by: "id" } } });
    // The kept list of the dedupe join copies the finding fields, so the
    // second list runs over it with the finding id as each item key, at the
    // worst case of three files of two findings.
    expect(reviews?.kind === "list" ? reviews.reducer.contract["kept"] : undefined).toMatchObject({ max: 6, unique: "id", of: { fields: { ...findingFields, branch: { type: "string" } } } });
    expect(checks).toMatchObject({ kind: "list", source: { nodeId: FINDINGS_REVIEWS, field: "kept" }, key: "id", label: "title", width: 6, reducer: { id: "quorum", params: { group_by: "area" } } });
    expect(checks?.kind === "list" ? checks.reducer.contract["passed"] : undefined).toMatchObject({ max: 6, unique: "group" });
  });

  it.each([
    ["dedupe items that the last phase does not declare", withJoin({ reducer: "dedupe", with: { items: "issues", by: "id" } }), /join.with does not fit reducer "dedupe@2": items "issues" is not a declared field of the output of the last phase "reviews"/],
    ["dedupe items that are not objects", withReviewOutput({ findings: { type: "list", description: "The findings.", max: 2, of: { type: "string" } } }), /items "findings" must hold objects, so that each entry can name its agent/],
    ["dedupe items that are an object, not a list", both(withReviewOutput({ ...reviewFindingsFields, meta: { type: "object", description: "The metadata.", fields: { id: text("The id.") } } }), withJoin({ reducer: "dedupe", with: { items: "meta", by: "id" } })), /items "meta" must be a list, not an object field of the output of the last phase "reviews"/],
    ["dedupe by a field that the items do not declare", withJoin({ reducer: "dedupe", with: { items: "findings", by: "url" } }), /by "url" is not a declared field of the items of "findings"/],
    ["dedupe by a field that is not a string", both(withFinding({ ...findingFields, rank: { type: "number", description: "The rank." } }), withJoin({ reducer: "dedupe", with: { items: "findings", by: "rank" } })), /by "rank" must be a string field, not a number field of the items of "findings"/],
    ["dedupe by an optional key", both(withFinding({ ...findingFields, url: { type: "string", optional: true, description: "The url." } }), withJoin({ reducer: "dedupe", with: { items: "findings", by: "url" } })), /by "url" must be a required and not nullable field of the items of "findings", so every item states it/],
    ["dedupe items that declare the branch field", withFinding({ ...findingFields, branch: text("A branch.") }), /items "findings" holds items that declare "branch", which the join adds to each entry to name its agent/],
    ["dedupe without a by parameter", withJoin({ reducer: "dedupe", with: { items: "findings" } }), /join.with does not fit reducer "dedupe@2": Missing key\s+at \["by"\]/],
    ["top by a string field", withJoin({ reducer: "top", with: { items: "findings", by: "title", count: 2, order: "desc" } }), /join.with does not fit reducer "top@1": by "title" must be a number or enum field, not a string field of the items of "findings"/],
    ["top by an object field", both(withFinding({ ...findingFields, where: { type: "object", description: "Where.", fields: { line: { type: "number", description: "The line." } } } }), withJoin({ reducer: "top", with: { items: "findings", by: "where", count: 2, order: "desc" } })), /by "where" must be a number or enum field, not an object field of the items of "findings"/],
    ["top with a count of zero", withJoin({ reducer: "top", with: { items: "findings", by: "title", count: 0, order: "desc" } }), /join.with does not fit reducer "top@1": Expected a value greater than or equal to 1\s+at \["count"\]/],
    ["top with an unknown order", withJoin({ reducer: "top", with: { items: "findings", by: "title", count: 1, order: "down" } }), /join.with does not fit reducer "top@1": Expected "desc" \| "asc"\s+at \["order"\]/],
    ["a quorum vote that the last phase does not declare", withVote({ ...VOTE, vote: "outcome" }), /join.with does not fit reducer "quorum@1": vote "outcome" is not a declared field of the output of the last phase "checks"/],
    ["a quorum vote that is not an enum", withVerdict(text("The verdict.")), /vote "verdict" must be an enum field, not a string field/],
    ["a quorum vote that is an object", withVerdict({ type: "object", description: "The verdict.", fields: { value: text("The value.") } }), /vote "verdict" must be an enum field, not an object field of the output of the last phase "checks"/],
    ["a quorum vote with other values", withVerdict({ type: "enum", values: ["valid", "refuted"], description: "The verdict." }), /vote "verdict" must declare exactly valid \| refuted \| abstain, not "valid", "refuted"/],
    ["an optional quorum vote", withVerdict({ type: "enum", values: ["valid", "refuted", "abstain"], optional: true, description: "The verdict." }), /vote "verdict" must be a required and not nullable field of the output of the last phase "checks", so every agent states it/],
    ["a quorum floor of zero valid votes", withVote({ ...VOTE, min_valid: 0 }), /join.with does not fit reducer "quorum@1": Expected a value greater than or equal to 1\s+at \["min_valid"\]/],
    ["a quorum group_by that the items do not declare", withVote({ ...VOTE, group_by: "owner" }), /group_by "owner" is not a declared field of the items of "reviews.kept"/],
    ["a quorum that groups by the item key and needs more than one valid vote", withVote({ ...VOTE, min_valid: 2, group_by: "id" }), /group_by "id" is the key of each item, so each group holds one vote and can never reach min_valid 2; remove group_by and set votes on the phase/],
  ] as const)("rejects %s", (_name, change, message) => {
    expect(() => compileChanged(change)).toThrow(message);
  });
});

describe("workflow input list compilation", () => {
  const agents = resolveWorkflowAgents(inputMapWorkflow);
  const limits = (maxAttempts: number | undefined) => ({ maxAttempts, maxMutationsPerAttempt: 3, maxInserts: 20 });
  const launch = (input: { readonly [key: string]: unknown } | null, maxAttempts = 50) =>
    compileWorkflowControl(inputMapWorkflow, agents, { skills: mapSkills }, limits(maxAttempts), input === null ? null : { goal: "Ship.", ...input });
  const encoded = Schema.encodeSync(WorkflowDefinitionSchema)(inputMapWorkflow);
  const compileChanged = (change: (definition: typeof encoded) => object) => {
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)(change(encoded));
    return compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: mapSkills });
  };

  it("expands a list over the launch input at launch, with exactly one item for each input item", () => {
    const control = launch({ items: items("a", "b") });
    const list = control.graph.nodes.find(({ id }) => id === INPUT_GROUP);
    expect(list).toMatchObject({ kind: "list", source: { nodeId: "input", field: "items" }, width: 3, admittedContext: null, state: { _tag: "ready" } });
    expect(control.graph.nodes.map(({ id }) => id)).toEqual([
      INPUT_GROUP, inputBranch(1), inputStage(1, 1), inputStage(1, 2), inputBranch(2), inputStage(2, 1), inputStage(2, 2), INPUT_TAIL,
    ]);
    expect(control.graph.joins).toEqual([{ kind: "collect_all", nodeId: INPUT_GROUP, requiredNodeIds: [inputBranch(1), inputBranch(2)] }]);
    expect(control.attempts.filter(({ provenance }) => provenance._tag === "item").map(({ item }) => item)).toEqual([...items("a", "b"), ...items("a", "b")].toSorted((left, right) => left.id.localeCompare(right.id)));
    // An item waits for its list to open, so no agent is ready at launch.
    expect(control.frontier).toEqual([]);
  });

  it("admits the exact items, not the declared width", () => {
    // Two items queue 2 x 2 agents and the tail: 5 attempts. The declared
    // width of 3 would queue 7.
    expect(launch({ items: items("a", "b") }, 5).attempts).toHaveLength(5);
    expect(() => launch({ items: items("a", "b", "c") }, 5)).toThrow(WorkflowStructureRejectedError);
    // An empty list queues the tail only.
    expect(launch({ items: [] }, 1).graph.joins).toEqual([{ kind: "collect_all", nodeId: INPUT_GROUP, requiredNodeIds: [] }]);
  });

  it("runs a workflow file that declares no attempt limit with the worst case of its real input, up to the ceiling", () => {
    // Up to 400 items, and the first agent of an item tries up to 10 times.
    const file = (guardrails?: { readonly max_attempts: number }): WorkflowDefinition => ({
      ...Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
        ...encoded,
        input: { fields: { items: itemList(400) } },
        phases: encoded.phases.map((phase, index) => index === 0 ? { ...phase, retry: { max: 10 } } : phase),
        ...(guardrails === undefined ? {} : { guardrails }),
      }),
      provenance: { layer: "session", filePath: "scratch/workflows/input-mapped.workflow.yaml", id: "input-mapped" },
    });
    expect([launchGuardrailLimits(file({ max_attempts: 7 }), 50).maxAttempts, launchGuardrailLimits(file(), 50).maxAttempts, launchGuardrailLimits(inputMapWorkflow, 50).maxAttempts]).toEqual([7, undefined, 50]);
    const launchFile = (count: number) => compileWorkflowControl(file(), agents, { skills: mapSkills }, limits(undefined), { items: items(...Array.from({ length: count }, (_, index) => `i${index}`)) });
    // Each item runs its first agent up to 10 times and its second once, and
    // the tail runs once.
    expect(launchFile(3).guardrails.maxAttempts).toBe(34);
    expect(launchFile(372).guardrails.maxAttempts).toBe(4093);
    expect(() => launchFile(373)).toThrow("attempt_limit_overrun: The workflow needs 4104 attempts for its worst case, more than the ceiling of 4096.");
  });

  it.each([
    ["a list over the input of a workflow without an input contract", ({ input: _input, ...definition }: typeof encoded) => definition, /declares no input contract/],
    ["a list over an input field that is not a list", (definition: typeof encoded) => ({
      ...definition, phases: definition.phases.map((phase, index) => index === 0 ? { ...phase, over: "input.goal" } : phase),
    }), /reads "input.goal", which is not a declared list field of the input contract/],
  ] as const)("rejects %s", (_name, change, message) => {
    expect(() => compileChanged(change)).toThrow(message);
  });

  it("pins the input contract in the graph identity, and only its accepted shape", () => {
    const identity = (change: (definition: typeof encoded) => object) => compileChanged(change).definitionIdentity;
    const base = identity((definition) => definition);
    const graphChanges = (next: typeof base) => definitionIdentityMismatches(base, next).map(({ component }) => component);
    const withGoal = (goal: { readonly type: "string"; readonly description: string; readonly optional?: boolean }) => (definition: typeof encoded) => ({ ...definition, input: { fields: { items: itemList(3), goal } } });
    expect(graphChanges(identity(withGoal({ type: "string", description: "Other words for the goal." })))).toEqual([]);
    expect(graphChanges(identity(withGoal({ type: "string", description: "The goal.", optional: true })))).toEqual(["graph"]);
    // A workflow without a contract hashes its phase structure alone.
    expect(authoredIdentity([{ phase: "work", ...record("work") }])).toMatchObject({ graphSha256: hashDefinition({ phases: [{ phase: "work" }] }).sha256 });
  });
});
