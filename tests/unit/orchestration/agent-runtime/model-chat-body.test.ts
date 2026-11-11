import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSystemPrompt as buildSystemPromptTiers, type BuildSystemPromptOptions, type ToolPromptFields } from "../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { resolveModelInteractionProfile } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { loadEngineeringDoctrine, loadSystemPrompt } from "../../../../src/infra/agent-assets/system-prompt.js";
import { testDirectories } from "../../../helpers/directories.js";
import { promptOptions } from "../../../helpers/prompt-capabilities.js";

const spec = (name: string, opts: Partial<ToolPromptFields> = {}): ToolPromptFields => ({ action: "ui_meta", description: `${name} tool`, ...opts, name });
const TOOLS: ToolPromptFields[] = [spec("bash"), spec("read")];
const CORE_SECTIONS = ["CONSTRAINTS:"];
const DOCTRINE_SECTIONS = ["WRITING:", "ELEGANCE:"];
const agentsMd = "Always use Bun, not Node.";
const promptRealmRoot = mkdtempSync(join(tmpdir(), "model-chat-body-realm-"));
afterAll(() => rmSync(promptRealmRoot, { recursive: true, force: true }));
const promptRealm = testDirectories(promptRealmRoot);
const corePrompt = loadSystemPrompt(promptRealm);
const engineeringDoctrine = loadEngineeringDoctrine(promptRealm);
const buildSystemPrompt = (options: BuildSystemPromptOptions): string => renderSystemPrompt(buildSystemPromptTiers(options));
/** The interactive chat prompt of `model`, with its guidance as the request planner resolves it. */
const build = (model: string, overrides: Partial<Parameters<typeof promptOptions>[0]> = {}): string => {
  const chatGuidance = resolveModelInteractionProfile(model, "anthropic").chatGuidance;
  return buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, promptKind: "chat", chatHost: { communication: true }, ...(chatGuidance ? { chatGuidance } : {}), ...overrides }));
};

/** One phrase that marks each guidance block in a rendered body. */
const BLOCK_MARKERS = {
  progress: "Open with one line on what you will do",
  scope: "# Scope",
  "final-message": "# The final message",
  finishing: "# Finishing the work",
  initiative: "# Initiative",
  "original-work": "build an original game",
  "model-limits": "speed up AI development",
  "shell-optional": "The `bash` tool is a good route",
  "shell-first": "Use the `bash` tool for every job it can do",
} as const;

/** The guidance blocks that `body` holds, in the order it renders them. */
function blocksOf(body: string): string[] {
  return Object.entries(BLOCK_MARKERS)
    .filter(([, marker]) => body.includes(marker))
    .sort(([, a], [, b]) => body.indexOf(a) - body.indexOf(b))
    .map(([block]) => block);
}

