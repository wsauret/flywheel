import { describe, expect, it } from "bun:test";
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js";
import { renderSubagentRoster, SUBAGENT_DESCRIPTION } from "../../../../../src/orchestration/modules/subagents/execution/prompts.js";

const PLAN_DESIGN_REVIEWER = {
  kind: "persona",
  name: "reviewer-plan-design",
  description: "Reviews interface design in implementation plans.",
  role: "reviewer-design",
  tools: ["read"],
  maxTurns: 60,
  systemPrompt: "Review the supplied plan.",
} satisfies AgentDefinition;

const SHIP = {
  kind: "persona",
  name: "ship",
  description: "Publishes a verified repository change.",
  role: "ship",
  tools: ["bash"],
  maxTurns: 30,
  systemPrompt: "Publish the supplied change.",
  allowFork: false,
} satisfies AgentDefinition;

/** What a dispatcher reads: the tool description and the roster its system prompt carries. */
function modelVisible(agents: ReadonlyMap<string, AgentDefinition>): string {
  return `${SUBAGENT_DESCRIPTION}\n\n${renderSubagentRoster(agents)}`;
}

describe("subagent prompt", () => {
  it("keeps dispatch selection explicit without examples or a second persona list", () => {
    const prompt = modelVisible(new Map([[PLAN_DESIGN_REVIEWER.name, PLAN_DESIGN_REVIEWER]]));

    expect(prompt).toContain("every dispatch MUST pass `persona` as the FIRST field");
    expect(prompt).toContain("Use a persona name from the Subagents catalog in your system prompt.");
    expect(prompt).not.toContain("<example>");
    expect(prompt.match(/reviewer-plan-design/g)).toHaveLength(1);
    expect(prompt).toContain("Rationale: explain why delegation is worthwhile (minimum 30 characters); follow the parameter guidance.");
  });

  it("keeps role capabilities in the roster without repeated use-case summaries", () => {
    const agents = new Map<string, AgentDefinition>([
      ["explorer", { ...PLAN_DESIGN_REVIEWER, name: "explorer", role: "explorer", description: "Read-only investigation." }],
      ["implementer", { ...PLAN_DESIGN_REVIEWER, name: "implementer", role: "implementer", description: "Implement a scoped change." }],
      ["general", { kind: "general", name: "general", description: "Inherit the parent model and instructions.", maxTurns: 100 }],
    ]);
    const prompt = modelVisible(agents);

    for (const agent of agents.values()) expect(prompt).toContain(agent.description);
    expect(prompt).toContain("Tools: read");
    expect(prompt).not.toContain("- Read-only investigation:");
    expect(prompt).not.toContain("- Implementation tasks:");
    expect(prompt).not.toContain("- Full-capability isolated work:");
    expect(prompt).toContain("approved checkpoint Design intent and Decisions");
    expect(prompt).toContain("do not copy its intent into the brief");
    expect(prompt).toContain("suite-level or project-wide gates are yours");
    expect(prompt).toContain("the parent keeps ownership of integrating and cleaning up that worktree");
    expect(prompt).not.toContain("worktree-lifecycle");
    expect(prompt).not.toContain('kind: "steer"');
    expect(prompt).toContain("message_session");
    expect(prompt).toContain("Steering a running child: use message_session to revise its instructions. You can also ask it a question that blocks your work, or answer a question that it asked you. The child replies only when you ask it a question.");
    // The subagent tool only dispatches; `process` controls a child.
    expect(prompt).not.toContain('kind: "resume"');
    expect(prompt).not.toContain('kind: "retry"');
    expect(prompt).toContain("process(action='interrupt')");
    expect(prompt).toContain("process(action='resume')");
    expect(prompt).toContain("A child that you or the runtime interrupted never blocks your handoff");
    expect(prompt).toContain("fork: true");
  });

  it("advertises target-specific design-reviewer personas without routing planning to them", () => {
    const prompt = modelVisible(new Map([[PLAN_DESIGN_REVIEWER.name, PLAN_DESIGN_REVIEWER]]));

    expect(prompt).toContain("- reviewer-plan-design (role: reviewer-design)");
    expect(prompt).not.toContain("Interface judgment: use a designer agent");
  });

  it("delegates Git work to Ship with files and intent instead of parent-side analysis", () => {
    const prompt = modelVisible(new Map([[SHIP.name, SHIP]]));

    expect(prompt).toContain("use the Ship agent");
    expect(prompt).toContain("Do not use fork");
    expect(prompt).toContain("files you changed");
    expect(prompt).toContain("user intent and implemented design");
    expect(prompt).toContain("Do not run Git analysis");
    expect(prompt).toContain("Do not send verification evidence");
    expect(prompt).toContain("For a PR, also send the shape guide that you wrote");
    expect(prompt).toContain("Ship puts it in the pull request description as written, without assessing it");
    expect(prompt).toContain("writes the commit message");
    expect(prompt).toContain("complete selected files, including concurrent edits");
    expect(prompt).toContain("Do not ask Ship to separate authorship, select hunks, or create isolation worktrees");
    expect(prompt).not.toContain("optional path constraints");
    expect(prompt).not.toContain("fresh verification evidence");
    expect(prompt).not.toContain("exact commit message or user-facing outcome");
  });
});
