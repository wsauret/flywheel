import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { describeClosureFailure, validateSkillDependencies, validateWorkflowDefinition } from "../../../../src/workflows/definition-validation.js";
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js";
import type { SkillRegistryRevision } from "../../../../src/workflows/skill-schema.js";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js";
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js";

/** The packages a fixture agent may depend on. */
const SKILLS: SkillRegistryRevision = testSkillRevision([testSkill("planning"), testSkill("review-method")]);

interface AuthoredObject {
  [key: string]: unknown;
}

/** Decode one authored workflow strictly, as the loader does, and present it as
 *  the loaded set of one. */
function workflowSet(raw: AuthoredObject): ReadonlyMap<string, WorkflowDefinition> {
  const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema, { onExcessProperty: "error" })({
    id: "wf",
    name: "Workflow",
    ...raw,
  });
  return new Map([[workflow.id, workflow]]);
}

function messages(workflows: ReadonlyMap<string, WorkflowDefinition>, skills: SkillRegistryRevision = SKILLS): string[] {
  return [...validateSkillDependencies(skills), ...[...workflows.values()].flatMap((workflow) => validateWorkflowDefinition(workflow, skills))].map((error) => error.message);
}

/** The messages of a workflow of these phases and repeats. */
function phaseMessages(phases: readonly unknown[], skills: SkillRegistryRevision = SKILLS): string[] {
  return messages(workflowSet({ phases }), skills);
}

/** One phase with an inline brief, as the workflow file declares it. */
function phase(id: string, extra: AuthoredObject = {}): AuthoredObject {
  return { phase: id, name: id, brief: `Do the ${id} work.`, ...extra };
}

function fields(map: AuthoredObject): AuthoredObject {
  return { output: { fields: map } };
}

const text = { type: "string", description: "Text." };
const flag = { type: "boolean", description: "A flag." };
const items = { type: "list", of: { type: "string" }, description: "Items." };
const milestones = {
  type: "list",
  max: 4,
  unique: "id",
  description: "The milestones.",
  of: { type: "object", fields: { id: { type: "string", description: "The milestone id." }, goal: text } },
};

