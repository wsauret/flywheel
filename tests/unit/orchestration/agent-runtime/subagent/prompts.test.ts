import { describe, expect, it } from "bun:test";
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js";
import { renderSubagentRoster } from "../../../../../src/orchestration/modules/subagents/execution/prompts.js";
import { subagentToolDefinition } from "../../../../../src/orchestration/modules/subagents/tool.js";

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
  tools: ["bash", "edit", "write"],
  maxTurns: 30,
  systemPrompt: "Publish the supplied change.",
  allowFork: false,
} satisfies AgentDefinition;

/** What a dispatcher reads: the tool description, its input schema, and the roster its system prompt carries. */
function modelVisible(agents: ReadonlyMap<string, AgentDefinition>, has: (term: string) => boolean = () => true, unattendedTree = false): string {
  const tool = subagentToolDefinition(has, unattendedTree);
  return `${tool.description}\n\n${JSON.stringify(tool.inputSchema)}\n\n${renderSubagentRoster(agents, has, unattendedTree)}`;
}

describe("subagent prompt", () => {
  it("keeps dispatch selection explicit without examples or a second persona list", () => {
    const prompt = modelVisible(new Map([[PLAN_DESIGN_REVIEWER.name, PLAN_DESIGN_REVIEWER]]));

    expect(prompt).toContain("Put first. One agent type from the Subagents catalog in your system prompt. If none fits, do the work directly.");
    expect(prompt).not.toContain("<example>");
    expect(prompt.match(/reviewer-plan-design/g)).toHaveLength(1);
    expect(prompt).toContain("One or two sentences: the question this dispatch answers, why its result should not fill your own context, and the alternatives you considered.");
  });

  it("keeps role capabilities in the roster without repeated use-case summaries", () => {
    const agents = new Map<string, AgentDefinition>([
      ["explorer", { ...PLAN_DESIGN_REVIEWER, name: "explorer", role: "explorer", description: "Read-only investigation." }],
      ["implementer", { ...PLAN_DESIGN_REVIEWER, name: "implementer", role: "implementer", description: "Implement a scoped change." }],
      ["general", { kind: "general", name: "general", description: "Inherit the parent model and instructions.", maxTurns: 100 }],
    ]);
    const prompt = modelVisible(agents);

    for (const agent of agents.values()) expect(prompt).toContain(agent.description);
    // A persona that can change no file carries the read-only mark (ARCH-TOOLS-011); the general agent carries none.
    expect(prompt).toContain("- explorer (read-only): Read-only investigation.");
    expect(prompt).toContain("- general: Inherit the parent model and instructions.");
    expect(prompt).not.toContain("Tools:");
    expect(prompt).not.toContain("- Read-only investigation:");
    expect(prompt).not.toContain("- Implementation tasks:");
    expect(prompt).not.toContain("- Full-capability isolated work:");
    expect(prompt).toContain("approved checkpoint Design intent and Decisions");
    expect(prompt).toContain("do not copy its intent into the brief");
    expect(prompt).toContain("suite-level or project-wide gates are yours");
    // The worktree rule that the dispatch and workflow tools share lives in the system prompt (ARCH-CONTEXT-035).
    expect(prompt).not.toContain("the parent keeps ownership of integrating and cleaning up that worktree");
    expect(prompt).not.toContain("worktree-lifecycle");
    expect(prompt).not.toContain('kind: "steer"');
    expect(prompt).toContain("message_session");
    expect(prompt).toContain("Steer a running child with message_session; it replies only to a question.");
    // The subagent tool only dispatches; `process` controls a child.
    expect(prompt).not.toContain('kind: "resume"');
    expect(prompt).not.toContain('kind: "retry"');
    expect(prompt).toContain("Check, interrupt, or resume it with process by its session_id.");
    expect(prompt).toContain("A child that you or the runtime interrupted never blocks your handoff");
    expect(prompt).toContain("Writing the prompt: unless you fork, the child has not seen your conversation.");
    expect(modelVisible(agents, (term) => term !== "type:general")).toContain("Writing the prompt: the child has not seen your conversation.");
  });

  it("advertises target-specific design-reviewer personas without routing planning to them", () => {
    const prompt = modelVisible(new Map([[PLAN_DESIGN_REVIEWER.name, PLAN_DESIGN_REVIEWER]]));

    expect(prompt).toContain("- reviewer-plan-design (read-only): Reviews interface design in implementation plans.");
    // Dispatch accepts only the name, and one role can cover several personas, so the role is never shown.
    expect(prompt).not.toContain("reviewer-design");
    expect(prompt).not.toContain("Interface judgment: use a designer agent");
  });

  it("promises no publication through Ship while Bash is off or the tree is unattended, and keeps Ship in the roster", () => {
    const agents = new Map([[SHIP.name, SHIP]]);
    const withoutBash = modelVisible(agents, (term) => term !== "bash");
    expect(withoutBash).toContain("- ship: Publishes a verified repository change.");
    expect(withoutBash).not.toContain("Repository publication");
    const unattended = modelVisible(agents, () => true, true);
    expect(unattended).toContain("- ship: Publishes a verified repository change.");
    expect(unattended).not.toContain("Repository publication");
    expect(modelVisible(agents)).toContain("- Repository publication: after you complete implementation, review, and verification, use the Ship agent.");
  });

  it("delegates Git work to Ship with files and intent instead of parent-side analysis", () => {
    const prompt = modelVisible(new Map([[SHIP.name, SHIP]]));

    expect(prompt).toContain("use the Ship agent");
    expect(prompt).toContain("files you changed, from your own tracked list");
    expect(prompt).toContain("user intent and implemented design");
    expect(prompt).toContain("Do not run Git analysis, prepare a commit message, or send verification evidence");
    expect(prompt).toContain("For a PR, also send what changed from the approved design, the proof that the change works, and what that proof does not cover");
    expect(prompt).toContain("Ship puts it in the pull request description as written, without assessing it");
    expect(prompt).toContain("do not ask Ship to verify, separate authorship, select hunks, or create isolation worktrees");
    expect(prompt).not.toContain("optional path constraints");
    expect(prompt).not.toContain("fresh verification evidence");
    expect(prompt).not.toContain("exact commit message or user-facing outcome");
  });
});
