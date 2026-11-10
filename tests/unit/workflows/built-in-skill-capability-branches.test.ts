import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSkillResource } from "../../../src/workflows/skill-context.js";
import { bodyFor, bundled } from "./_bundled-skills.js";

describe("capability branches of bundled skill packages", () => {
  it("offers each delivery route only to an agent that can take it", () => {
    const design = bundled.get("design");
    const subagentRoute = "   - a subagent;";
    const workflowRoute = "   - a workflow file that you write when later agents read earlier results, only when no open question remains and no milestone needs discovery, experiments, spikes, or proof-of-concept work.";

    const allOn = bodyFor(design);
    expect(allOn).toContain(`   - inline;\n${subagentRoute}\n${workflowRoute}\n`);
    const inlineOnly = bodyFor(design, ["subagent", "workflow"]);
    expect(inlineOnly).toContain("select exactly one implementation route:\n   - inline;\n\n   Use the lightest route");
    expect(inlineOnly).not.toContain("workflow file");
    expect(bodyFor(design, ["workflow"])).toContain(`   - inline;\n${subagentRoute}\n\n`);
  });

  it("keeps each capability-specific method branch for the agents that hold it", () => {
    const branches = [
      { id: "code-review", term: "workflow", text: "When you can launch a workflow file, run them as one workflow in the Review shape of `workflow-authoring`.", kept: "Dispatch every selected reviewer in parallel.\nUse self-contained prompts" },
      { id: "research", term: "workflow", text: "When you can launch a workflow file, run two or more facets as one workflow", kept: "This skill owns the research explorer dispatch" },
      { id: "research", term: "subagent", text: "This skill owns the research explorer dispatch", kept: "Prefer empirical evidence over static reasoning" },
      { id: "research", term: "subagent", text: "Dispatch one `explorer` per facet in its enumerative mode, all in one turn.", kept: "Research each facet this way: enumerate first" },
      { id: "worktree-lifecycle", term: "persona:ship", text: "dispatch `ship` once without forked history", kept: "publish the selected files yourself from the existing worktree" },
      { id: "research", term: "subagent", text: "Combine explorer findings into one picture", kept: "Combine the facet findings into one picture" },
      { id: "design", term: "subagent", text: "Also offer `Advisor review first`; on it, ask the Advisor whether the design and route need a material change.", kept: "ask the person to choose `Approve and continue` or `Revise design`, where `Revise design` takes their text.\nA text answer that rejects the approach" },
      { id: "implementation-planning", term: "bash", text: "Bound a slow command with the bash tool's timeout parameter.", kept: "never prefix the `timeout` shell utility, which is absent on macOS." },
      { id: "workflow-authoring", term: "subagent", text: "| `subagents` | Beside `brief`: the personas that the agent may dispatch as subagents, which composing a skill never grants", kept: "| `writes` |" },
    ];
    for (const branch of branches) {
      const skill = bundled.get(branch.id);
      expect(bodyFor(skill)).toContain(branch.text);
      const off = bodyFor(skill, [branch.term]);
      expect(off).not.toContain(branch.text);
      expect(off).not.toMatch(/\{\{(?:if:|else\}|end\})/);
      expect(off).toContain(branch.kept);
    }
  });

  it("names no explorer or Advisor to an agent that cannot call the subagent tool", () => {
    expect(bodyFor(bundled.get("research"), ["subagent", "workflow"])).not.toMatch(/explorer/i);
    expect(bodyFor(bundled.get("research"), ["subagent"])).not.toMatch(/explorer|subagent/i);
    expect(bodyFor(bundled.get("design"), ["subagent", "workflow"])).not.toContain("Advisor");
  });

  it("offers research facets through exactly the delegation routes the agent holds", () => {
    const research = bundled.get("research");
    const explorers = "Dispatch one `explorer` per facet";
    const workflow = "run two or more facets as one workflow instead of any other dispatch for them";
    const sequential = "Research the facets one at a time.";
    const routes = (off: readonly string[]) => {
      const body = bodyFor(research, off);
      return [explorers, workflow, sequential].filter((route) => body.includes(route));
    };
    // With both routes, the workflow paragraph takes precedence over the per-facet dispatch.
    expect(routes([])).toEqual([explorers, workflow]);
    expect(routes(["workflow"])).toEqual([explorers]);
    expect(routes(["subagent"])).toEqual([workflow]);
    expect(routes(["subagent", "workflow"])).toEqual([sequential]);
  });

  it("tells only an agent that can dispatch how workflow-authoring grants personas", () => {
    const skill = bundled.get("workflow-authoring");
    if (skill?.source.kind !== "filesystem") throw new Error("workflow-authoring loads from its bundle directory");
    const grant = "which composing a skill never grants and the skeletons under `references/` omit.";
    expect(bodyFor(skill)).toContain(grant);
    expect(bodyFor(skill, ["subagent"])).not.toMatch(/subagent/i);
    // References name the personas a phase may use and leave the key to the
    // conditioned body.
    const { canonicalDir } = skill.source;
    const references = skill.resources.filter(({ path }) => path.startsWith("references/"));
    expect(references.map(({ path }) => path)).toEqual(expect.arrayContaining(["references/implement-briefs.md", "references/review-briefs.md", "references/spec-briefs.md"]));
    for (const { path } of references) expect(readFileSync(join(canonicalDir, path), "utf8"), path).not.toMatch(/subagent/i);
  });

  // Every persona needs Subagents, and code-review dispatches reviewer personas,
  // so a launch from an agent without Subagents refuses a persona-bearing file.
  it("steers workflow-authoring to personas only for an agent that can run them", () => {
    const skill = bundled.get("workflow-authoring");
    if (skill?.source.kind !== "filesystem") throw new Error("workflow-authoring loads from its bundle directory");
    const personaSteering = ["runs as its reviewer persona", "| `persona` |", "examples/lens-review.workflow.yaml", "references/review-briefs.md", "references/implement-briefs.md", "references/spec-briefs.md"];
    const allOn = bodyFor(skill);
    for (const text of personaSteering) expect(allOn).toContain(text);
    // The model seat resolves the persona's settings before Workflow Agent.
    expect(allOn).toContain("they follow\npersona settings, then\nWorkflow Agent.");
    expect(allOn).toContain("`- { phase: review, agents: [quality, elegance], join: { reducer: dedupe, with: { items: findings, by: site } } }`");
    const off = bodyFor(skill, ["subagent", "skill:code-review"]);
    for (const text of [...personaSteering, "persona", "examples/build-review-loop.workflow.yaml", "`code-review`", "code-review]"]) expect(off, text).not.toContain(text);
    expect(off).toContain("`- { phase: review, agents: [quality, elegance], join: { reducer: dedupe, with: { items: findings, by: site } } }`");
    expect(off).toContain("`code-review-method` or `plan-review` with the principles skill of the lens that a review brief names");
    expect(off).toContain("they follow\nWorkflow Agent.");
    // A resource renders its markers for its reader, as the body does, so no marker reaches an agent.
    for (const { path } of skill.resources) expect(readSkillResource(skill, path, 0, Number.MAX_SAFE_INTEGER, () => true).content, path).not.toMatch(/^\s*\{\{(?:if:|else\}|end\})/m);
  });
});
