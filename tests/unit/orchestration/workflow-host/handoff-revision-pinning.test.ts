import { describe, expect, it } from "bun:test";
import { handoffToolSchemaFromOutput } from "../../../../src/orchestration/workflow-host/handoff-tool-schema.js";
import { assembleAgentPrompt } from "../../../../src/workflows/context-bundle/prompt-assembly.js";
import type { AttemptRow } from "../../../../src/workflows/view/types.js";
import { testResolvedAgent, testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js";

const skill = testSkill("pinned-worker", { body: "Perform pinned work." });
const skills = testSkillRevision([skill]);
const step: AttemptRow = {
  id: "step",
  definitionId: "work",
  briefId: skill.id,
  workflowDefinitionId: "workflow",
  name: "Work",
  status: "pending",
  writes: [],
  resumeRevertCount: 0,
};

function resolvedAt(label: string) {
  return testResolvedAgent("work", skill, {
    output: {
      summary: `${label} summary guidance`,
      fields: { [`only_${label.toLowerCase()}`]: { type: "string", description: `${label} field guidance` } },
    },
  });
}

describe("workflow output pinning", () => {
  it("builds the prompt and the handoff tool from the one output the agent resolved", async () => {
    const resolvedA = resolvedAt("A");
    resolvedAt("B");
    const tool = handoffToolSchemaFromOutput(resolvedA.output);

    const prompt = assembleAgentPrompt({
      capabilities: () => true,
      attempt: step,
      agent: resolvedA,
      contextBundle: "",
      skills,
    });

    expect(prompt.task).toContain("A field guidance");
    expect(prompt.task).not.toContain("B field guidance");
    expect(tool.input.properties).toHaveProperty("only_a");
    expect(tool.input.properties).not.toHaveProperty("only_b");
    const context = { executionCwd: "/scratch/work" };
    expect(await tool.accept?.({ summary: "done", only_a: "proof" }, context)).toEqual({ ok: true, payload: { summary: "done", only_a: "proof" }, repairs: [], notes: [] });
    expect((await tool.accept?.({ summary: "done", only_b: "changed" }, context))?.ok).toBe(false);
  });
});