describe("validateDefinitionSet", () => {
  it("accepts every shape of a valid workflow", () => {
    expect(phaseMessages([
      phase("plan", { dependencies: ["planning"], ...fields({ milestones, notes: { ...text, nullable: true } }) }),
      { phase: "check", if: "plan.notes", runs: "review" },
      { repeat: { each: "plan.milestones", reassess: "reassess" }, phases: [phase("work"), phase("reassess")] },
      { repeat: { while: "review.findings", max: 3 }, phases: [phase("review", { dependencies: ["review-method"], ...fields({ findings: items }) }), phase("fix")] },
      { phase: "build", agents: ["left", "right"].map((id) => {
        const { phase: _phase, ...keys } = phase(id);
        return { agent: id, ...keys };
      }) },
      phase("revise", { reads: ["build", "left"], if: "build.items" }),
    ])).toEqual([]);
  });

  it("reports a reference that names no phase or agent, and one that names a later phase", () => {
    expect(phaseMessages([phase("plan"), phase("work", { reads: ["missing"] }), phase("each", { over: "nowhere.items" }), phase("gated", { if: "missing.field" })])).toEqual([
      'Workflow "wf": Phase "work" reads names "missing", which is no phase or agent of this workflow',
      'Workflow "wf": Phase "each" over names "nowhere", which is no phase or agent of this workflow',
      'Workflow "wf": Phase "gated" if names "missing", which is no phase or agent of this workflow',
    ]);
    expect(phaseMessages([phase("work", { reads: ["review"] }), phase("review")])).toEqual([
      'Workflow "wf": Phase "work" reads names "review", which does not finish before this phase starts; phases run in order, so name an earlier phase or agent',
    ]);
    expect(phaseMessages([phase("work", { reads: ["work"] })])).toEqual(['Workflow "wf": Phase "work" reads names "work", which is its own output']);
  });

  it("gives each phase and named agent its own name, and keeps the launch input's name", () => {
    expect(phaseMessages([
      phase("plan"),
      phase("plan"),
      phase("input"),
      { phase: "build", agents: [{ agent: "plan", brief: "Plan again.", name: "Plan" }, { agent: "other", brief: "Other.", name: "Other" }] },
    ])).toEqual([
      'Workflow "wf": Phase "plan" takes the name "plan", which another phase or agent of this file already takes; give each phase and agent its own name',
      'Workflow "wf": Phase "input" uses the reserved id "input", which names the launch input; give it another name',
      'Workflow "wf": Agent "plan" takes the name "plan", which another phase or agent of this file already takes; give each phase and agent its own name',
    ]);
  });

  it("reports a dependency that is not installed", () => {
    expect(phaseMessages([phase("plan", { dependencies: ["never-installed"] })])).toEqual([
      'Workflow "wf" agent "plan" requires skill "never-installed", which is not installed',
    ]);
  });

  it("refuses runs beside brief, a runs that names the default brief, and a brief that no file holds", () => {
    expect(phaseMessages([phase("plan"), { phase: "again", runs: "plan", brief: "Also." }])).toEqual([
      'Workflow "wf": Phase "again" runs stands beside brief; a record runs a named brief or states its own, not both',
    ]);
    expect(phaseMessages([{ phase: "self", runs: "self" }])).toContain('Workflow "wf": Phase "self" runs names "self", the brief that the record runs without it; remove runs');
    expect(phaseMessages([phase("plan"), { phase: "again", runs: "absent" }])).toEqual([
      'Workflow "wf" agent "again": runs brief "absent", which this file does not hold; write the brief inline, or run a brief that another phase of this file states',
    ]);
  });

  it("keeps a reused inline brief's output with its declaration", () => {
    expect(phaseMessages([phase("plan"), { phase: "again", runs: "plan" }])).toEqual([]);
    expect(phaseMessages([phase("plan"), { phase: "again", runs: "plan", output: { summary: "Mine." } }])).toEqual([
      'Workflow "wf": Phase "again" output stands beside a reused brief, which declares its own output; write the brief inline to change it',
    ]);
  });

  it("refuses the output of a phase of named agents that no record's brief takes", () => {
    const ownBriefs = [{ agent: "to-http", brief: "Trace HTTP." }, { agent: "to-claude", brief: "Trace Claude." }];
    const claims = fields({ claims: items });
    expect(phaseMessages([{ phase: "trace", agents: ownBriefs, ...claims }])).toEqual([
      'Workflow "wf": Phase "trace" output stands on a phase of named agents that states no brief, and it belongs to an inline brief; move output beside each agent\'s brief',
    ]);
    expect(phaseMessages([phase("plan"), { phase: "trace", runs: "plan", agents: ["to-http", "to-claude"], dependencies: ["planning"] }])).toEqual([
      'Workflow "wf": Phase "trace" dependencies stands on a phase of named agents that states no brief, and it belongs to an inline brief; move dependencies beside each agent\'s brief',
    ]);
    expect(phaseMessages([{ phase: "trace", brief: "Trace one way.", agents: ownBriefs, ...claims }])).toEqual([
      'Workflow "wf": Phase "trace" output belongs to the phase brief, which runs no agent, because each named agent states its own brief or runs; move output beside each agent\'s brief',
    ]);
    // A record that runs the phase brief takes its output.
    expect(phaseMessages([{ phase: "trace", brief: "Trace one way.", agents: ownBriefs, ...claims }, { phase: "again", runs: "trace" }])).toEqual([]);
  });

  it("rejects mixed write lifetimes and allows several writes with one lifetime", () => {
    expect(phaseMessages([phase("mixed", { writes: [{ id: "prior-context", lifetime: "transient" }, { id: "durable-artifact", lifetime: "durable", supersedes: [] }] })]))
      .toEqual(['Agent "mixed" mixes transient and durable write lifetimes']);
    expect(phaseMessages([phase("durable", { writes: [{ id: "implementation", lifetime: "durable", supersedes: [] }, { id: "verification", lifetime: "durable", supersedes: [] }] })])).toEqual([]);
  });

  // A skill's dependencies compose into its prompt with no model in the loop,
  // so an uninstalled dependency is a definition error of the installed set,
  // whether or not an agent depends on the package.
  it("rejects a skill whose dependency closure cannot be composed", () => {
    const skills = testSkillRevision([testSkill("plan", { dependencies: ["missing"] }), testSkill("installed")]);

    expect(messages(new Map(), skills)).toEqual(['Skill "plan" requires skill "missing", which is not installed']);
    expect(describeClosureFailure(["missing"], skills, 'Skill "plan"')).toBe('Skill "plan" requires skill "missing", which is not installed');
    expect(describeClosureFailure(["installed"], skills, 'Skill "plan"')).toBeUndefined();
  });

  it("bounds the declared guardrails block at decode", () => {
    const decode = (guardrails: AuthoredObject) => Schema.decodeUnknownSync(WorkflowDefinitionSchema, { onExcessProperty: "error" })({
      id: "wf",
      name: "Workflow",
      guardrails,
      phases: [phase("work")],
    });

    expect(decode({ max_attempts: 200, max_inserts: 120 })).toMatchObject({
      guardrails: { max_attempts: 200, max_inserts: 120 },
    });
    expect(() => decode({ max_attempts: 0 })).toThrow();
    expect(decode({ max_attempts: 4096 })).toMatchObject({ guardrails: { max_attempts: 4096 } });
    expect(() => decode({ max_attempts: 4097 })).toThrow();
    expect(() => decode({ max_mutations_per_attempt: 11 })).toThrow();
    expect(() => decode({ max_inserts: -1 })).toThrow();
    expect(() => decode({ unknown_cap: 5 })).toThrow();
  });

  it("allows repeated writers with one canonical contract and rejects inconsistent ones", () => {
    const writer = (id: string, lifetime: "durable" | "transient") => phase(id, {
      writes: lifetime === "durable" ? [{ id: "implementation", lifetime, supersedes: [] }] : [{ id: "implementation", lifetime }],
    });

    expect(phaseMessages([writer("one", "durable"), writer("two", "durable")])).toEqual([]);
    expect(phaseMessages([writer("one", "durable"), writer("two", "transient")])).toEqual(['Agent "two" declares artifact "implementation" inconsistently with "one"']);
  });

  it("rejects reserved, unknown, and non-durable supersession targets", () => {
    const found = phaseMessages([
      phase("plan", { writes: [{ id: "plan", lifetime: "transient" }] }),
      phase("review", { writes: [{ id: "reviewed-plan", lifetime: "durable", supersedes: ["plan", "missing", "user-request"] }] }),
      phase("reserved", { writes: [{ id: "user-request", lifetime: "transient" }] }),
    ]);

    expect(found).toContain('Agent "reserved" writes reserved artifact "user-request"');
    expect(found).toContain('Artifact "reviewed-plan" supersedes reserved artifact "user-request"');
    expect(found).toContain('Agent "review" writes.0.supersedes: Artifact "reviewed-plan" supersedes unknown artifact "missing"; remove the target or declare the intended durable artifact');
    expect(found).toContain('Agent "review" writes.0.supersedes: Artifact "reviewed-plan" supersedes non-durable artifact "plan"; remove the target or declare the intended durable artifact');
  });

  it("rejects duplicate and self supersession targets at decode, and a cycle across agents", () => {
    for (const supersedes of [["b", "b"], ["a"]]) {
      expect(() => workflowSet({ phases: [phase("a", { writes: [{ id: "a", lifetime: "durable", supersedes }] })] })).toThrow();
    }
    expect(phaseMessages([
      phase("a", { writes: [{ id: "a", lifetime: "durable", supersedes: ["b"] }] }),
      phase("b", { writes: [{ id: "b", lifetime: "durable", supersedes: ["a"] }] }),
    ]).some((message) => message.includes("supersession cycle"))).toBe(true);
  });
});

