import { describe, expect, it } from "bun:test";
import {
  buildSystemPrompt as buildSystemPromptTiers,
  type ToolPromptFields,
} from "../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { loadEngineeringDoctrine, loadSystemPrompt } from "../../../../src/infra/agent-assets/system-prompt.js";
import { fileTemporaryDirectory, testDirectories } from "../../../helpers/directories.js";
import { promptOptions } from "../../../helpers/prompt-capabilities.js";

// The prompt of an agent of a workflow: the unattended block and the stable
// tier that every such agent shares. The assembler suite owns the prompt kinds
// that every runner shares; this suite owns what only an agent of a workflow gets.

interface UnknownRecord { [key: string]: unknown }

const agentsMd = "Always use Bun, not Node.";
const CORE_SECTIONS = ["CONSTRAINTS:"];
const promptRealm = testDirectories(fileTemporaryDirectory("workflow-agent-prompt-realm-"));
const corePrompt = loadSystemPrompt(promptRealm);
const engineeringDoctrine = loadEngineeringDoctrine(promptRealm);

function spec(name: string, opts: Partial<ToolPromptFields> = {}): ToolPromptFields {
  return { action: "ui_meta", description: `${name} tool`, ...opts, name };
}

const TOOLS: ToolPromptFields[] = [
  spec("bash", { description: "Run shell commands. Supports bash.", promptGuidelines: ["Always quote paths"], promptExamples: "bash ls -la" }),
  spec("read", { description: "Read files from disk. Requires path.", promptGuidelines: ["Use absolute paths"] }),
];

const buildSystemPrompt = (...args: Parameters<typeof buildSystemPromptTiers>): string =>
  renderSystemPrompt(buildSystemPromptTiers(...args));

describe("buildSystemPrompt -- agent of a workflow", () => {
  const build = (overrides: UnknownRecord = {}) =>
    buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, envBlock: undefined, promptKind: "workflow-agent", unattended: true, agentsMd, ...overrides }));

  it("contains core sections, tool guidelines, and agentsMd", () => {
    const result = build();
    for (const section of CORE_SECTIONS) expect(result).toContain(section);
    expect(result).not.toContain("PROPORTIONALITY:");
    expect(result).toContain("- Always quote paths");
    expect(result).toContain(`# AGENTS.md Instructions\n\n${agentsMd}`);
  });

  it("does not include chat-only review guidance", () => {
    const result = build({ tools: [...TOOLS, spec("subagent", { description: "Launch a specialized subagent." })] });

    expect(result).not.toContain("CHAT CHANGE REVIEW:");
  });

  // Only a root chat asks the person (PI-AGENT-024, PI-AGENT-082): an agent reaches its
  // parent, and the block names no question tool and no blocked handoff.
  it("tells the agent it runs unattended and that its channel is message_session to its parent", () => {
    const result = build({ tools: [...TOOLS, spec("message_session")] });
    for (const text of ["WORKING UNATTENDED:", "never pauses your work", "message your parent with message_session"]) expect(result).toContain(text);
    expect(result).not.toContain("ask_user");
    expect(result).not.toMatch(/blocked (handoff|outcome)/);
  });

  // A host without session messaging gives the agent no message_session, so
  // the block must not send it to a tool it lacks (PI-AGENT-024).
  it("tells an agent without message_session that no parent can answer, so it decides and states its assumptions", () => {
    const result = build();
    expect(result).toContain("WORKING UNATTENDED:");
    expect(result).toContain("No parent can answer during this run. When a choice needs the design, decide on your own judgment and state each assumption in your handoff.");
    expect(result).not.toContain("message_session");
    expect(build({ tools: [...TOOLS, spec("message_session")] })).not.toContain("No parent can answer");
  });

  it("renders the unattended block only from the unattended surface", () => {
    expect(build({ unattended: undefined })).not.toContain("WORKING UNATTENDED:");
  });
});

// Every agent of a workflow gets the same stable tier with the doctrine, so
// agents of different phases share one cached prefix; an agent's brief is its
// opening turn (ARCH-CONTEXT-018).
describe("buildSystemPrompt -- every agent of a workflow", () => {
  it("puts the doctrine in the stable tier", () => {
    const tiers = buildSystemPromptTiers(promptOptions({
      corePrompt, engineeringDoctrine, tools: TOOLS, promptKind: "workflow-agent", unattended: true, agentsMd,
      scratchDir: "/scratch", checkpointAvailable: true, selfDebug: true, envBlock: "<env>cwd</env>",
    }));
    // The bundled doctrine renders for the tree check: with a shell it keeps its commit procedure, and no marker remains.
    for (const section of ["WRITING:", "COMMITS:", "A repository-changing unit is complete only when", "ELEGANCE:"]) expect(tiers.stable).toContain(section);
    expect(tiers.stable).not.toContain("{{");
  });
});
