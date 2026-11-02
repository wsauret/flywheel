import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { referenceIssues } from "../../../src/workflows/phase-references.js";
import { canonicalAgentPolicy } from "../../../src/workflows/definition-records.js";
import { WorkflowDefinitionSchema } from "../../../src/workflows/workflow-schema.js";

const list = { type: "list", description: "The items.", max: 3, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The id." } } } };
const record = (id: string, extra: { readonly [key: string]: unknown } = {}) => ({ brief: `Do the ${id} work.`, name: id, ...extra });
const lister = (id: string, extra: { readonly [key: string]: unknown } = {}) => record(id, { output: { summary: "The items.", fields: { items: list } }, ...extra });

/** The reference issues of one workflow of `phases`. */
function issues(phases: readonly unknown[]): readonly string[] {
  return referenceIssues(Schema.decodeUnknownSync(WorkflowDefinitionSchema)({ id: "w", name: "W", phases }));
}

describe("phase references", () => {
  it("admits a read of a phase, a named agent, or a joined stream that finishes before the reader starts", () => {
    expect(issues([
      { phase: "plan", ...lister("plan") },
      { phase: "build", agents: [{ agent: "left", ...record("left") }, { agent: "right", ...record("right") }] },
      { phase: "each", over: "plan.items", ...record("each") },
      { phase: "check", over: "each", ...record("check"), join: { reducer: "collect" } },
      { phase: "tail", ...record("tail", { reads: ["plan", "build", "left", "check"] }) },
    ])).toEqual([]);
    // An agent of a stream reads what finished before the stream started.
    expect(issues([
      { phase: "plan", ...lister("plan") },
      { phase: "each", over: "plan.items", ...record("each", { reads: ["plan"] }) },
      { phase: "check", over: "each", ...record("check", { reads: ["plan"] }) },
    ])).toEqual([]);
  });

  it("names every refused read of every agent at once", () => {
    expect(issues([
      { phase: "work", ...record("work", { reads: ["missing", "review"] }) },
      { phase: "review", ...record("review", { reads: ["review"] }) },
    ])).toEqual([
      'Workflow "w": Phase "work" reads names "missing", which is no phase or agent of this workflow',
      'Workflow "w": Phase "work" reads names "review", which does not finish before this phase starts; phases run in order, so name an earlier phase or agent',
      'Workflow "w": Phase "review" reads names "review", which is its own output',
    ]);
  });

  it("refuses a read of a stream phase that is not its last and of an agent of the same phase", () => {
    expect(issues([
      { phase: "plan", ...lister("plan") },
      { phase: "each", over: "plan.items", ...record("each") },
      { phase: "check", over: "each", ...record("check") },
      { phase: "tail", ...record("tail", { reads: ["each"] }) },
    ])).toEqual([expect.stringContaining('reads names "each", a phase of a stream that is not its last, so no output holds all of its items; name the last phase of the stream, "check"')]);
    expect(issues([
      { phase: "build", agents: [{ agent: "left", ...record("left") }, { agent: "right", ...record("right", { reads: ["left"] }) }] },
      { phase: "tail", ...record("tail", { reads: ["build"] }) },
    ])).toEqual([
      expect.stringContaining('Agent "right" reads names "left", which does not finish before this phase starts'),
    ]);
    expect(issues([
      { phase: "build", agents: [{ agent: "left", ...lister("left") }, { agent: "right", ...lister("right") }] },
      { phase: "fix", if: "build.items", ...record("fix") },
      { phase: "tail", if: "build", ...record("tail") },
      { repeat: { while: "gates.items", max: 2 }, phases: [{ phase: "gates", agents: [{ agent: "lint", ...lister("lint") }, { agent: "tsc", ...lister("tsc") }] }] },
    ])).toEqual([]);
  });

  it("holds a stream phase to the phase directly before it, which must run over a list", () => {
    expect(issues([
      { phase: "plan", ...lister("plan") },
      { phase: "each", over: "plan.items", ...record("each") },
      { phase: "other", ...record("other") },
      { phase: "check", over: "each", if: "plan.items", votes: 2, ...record("check") },
    ])).toEqual([
      expect.stringContaining('Phase "check" over names "each", but a stream phase follows the phase directly before it; name "other"'),
      expect.stringContaining('Phase "check" if stands on a stream phase'),
      expect.stringContaining('Phase "check" votes stands on a stream phase'),
    ]);
    expect(issues([{ phase: "plan", ...lister("plan") }, { phase: "check", over: "plan", ...record("check") }]))
      .toEqual([expect.stringContaining('over names "plan", which is not a phase over a list; a stream phase follows a phase with over')]);
  });

  it("holds a repeat's while to its own phases, its each to an earlier phase, and its reassess to its last phase of one agent", () => {
    expect(issues([
      { phase: "plan", ...lister("plan") },
      { repeat: { while: "plan.items", max: 2 }, phases: [{ phase: "work", ...lister("work") }] },
      { repeat: { each: "fix.items", reassess: "work2" }, phases: [{ phase: "fix", ...lister("fix") }, { phase: "work2", ...record("work2") }, { phase: "last", ...record("last") }] },
      { phase: "tail", if: "work", ...record("tail") },
    ])).toEqual([
      expect.stringContaining('Phase "tail" if names "work", a phase inside a repeat, which a phase outside the repeat cannot test'),
      // A repeat is labeled by its place in the workflow's phases.
      expect.stringContaining('Repeat 2 while names "plan", which is not a phase of the repeat\'s own phases'),
      expect.stringContaining('Repeat 3 each names "fix", a phase of the repeat\'s own phases, which runs after the repeat reads its items; name an earlier phase'),
      expect.stringContaining('Repeat 3 reassess names "work2", which is not the last phase of the repeat'),
    ]);
  });
});

describe("agent policy records", () => {
  it("keeps the policy record of an agent without reads, so the hash of an existing definition is unchanged", () => {
    const keys = { name: "Work", writes: [] } as const;
    expect(canonicalAgentPolicy({ definitionId: "work", keys })).toEqual({ definitionId: "work", name: "Work", writes: [] });
    expect(canonicalAgentPolicy({ definitionId: "work", keys: { ...keys, reads: [] } })).toEqual({ definitionId: "work", name: "Work", writes: [], reads: [] });
    expect(canonicalAgentPolicy({ definitionId: "work", keys: { ...keys, reads: ["plan"] } })).toEqual({ definitionId: "work", name: "Work", writes: [], reads: ["plan"] });
    expect(() => Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "w", name: "W", phases: [{ phase: "work", ...record("work") }, { phase: "review", ...record("review", { reads: ["work", "work"] }) }],
    })).toThrow('reads names "work" more than once');
  });
});
