import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js";
import { subtreeUsage, worstCaseAttempts } from "../../../../src/workflows/vm/structural-admission.js";
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js";
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js";
import { FINDINGS_FILES, mapSkills, VOTES_CHECKS, votesDefinition } from "./_map-fixtures.js";

describe("list votes compilation", () => {
  const compile = (checks: { readonly [key: string]: unknown } = {}) => {
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)(votesDefinition(checks));
    return compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills: mapSkills }, undefined, { files: FINDINGS_FILES });
  };

  it("pins the votes on the list, gives each item one verdict, and counts items times votes times phases in the worst case", () => {
    const control = compile();
    const checks = control.graph.nodes.find(({ id }) => id === VOTES_CHECKS);
    expect(checks).toMatchObject({ kind: "list", width: 6, votes: 3, reducer: { id: "quorum", params: { vote: "verdict", min_valid: 2, max_refuted: 1 } } });
    // One verdict per kept finding, keyed by the finding; the failed list
    // can name every vote of every item.
    const contract = checks?.kind === "list" ? checks.reducer.contract : {};
    expect(contract["passed"]).toMatchObject({ max: 6, unique: "key", of: { fields: { key: { type: "string" }, label: { type: "string" } } } });
    expect(contract["failed"]).toMatchObject({ max: 18 });
    // Three reviews at launch, 6 findings x 3 votes x 1 phase, and the report.
    expect(worstCaseAttempts(control)).toBe(3 + 6 * 3 + 1);
    expect(subtreeUsage(control.graph, VOTES_CHECKS, "worstCase")).toEqual({ nodes: 6 * 3 * 2, depth: 2 });
    // A retry runs again for every vote.
    expect(worstCaseAttempts(compile({ retry: { max: 2 } }))).toBe(3 + 6 * 3 * 2 + 1);
  });

  it.each([
    ["one vote", { votes: 1 }, /votes/],
    ["more than ten votes", { votes: 11 }, /votes/],
  ] as const)("refuses %s when it decodes the file", (_name, checks, message) => {
    expect(() => Schema.decodeUnknownSync(WorkflowDefinitionSchema)(votesDefinition(checks))).toThrow(message);
  });

  it.each([
    ["a join that counts no votes", { join: { reducer: "collect" } }, /Phase "checks" casts 3 votes for each item, but reducer "collect" counts no votes; join the phase with quorum, or remove votes/],
    ["a quorum that also groups by an item field", { join: { reducer: "quorum", with: { vote: "verdict", min_valid: 2, max_refuted: 1, group_by: "area" } } }, /join.with does not fit reducer "quorum@1": group_by "area" cannot join a phase with votes, which gives each item one verdict over its 3 votes; remove group_by/],
    ["a floor above the votes of each item", { join: { reducer: "quorum", with: { vote: "verdict", min_valid: 4, max_refuted: 1 } } }, /min_valid 4 is more than the 3 votes of each item, so no verdict could pass; lower min_valid or raise votes/],
  ] as const)("refuses %s", (_name, checks, message) => {
    expect(() => compile(checks)).toThrow(message);
  });

  it("expands a list with votes over the launch input into one item agent per vote of each item, with the vote in each item's key and label", () => {
    const [, labeled, report] = votesDefinition().phases;
    if (labeled === undefined) throw new Error("the votes fixture has no labeled phase");
    const checks = Object.fromEntries(Object.entries(labeled).filter(([key]) => key !== "label"));
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "ballots",
      name: "Ballots",
      input: { fields: { claims: { type: "list", description: "The claims.", of: { type: "string" } } } },
      phases: [
        { ...checks, phase: "votes", over: "input.claims", votes: 2, join: { reducer: "quorum", with: { vote: "verdict", min_valid: 1, max_refuted: 0 } } },
        report,
      ],
    });
    const file = { ...workflow, provenance: { layer: "session" as const, filePath: "/s/scratch/workflows/ballots.workflow.yaml", id: "ballots" } };
    const control = compileWorkflowControl(file, resolveWorkflowAgents(file), { skills: mapSkills }, undefined, { claims: ["x is null", "y leaks"] });
    const list = "ballots:node:1";
    // A list without a unique key names each item by its position, and each
    // vote adds its number to the position and to the item's label.
    expect(control.graph.nodes.filter(({ kind }) => kind === "item").map((node) => node.kind === "item" && [node.id, node.key, node.label, node.ordinal, node.item, node.vote])).toEqual([
      [`${list}:item:1`, "1#1", "x is null #1", 1, "x is null", { number: 1, itemKey: "1", itemLabel: "x is null" }],
      [`${list}:item:2`, "1#2", "x is null #2", 2, "x is null", { number: 2, itemKey: "1", itemLabel: "x is null" }],
      [`${list}:item:3`, "2#1", "y leaks #1", 3, "y leaks", { number: 1, itemKey: "2", itemLabel: "y leaks" }],
      [`${list}:item:4`, "2#2", "y leaks #2", 4, "y leaks", { number: 2, itemKey: "2", itemLabel: "y leaks" }],
    ]);
    expect(control.graph.joins).toEqual([{ kind: "collect_all", nodeId: list, requiredNodeIds: [1, 2, 3, 4].map((ordinal) => `${list}:item:${ordinal}`) }]);
    // Each item's agent carries the item alone as its item context.
    expect(control.attempts.filter(({ provenance }) => provenance._tag === "item").map(({ item }) => item)).toEqual(["x is null", "x is null", "y leaks", "y leaks"]);
    // Two items x 2 votes x 1 phase, and the report.
    expect(worstCaseAttempts(control)).toBe(5);
  });
});
