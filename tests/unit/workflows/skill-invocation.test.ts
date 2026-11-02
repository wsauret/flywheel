import { describe, it, expect } from "bun:test";
import { getPersonaMetadataIndex } from "../../../src/workflows/agents/agent-roles.js";
import { assembleSkillInvocation } from "../../../src/workflows/skill-invocation.js";
import { renderSkillContext } from "../../../src/workflows/skill-context.js";
import type { SkillDefinition } from "../../../src/workflows/skill-schema.js";
import { repoDefinitions } from "../../helpers/project-definitions.js";
import { testSkill, testSkillRevision } from "../../helpers/skill-fixtures.js";

const personaIndex = getPersonaMetadataIndex();
const skills = repoDefinitions().skills();

function installed(id: string): SkillDefinition {
  const skill = skills.skills.get(id);
  if (!skill) throw new Error(`skill package not installed: ${id}`);
  return skill;
}

function invoke(skill: SkillDefinition, args?: string): string {
  return assembleSkillInvocation(skill, args, { skills, personaIndex });
}

describe("assembleSkillInvocation", () => {
  it("renders the canonical context of the package, dependencies first", () => {
    const dependency = testSkill("dependency", { body: "Dependency procedure." });
    const consumer = testSkill("consumer", { body: "Consumer procedure.", dependencies: ["dependency"] });
    const revision = testSkillRevision([dependency, consumer]);

    const prompt = assembleSkillInvocation(consumer, undefined, { skills: revision, personaIndex });

    expect(prompt).toBe(`${renderSkillContext(dependency)}\n\n${renderSkillContext(consumer)}`);
  });

  it("expands {{ref:reviewer-protocol}} with elegance-governed code-review synthesis", () => {
    const prompt = invoke(installed("code-review"));

    expect(prompt).toContain("Reviewer Protocol");
    expect(prompt).toContain("Never union reviewer fixes or count reviewer agreement");
    expect(prompt).toContain("## Remedy arbitration");
    expect(prompt).toContain("Do not union reviewer fixes or count votes");
    expect(prompt).not.toContain("{{ref:");
  });

  it("dispatches reviewers in parallel until an observed stream stall", () => {
    const prompt = invoke(installed("code-review"));

    expect(prompt).toContain("Default: dispatch every chosen reviewer in parallel");
    expect(prompt).toContain("If the runtime continuation says the previous response stalled");
    expect(prompt).toContain("one remaining reviewer per parent turn");
    expect(prompt).toContain("do not split a healthy dispatch in advance");
  });

  it("renders a persona roster grouped by role with subagent-tool dispatch wording", () => {
    const prompt = invoke(installed("code-review"));

    expect(prompt).toContain("## Available Agents");
    expect(prompt).toContain("`subagent` tool");
    expect(prompt).toContain("reviewer-code-quality");
    expect(prompt).toContain("reviewer-code-elegance");
    // Grouped per role: each roster line is "**<role>:** persona, persona".
    expect(prompt).toMatch(/\*\*[\w-]+:\*\* reviewer-/);
  });

  it("omits the persona roster for a package that declares no agents", () => {
    const prompt = invoke(installed("implementation"));

    expect(prompt).not.toContain("## Available Agents");
  });

  it("renders a package's direct-output contract as its direct result", () => {
    const custom = invoke(testSkill("custom", {
      body: "Do the fixture work.",
      directOutput: "Write the plan to docs/plans/<slug>.md and report the path.",
    }));

    expect(custom).toContain("## Direct Result");
    expect(custom).toContain("Write the plan to docs/plans/<slug>.md and report the path.");
    expect(invoke(installed("implementation"))).not.toContain("## Direct Result");
  });

  it("appends ARGUMENTS only when args are provided", () => {
    const skill = installed("implementation");
    const withArgs = invoke(skill, "focus on src/auth");
    const withoutArgs = invoke(skill);

    expect(withArgs).toBe(`${withoutArgs}\n\nARGUMENTS: focus on src/auth`);
    expect(withoutArgs).not.toContain("ARGUMENTS:");
  });
});