describe("validateDefinitionSet - phase keys", () => {
  it("puts a join only where it folds the outputs of several agents", () => {
    expect(phaseMessages([phase("plan", { join: { reducer: "collect", with: {} } })])).toEqual([
      'Workflow "wf": Phase "plan" join stands on a phase of one agent; a join folds the outputs of a phase\'s agents',
    ]);
    expect(phaseMessages([phase("plan", fields({ milestones })), phase("each", { over: "plan.milestones", join: { reducer: "nope" } })])).toEqual([
      'Workflow "wf": Phase "each" join names unknown reducer "nope"',
    ]);
  });

  it("gives the named agents of a phase its writes, and refuses runs beside brief", () => {
    const agents = (...ids: readonly string[]) => ids.map((agent) => ({ agent, brief: `Do the ${agent} work.` }))
    const gateOut = [{ id: "gate-out", lifetime: "durable", supersedes: [] }] as const;
    const workflows = workflowSet({ phases: [{ phase: "gates", agents: [...agents("lint"), "tsc"], brief: "Check.", writes: gateOut }] });
    expect(messages(workflows)).toEqual([]);
    const resolved = resolveWorkflowAgents([...workflows.values()][0]!);
    expect([...resolved.values()].map(({ definitionId, writes }) => [definitionId, writes])).toEqual([["lint", gateOut], ["tsc", gateOut]]);
    expect(phaseMessages([
      { phase: "both", runs: "nothing-here", brief: "Inline.", agents: ["one", "two"] },
    ])).toEqual([
      'Workflow "wf": Phase "both" runs stands beside brief; a record runs a named brief or states its own, not both',
    ]);
  });

  it("puts label and votes only on a phase over a list", () => {
    expect(phaseMessages([phase("plan", { label: "title" })])).toEqual([
      'Workflow "wf": Phase "plan" label stands on a phase that is not over a list; label names the agent of each item of a phase over a list',
    ]);
    expect(phaseMessages([phase("plan", { votes: 3 })])).toEqual([
      'Workflow "wf": Phase "plan" votes stands on a phase that is not over a list; votes multiplies the agents of each item',
    ]);
  });

  it("gates if only on a declared field whose value can be empty", () => {
    expect(phaseMessages([
      phase("review", fields({ done: flag, findings: items, notes: { ...flag, nullable: true } })),
      phase("a", { if: "review.done" }),
      phase("b", { if: "review.findings" }),
      phase("c", { if: "review.notes" }),
      phase("d", { if: "review.missing" }),
      phase("e", { if: "review.summary" }),
    ])).toEqual([
      'Workflow "wf": Phase "a" if "review.done" names "done" of "review", a boolean, which is never empty; name a string, list, path, object, variant, or nullable field',
      'Workflow "wf": Phase "d" if "review.missing" names undeclared output field "missing" of "review"',
      'Workflow "wf": Phase "e" if "review.summary" names undeclared output field "summary" of "review"',
    ]);
  });

  it("accepts a model and an effort in a workflow file that a chat launches by path", () => {
    const keyed = { phases: [phase("work", { model: "mid", effort: "low" }), phase("plain")] };
    const layered = (layer: "project" | "session") => new Map([...workflowSet(keyed)].map(([id, workflow]) => [id, { ...workflow, provenance: { layer, filePath: `workflows/${id}.yaml`, id } }]));

    expect(messages(layered("session"))).toEqual([]);
  });
});

