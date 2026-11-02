import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js";
import { completedBefore, completionOrder } from "../../../../src/workflows/vm/completion-order.js";
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js";
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js";
import { testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { mapSkills, mapWorkflow } from "./_map-fixtures.js";

const skills = testSkillRevision([]);
const record = (id: string, extra: { readonly [key: string]: unknown } = {}) => ({ brief: `Do the ${id} work.`, name: id, ...extra });
const findings = { type: "list", description: "The findings.", max: 2, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The id." } } } };

/** A graph of named agents, a repeat, and a phase after them. */
function treeGraph() {
  const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    id: "tree", name: "Tree",
    phases: [
      { phase: "first", agents: [{ agent: "work", ...record("work") }, { agent: "review", ...record("review") }] },
      { repeat: { while: "fix.findings", max: 2 }, phases: [{ phase: "again", ...record("again") }, { phase: "fix", ...record("fix", { output: { summary: "The fix.", fields: { findings } } }) }] },
      { phase: "last", ...record("last") },
    ],
  });
  return compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills }).graph;
}

describe("completion order", () => {
  it.each([
    ["named agents, a repeat, and a phase after them", treeGraph],
    ["a list with its stream and join", () => compileWorkflowControl(mapWorkflow, resolveWorkflowAgents(mapWorkflow), { skills: mapSkills }).graph],
  ])("answers each pair as the set of nodes that complete before the later one (%s)", (_name, graph) => {
    const compiled = graph();
    const completesBefore = completionOrder(compiled);
    for (const later of compiled.nodes) {
      const before = completedBefore(compiled, later.id);
      for (const earlier of compiled.nodes) expect(completesBefore(earlier.id, later.id)).toBe(before.has(earlier.id));
    }
  });
});
