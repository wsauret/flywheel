import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSystemPromptParts, buildSystemPrompt as buildSystemPromptTiers, type BuildSystemPromptOptions, type ToolPromptFields } from "../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { resolveModelInteractionProfile } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import type { AgentPurpose } from "../../../../src/orchestration/agent-runtime/types.js";
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
/** The guidance of `model` as the request planner resolves it, served by its own vendor. */
const guidanceOf = (model: string): Pick<BuildSystemPromptOptions, "modelGuidance"> => {
  const modelGuidance = resolveModelInteractionProfile(model, model.startsWith("gpt-") ? "openai" : "anthropic").modelGuidance;
  return modelGuidance ? { modelGuidance } : {};
};
/** The interactive chat prompt of `model`, with its guidance as the request planner resolves it. */
const build = (model: string, overrides: Partial<Parameters<typeof promptOptions>[0]> = {}): string =>
  buildSystemPrompt(promptOptions({ corePrompt, tools: TOOLS, promptKind: "chat", chatHost: { communication: true }, ...guidanceOf(model), ...overrides }));

/** One phrase that marks each guidance block in a rendered body. */
const BLOCK_MARKERS = {
  progress: "Give short updates while you work",
  scope: "# Scope",
  "final-message": "# The final message",
  finishing: "# Finishing the work",
  initiative: "# Initiative",
  ambiguity: "# Ambiguity",
  authorization: "# Authorization",
  "plain-writing": "# Plain writing",
  corrections: "# Corrections",
  "quiet-caveats": "# Caveats",
  "model-limits": "speed up AI development",
  "shell-optional": "The `bash` tool is a good route",
  "shell-first": "Use the `bash` tool for every job it can do",
} as const;

/** One phrase that marks each base rule, which the model chat body and the general chat prompt both state once. */
const BASE_MARKERS = [
  "Do not work them out again, and do not reopen them",
  "When you compare options, finish with the one that you recommend",
  "report the action that was refused, what refused it, and the reason that it gave",
  "Ask for permission only where a capable colleague would ask",
  "A draft pull request, a separate worktree, and the resolution of a merge conflict are such preparation",
  "A permission covers that kind of step for the rest of the task",
  "Name the real risks and limits that remain",
  "It replaces that goal only when the user cancels it or asks for work that cannot go with it",
] as const;

const occurrences = (text: string, phrase: string): number => text.split(phrase).length - 1;

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
    for (const rule of BASE_MARKERS) {
      expect(occurrences(tuned, rule)).toBe(1);
      expect(occurrences(general, rule)).toBe(1);
    }
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
    expect(tuned).toContain("Number the options that you offer");
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
      ["claude-opus-5.5", ["shell-optional"]],
      ["claude-sonnet-5.5", []],
      ["claude-fable-5.1", ["progress", "scope", "ambiguity", "final-message", "finishing", "initiative", "shell-first"]],
      ["claude-fable-5.2", ["finishing", "model-limits"]],
      ["claude-fable-5.3", ["finishing", "model-limits"]],
      ["claude-haiku-5.5", ["scope", "ambiguity", "finishing", "initiative"]],
      ["gpt-6.1-sol", ["progress", "final-message", "finishing", "initiative", "ambiguity", "authorization", "plain-writing", "corrections", "quiet-caveats"]],
      ["gpt-6.2-sol", ["progress", "final-message", "finishing", "initiative", "ambiguity", "authorization", "plain-writing", "corrections", "quiet-caveats"]],
      ["gpt-6-sol", ["progress", "final-message", "finishing", "initiative", "ambiguity", "authorization", "plain-writing", "corrections", "quiet-caveats"]],
      ["gpt-6-astra", ["progress", "final-message", "finishing", "initiative", "ambiguity", "authorization", "plain-writing", "quiet-caveats"]],
      ["gpt-6-luna", ["progress", "final-message", "finishing", "initiative", "ambiguity", "authorization", "plain-writing", "quiet-caveats"]],
    ];
    for (const [model, blocks] of expected) {
      const body = build(model, { tools: withFileTools });
      expect(body).toStartWith("You are Flywheel's chat agent.");
      expect(blocksOf(body)).toEqual([...blocks]);
      for (const shared of ["# This session", "# Acting", "they/them", "Use no name that you made up during the work"]) expect(body).toContain(shared);
      // Each base rule renders once: an add-in block keeps only the conditions that it adds to the base.
      for (const rule of [...BASE_MARKERS, "closing offers", "one idea per sentence", "one-line update before your first tool call", "Persist until the task is fully handled", "a separate worktree", "A long session is"]) expect(occurrences(body, rule)).toBe(1);
      expect(body).not.toContain("\u2014");
    }
    // Every GPT entry but luna's takes an authorized next step without ending the turn.
    const continues = "When the session already shows that the next step is authorized, take it. Do not end the turn to check.";
    for (const model of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra"]) expect(build(model)).toContain(continues);
    expect(build("gpt-6-luna")).not.toContain(continues);
    // A new major version is a new line: it gets the general prompt until it has its own entry.
    expect(build("gpt-7-luna")).not.toStartWith("You are Flywheel's chat agent.");
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

  it("keeps the general prompt outside interactive chat, adding only a subagent's or workflow agent's agent blocks after the core prompt", () => {
    const purposes: readonly (readonly [AgentPurpose, Pick<BuildSystemPromptOptions, "promptKind" | "unattended">])[] = [
      [{ kind: "subagent", renderAs: "subagent", parentToolUseId: "call-1" }, { promptKind: "subagent", unattended: true }],
      [{ kind: "workflow-agent", briefScope: { briefId: "implement" }, workflowAttemptId: "implement:attempt:1" }, { promptKind: "workflow-agent", unattended: true }],
      [{ kind: "unattended-chat" }, { promptKind: "chat", unattended: true }],
      [{ kind: "headless-task", prompt: { kind: "assembled", corePrompt: "You are a helpful AI Agent." } }, { promptKind: "headless" }],
    ];
    const expected: readonly (readonly [model: string, blocks: readonly string[]])[] = [
      ["gpt-6.1-sol", ["finishing", "corrections", "quiet-caveats"]],
      ["gpt-6-sol", ["finishing", "corrections", "quiet-caveats"]],
      ["gpt-6-astra", ["finishing", "quiet-caveats"]],
      ["gpt-6-luna", ["finishing", "quiet-caveats"]],
      ["claude-opus-5.5", []],
      ["claude-haiku-5.5", []],
    ];
    for (const [model, blocks] of expected) {
      for (const [purpose, kind] of purposes) {
        const options = (guided: boolean) => promptOptions({ corePrompt, tools: TOOLS, ...kind, purpose, ...(guided ? guidanceOf(model) : {}) });
        const parts = buildSystemPromptParts(options(true));
        const agentBlocks = purpose.kind === "subagent" || purpose.kind === "workflow-agent" ? blocks : [];
        expect(blocksOf(parts.map((part) => part.text).join("\n\n"))).toEqual([...agentBlocks]);
        expect(parts.filter((part) => part.label !== "model agent guidance")).toEqual(buildSystemPromptParts(options(false)));
        if (agentBlocks.length > 0) {
          expect(parts.map((part) => part.label).slice(0, 2)).toEqual(["core system prompt", "model agent guidance"]);
          // The agent learns how its turn ends from its unattended section, never from the chat's turn rules.
          expect(parts[1]?.text).not.toContain("until the user writes again");
        }
      }
    }
  });
});