describe("validateDefinitionSet - repeats while a field holds a value", () => {
  const loop = (on: string, review: AuthoredObject = fields({ findings: items, score: { type: "number", description: "A score." } })) =>
    phaseMessages([{ repeat: { while: on, max: 5 }, phases: [phase("review", review), phase("fix")] }]);

  it("accepts a repeat whose evaluator is any of its own phases", () => {
    expect(loop("review.findings")).toEqual([]);
    expect(phaseMessages([{ repeat: { while: "fix.findings", max: 3 }, phases: [phase("review"), phase("fix", fields({ findings: items }))] }])).toEqual([]);
  });

  it("rejects a malformed reference, an undeclared or never-empty field, and an evaluator outside the repeat", () => {
    expect(loop("review")).toEqual(['Workflow "wf": Repeat 1 while Malformed field reference "review": expected "<phase>.<field>"']);
    expect(loop("review.missing")).toEqual(['Workflow "wf": Repeat 1 while "review.missing" names undeclared output field "missing" of "review"']);
    expect(loop("review.score")).toEqual([
      'Workflow "wf": Repeat 1 while "review.score" names "score" of "review", a number, which is never empty; name a string, list, path, object, variant, or nullable field',
    ]);
    expect(phaseMessages([phase("other", fields({ findings: items })), { repeat: { while: "other.findings", max: 3 }, phases: [phase("review", fields({ findings: items })), phase("fix")] }])).toEqual([
      'Workflow "wf": Repeat 2 while names "other", which is not a phase of the repeat\'s own phases',
    ]);
  });

  it("bounds max at decode", () => {
    expect(() => workflowSet({ phases: [{ repeat: { while: "review.findings" }, phases: [phase("review")] }] })).toThrow();
    expect(() => workflowSet({ phases: [{ repeat: { while: "review.findings", max: 11 }, phases: [phase("review")] }] })).toThrow();
  });
});

