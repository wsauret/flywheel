import { describe, expect, it } from "bun:test";
import { compileWorkflowControl } from "../../../../../src/workflows/vm/compile/compile.js";
import { completedBefore } from "../../../../../src/workflows/vm/graph/completion-order.js";
import { resolveWorkflowAgents } from "../../../../../src/workflows/definitions/agent-resolution.js";
import { testSkillRevision } from "../../../../helpers/skill-fixtures.js";
import { loadedWorkflow } from "../../../../helpers/workflow-files.js";

const skills = testSkillRevision([]);
const record = (id: string, extra: { readonly [key: string]: unknown } = {}) => ({ brief: `Do the ${id} work.`, name: id, ...extra });
const findings = { type: "list", description: "The findings.", max: 2, unique: "id", of: { type: "object", fields: { id: { type: "string", description: "The id." } } } };

/** A graph of named agents, a repeat, and a phase after them. */
function treeGraph() {
  const workflow = loadedWorkflow({
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
  // The ids name each node by its position: node 1 holds the named agents,
  // node 2 is the repeat with the two phases of its first round, and node 3
  // is the last phase.
  it.each([
    ["the named agents of the first phase, which run side by side", "tree:node:1:node:2", []],
    ["a phase of the repeat, after the whole first phase", "tree:node:2:round:1:node:1", ["tree:node:1", "tree:node:1:node:1", "tree:node:1:node:2"]],
    ["the later phase of one round, after the earlier one", "tree:node:2:round:1:node:2", ["tree:node:1", "tree:node:1:node:1", "tree:node:1:node:2", "tree:node:2:round:1:node:1"]],
    ["the last phase, after the repeat and every phase it holds", "tree:node:3", ["tree:node:1", "tree:node:1:node:1", "tree:node:1:node:2", "tree:node:2", "tree:node:2:round:1:node:1", "tree:node:2:round:1:node:2"]],
  ])("names the nodes that complete before %s", (_name, targetId, before) => {
    expect([...completedBefore(treeGraph(), targetId)].sort()).toEqual(before);
  });
});