/** The model chat body is the tuned interactive prompt that replaces the general chat blocks. */
describe("model chat body", () => {
  it("replaces the general chat blocks with the model chat body and keeps every other part", () => {
    const tools = [...TOOLS, spec("skill"), spec("ask_user"), spec("subagent"), spec("edit", { action: "file_edit" })];
    const general = build("claude-sonnet-4", { tools, engineeringDoctrine, agentsMd, skills: ["code-review"] });
    const tuned = build("claude-opus-5.5", { tools, engineeringDoctrine, agentsMd, skills: ["code-review"] });

    expect(tuned).toStartWith("You are Flywheel's chat agent.");
    for (const kept of DOCTRINE_SECTIONS) expect(tuned).toContain(kept);
    for (const replaced of [...CORE_SECTIONS, "PROPORTIONALITY:", "CONVERSATION-FIRST DELIVERY:", "CHAT CHANGE REVIEW:", "COMMUNICATION:"]) {
      expect(general).toContain(replaced);
      expect(tuned).not.toContain(replaced);
    }
    for (const commitment of ["**Chat leads a change through delivery.**", "load the `code-review` skill", "the skill alone sizes the review to the change", "**Orchestration pays for itself.**", "**User messages come first.**", "**One coherent change at a time.**", "no change is needed is a successful result", "Understand the code before you change it", "Do only what the request needs, and still finish it", "Never test a copy of production code", "Never recommend that the user accept a narrowed draft", "rests on a spike that tested it", "end your reply with three things", "and what that proof does not cover", "A pull request description gives the same three things", "Do not stop before publication to ask for a shape review", "explaining the code first; a question that needs only an explanation ends there", "A local objection gets a fix, verified and published to the same change, and an objection to the structure starts a reshape", "never send the user to read a file", "restate their model, name the exact premise where you differ", "Where it is silent, follow how the codebase, tool, or library in use does the same job"]) {
      expect(tuned).toContain(commitment);
    }
    expect(tuned).not.toContain("trivial edits");
    expect(tuned).toContain("Guidelines:");
    expect(tuned).toContain(`# AGENTS.md Instructions\n\n${agentsMd}`);
  });

  it("states only the commitments that the request surface can honor", () => {
    const tuned = build("claude-sonnet-5.5");
    expect(tuned).not.toContain("**Chat leads a change through delivery.**");
    expect(tuned).not.toContain("end your reply with three things");
    expect(tuned).not.toContain("**Orchestration pays for itself.**");
    expect(tuned).toContain("review it yourself against the intent");
    expect(tuned).toContain("number them and state the one you recommend");
    // No skill, memory, workflow, or subagent tool: the body names none of them and keeps each method.
    for (const absent of ["`design` skill", "memory", "subagent", "workflow", "the recorded history"]) expect(tuned).not.toContain(absent);
    expect(tuned).toContain("restate their model, name the exact premise where you differ");
    expect(tuned).toContain("run it in the scratchpad before you design on the claim");
    const noShell = build("claude-sonnet-5.5", { tools: [spec("read")] });
    expect(noShell).toContain("settle that with the tools you have, or report it as an unverified assumption");
    expect(noShell).not.toContain("probe");
    // Workflows alone: the orchestration commitment names only the workflow route.
    const workflows = build("claude-sonnet-5.5", { tools: [...TOOLS, spec("workflow"), spec("ask_user")] });
    expect(workflows).toContain("**Orchestration pays for itself.** Add a reviewer or start a workflow only on a named trigger");
    expect(workflows).toContain("**Chat leads a change through delivery.**");
  });

  it("adds each model's guidance blocks in its order, a later family version inheriting the newest earlier entry", () => {
    const withFileTools = [...TOOLS, spec("edit"), spec("write")];
    const expected: readonly (readonly [model: string, blocks: readonly string[]])[] = [
      ["claude-opus-5.5", ["original-work", "shell-optional"]],
      ["claude-sonnet-5.5", []],
      ["claude-fable-5.1", ["progress", "scope", "final-message", "finishing", "shell-first"]],
      ["claude-fable-5.2", ["finishing", "original-work", "model-limits"]],
      ["claude-fable-5.3", ["finishing", "original-work", "model-limits"]],
      ["claude-haiku-5.5", ["scope", "finishing", "initiative"]],
    ];
    for (const [model, blocks] of expected) {
      const body = build(model, { tools: withFileTools });
      expect(body).toStartWith("You are Flywheel's chat agent.");
      expect(blocksOf(body)).toEqual([...blocks]);
      for (const shared of ["# This session", "# Acting", "they/them", "you resume from your session notes. Never"]) expect(body).toContain(shared);
      expect(body).not.toContain("\u2014");
    }
    // Moving the blocked-part rule from scope to finishing keeps it once in a body that has both.
    expect(build("claude-fable-5.1").split("If one part is truly blocked").length).toBe(2);
    expect(build("claude-opus-5.5", { tools: [...TOOLS, spec("recall")] })).toContain("session notes and the recorded history");
  });

  it("renders a shell note only with a shell, naming only the file tools that the request has", () => {
    const shellNote = (body: string): string | undefined => body.split("\n\n").find((paragraph) => paragraph.startsWith("The `bash` tool") || paragraph.startsWith("Use the `bash` tool"));
    expect(shellNote(build("claude-opus-5.5"))).not.toContain("when a shell edit is fragile");
    expect(shellNote(build("claude-opus-5.5", { tools: [...TOOLS, spec("edit"), spec("write")] }))).toContain("Use `edit` or `write` when a shell edit is fragile");
    expect(shellNote(build("claude-fable-5.1"))).toContain("Use `read` only when bash cannot do the job");
    expect(shellNote(build("claude-fable-5.1", { tools: [...TOOLS, spec("edit"), spec("write")] }))).toContain("Use `read`, `edit`, or `write` only when bash cannot do the job");
    const noBash = TOOLS.filter((tool) => tool.name !== "bash");
    for (const model of ["claude-opus-5.5", "claude-fable-5.1"]) expect(shellNote(build(model, { tools: noBash }))).toBeUndefined();
  });

  it("keeps the general prompt outside interactive chat even for a model with guidance", () => {
    for (const model of ["claude-opus-5.5", "claude-haiku-5.5"]) {
      const chatGuidance = resolveModelInteractionProfile(model, "anthropic").chatGuidance;
      expect(chatGuidance).toBeDefined();
      const subagent = buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, promptKind: "subagent", ...(chatGuidance ? { chatGuidance } : {}) }));
      expect(subagent).toBe(buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, promptKind: "subagent" })));
    }
  });
});