describe("validateDefinitionSet - repeats over each item", () => {
  const each = (list: AuthoredObject, repeat: AuthoredObject = {}, body: readonly unknown[] = [phase("work")]) =>
    phaseMessages([phase("plan", fields({ milestones: list, notes: text })), { repeat: { each: "plan.milestones", ...repeat }, phases: body }]);

  it("accepts a repeat over a declared list with a max and a unique key", () => {
    expect(each(milestones)).toEqual([]);
  });

  it.each(["optional", "nullable"])("refuses a %s source list", (key) => {
    expect(each({ ...milestones, [key]: true })).toEqual([
      'Workflow "wf": Repeat 2 each reads "plan.milestones", which must be a required, non-nullable list; remove optional and nullable from the source field',
    ]);
  });

  it("rejects an unknown source, a field that is not a list, and an undeclared field", () => {
    expect(phaseMessages([{ repeat: { each: "missing.milestones" }, phases: [phase("work")] }])).toEqual([
      'Workflow "wf": Repeat 1 each names "missing", which is no phase or agent of this workflow',
    ]);
    for (const field of ["notes", "missing"]) {
      expect(phaseMessages([phase("plan", fields({ notes: text })), { repeat: { each: `plan.${field}` }, phases: [phase("work")] }])).toEqual([
        `Workflow "wf": Repeat 2 each reads "plan.${field}", which is not a declared list field`,
      ]);
    }
  });

  it("requires a reassess source of objects with a required string id and unique: id", () => {
    const reassessError = 'Workflow "wf": Repeat 2 each "plan.milestones" feeds a reassess phase, so each item must be an object with a required string "id" and the list must declare unique: id';
    const reassessed = (list: AuthoredObject) => each(list, { reassess: "reassess" }, [phase("work"), phase("reassess")]);

    expect(reassessed(milestones)).toEqual([]);
    expect(reassessed({ ...milestones, unique: "goal" })).toEqual([reassessError]);
    expect(reassessed({ ...items, max: 3 })).toContain(reassessError);
  });

  it("runs the reassess phase last in each round", () => {
    const lastError = (name: string) => `Workflow "wf": Repeat 2 reassess names "${name}", which is not the last phase of the repeat; the reassess phase runs last in each round`;
    expect(each(milestones, { reassess: "absent" })).toEqual([lastError("absent")]);
    expect(each(milestones, { reassess: "reassess" }, [phase("reassess"), phase("work")])).toEqual([lastError("reassess")]);
  });
});

