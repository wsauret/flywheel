import { describe, expect, it } from "bun:test";
import { assembleAgentPrompt } from "../../../../src/workflows/context-bundle/prompt-assembly.js";
import type { AttemptRow } from "../../../../src/workflows/view/types.js";
import { testResolvedAgent, testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js";

const implementSkill = testSkill("fly.implement", { body: "You are an implementation agent." });
const skills = testSkillRevision([implementSkill]);
const resolvedStep = testResolvedAgent("implement", implementSkill, {
  output: { summary: "What was implemented.", fields: { decisions: { type: "list", of: { type: "string" }, description: "Material revisions of the plan." } } },
  writes: [{ id: "implementation", lifetime: "durable", supersedes: [] }],
});

const step: AttemptRow = {
  id: "step-1",
  definitionId: resolvedStep.definitionId,
  briefId: implementSkill.id,
  workflowDefinitionId: "test-wf",
  name: "Implement feature",
  status: "pending",
  description: "Implement safely.",
  writes: [],
  resumeRevertCount: 0,
};

describe("assembleAgentPrompt", () => {
  it("places one context bundle in the user prompt", () => {
    const contextBundle = "## User Request\n\nAdd user login\n\n## Inherited Artifacts\n\nreviewed plan";
    const result = assembleAgentPrompt({ capabilities: () => true, attempt: step, agent: resolvedStep, contextBundle, skills });
    expect(result.task).toContain("You are an implementation agent.");
    expect(result.task).not.toContain("Add user login");
    expect(result.userPrompt).toContain("## Brief\n\nImplement safely.");
    expect(result.userPrompt).toContain(contextBundle);
    expect(result.userPrompt.match(/## User Request/g)).toHaveLength(1);
  });

  it("assembles only the step's own layers, body first and output requirements last", () => {
    const result = assembleAgentPrompt({ capabilities: () => true, attempt: step, agent: resolvedStep, contextBundle: "", skills });
    expect(result.task.startsWith("You are an implementation agent.")).toBe(true);
    expect(result.task).not.toContain("blocks merge");
    expect(result.task.endsWith(resolvedStep.output.instructions(true))).toBe(true);
    expect(result.task).toContain("**decisions** (REQUIRED, list of string)");
  });

  it("ends with the postamble for an agent without bash when its check lacks bash", () => {
    const result = assembleAgentPrompt({ capabilities: (term) => term !== "bash", attempt: step, agent: resolvedStep, contextBundle: "", skills });
    expect(result.task.endsWith(resolvedStep.output.instructions(false))).toBe(true);
    expect(result.task).not.toContain("commands_run");
  });

  it("keeps for-item context before the pipeline bundle", () => {
    const forItem = { id: "phase-1", goal: "Implement core" };
    const result = assembleAgentPrompt({
      capabilities: () => true,
      attempt: { ...step, item: forItem },
      agent: resolvedStep,
      contextBundle: "## User Request\n\nBuild it",
      skills,
    });
    expect(result.userPrompt.indexOf("## For Item Context")).toBeLessThan(result.userPrompt.indexOf("## User Request"));
    expect(result.userPrompt).toContain(JSON.stringify(forItem, null, 2));
    expect(result.userPrompt).not.toContain("## Vote");

    // A lane of a map with votes states its vote after its item, so its
    // instructions can give each vote its own angle.
    const lane = assembleAgentPrompt({
      capabilities: () => true,
      attempt: { ...step, item: forItem },
      agent: resolvedStep,
      contextBundle: "## User Request\n\nBuild it",
      skills,
      vote: { number: 2, count: 3 },
    });
    expect(lane.userPrompt).toContain("## Vote\n\nYou cast vote 2 of 3 on the item in your item context.");
    expect(lane.userPrompt.indexOf("## For Item Context")).toBeLessThan(lane.userPrompt.indexOf("## Vote"));
    expect(lane.userPrompt.indexOf("## Vote")).toBeLessThan(lane.userPrompt.indexOf("## User Request"));
  });
});
