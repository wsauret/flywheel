import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSystemPromptParts, buildSystemPrompt as buildSystemPromptTiers, type BuildSystemPromptOptions, type ToolPromptFields } from "../../../../src/orchestration/agent-runtime/system-prompt.js";
import { renderSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { resolveModelInteractionProfile } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { CHALLENGE, CODE_REFERENCES, FOLLOW_UP_WORK, KEEP_GOING, MODEL_GUIDANCE, OPEN_CHOICES } from "../../../../src/orchestration/agent-runtime/model-chat-body.js";
import type { AgentPurpose } from "../../../../src/orchestration/agent-runtime/types.js";
import { captureRuntimeConfigRequest } from "../../../../src/orchestration/agent-runtime/request-config.js";
import { loadConfig } from "../../../../src/orchestration/config/loader.js";
import { installedDefinitionBundles } from "../../../../src/orchestration/module-catalog.js";
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js";
import { SUBAGENT_HANDOFF_SCHEMA } from "../../../../src/orchestration/modules/subagents/execution/prompts.js";
import { installedPersonaToolEntries } from "../../../../src/orchestration/tool-catalog.js";
import { createProjectDefinitionRegistry } from "../../../../src/workflows/definition-registry.js";
import { loadEngineeringDoctrine, loadSystemPrompt } from "../../../../src/infra/agent-assets/system-prompt.js";
import { planPromptRequest, promptParts, type PromptAssembly } from "../../../../scripts/prompt-assembly.js";
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
  authorization: "# Authorization",
  "plain-writing": "# Plain writing",
  corrections: "# Corrections",
  "quiet-caveats": "# Caveats",
  "model-limits": "speed up AI development",
} as const;

/** The sections of the base that every chat body holds in this order, whatever the model. */
const BASE_SECTIONS = ["# This session", "# Acting", "# Finishing the work", "# Initiative", "# Ambiguity", "# Working in Flywheel"] as const;

/** One phrase that marks each base rule, which every chat body states once. */
const BASE_MARKERS = [
  "Do not work them out again, and do not reopen them",
  "When you compare options, finish with the one that you recommend",
  "report the action that was refused, what refused it, and the reason that it gave",
  "Ask for permission only where a capable colleague would ask",
  "A permission covers that kind of step for the rest of the task",
  "Name the real risks and limits that remain",
  "It replaces that goal only when the user cancels it or asks for work that cannot go with it",
  KEEP_GOING,
  FOLLOW_UP_WORK,
  CODE_REFERENCES,
  OPEN_CHOICES,
  CHALLENGE,
] as const;

/** One phrase that marks each rule that the chat body took over from the agents' core prompt and the former general
 *  chat blocks, which every chat body states once. */
const FOLDED_MARKERS = [
  "Put correctness first, brevity second, and politeness third",
  "Use a tool only when the task needs it",
  "the only copy of a log, copy it first",
  "build only what the evidence supports",
  "Ground each claim about code, tests, or tools in what you observed",
  "A coherent change can include a large refactor across several files",
  "realign what missed it instead of reporting it as a failure",
  "verify each fix with the narrowest check that proves it",
  "After each publication, end your reply with three things",
  "expand into reasoning only when the user needs it to decide",
  "restated request",
  "treats the user as a capable person",
] as const;

const occurrences = (text: string, phrase: string): number => text.split(phrase).length - 1;

const definitions = createProjectDefinitionRegistry({ projectRoot: promptRealmRoot, userDataRoot: promptRealmRoot, accountHome: promptRealmRoot, skillRoots: [], bundles: installedDefinitionBundles(), personaToolEntries: installedPersonaToolEntries() }).captureRevision();
const modules = composeFirstPartyModules();
const loadedConfig = loadConfig(undefined, {}, promptRealmRoot);
const runtimeConfig = captureRuntimeConfigRequest({ revision: 0, config: loadedConfig.config, warnings: loadedConfig.warnings, diagnostics: loadedConfig.diagnostics, sourceIdentity: "model-chat-body", status: { kind: "missing" } }, "default");

/** The system prompt and the tool descriptions of one request that `model` serves, assembled the way a live request
 *  assembles them. */
async function assembledRequest(model: string, purpose: AgentPurpose): Promise<string> {
  const assembly: PromptAssembly = {
    projectRoot: promptRealmRoot, userDataRoot: promptRealmRoot, accountHome: promptRealmRoot, scratchDir: join(promptRealmRoot, "scratch"), definitions, runtimeConfig,
    capture: modules, live: modules, workflowsMode: "on", servingModel: { model, modelFamily: model.startsWith("gpt-") ? "openai" : "anthropic" }, hosts: false,
  };
  const chat = purpose.kind === "interactive-chat";
  const planned = await planPromptRequest(assembly, { personas: definitions.personas, purpose, askUser: chat, ...(chat ? {} : { handoffSchema: { schema: SUBAGENT_HANDOFF_SCHEMA } }) });
  if (chat) planned.tools.delete("handoff");
  const parts = await promptParts(assembly, purpose, planned, { corePrompt, engineeringDoctrine, agentsMd: undefined, memory: () => null });
  return [...parts.map((part) => part.text), ...[...planned.tools.values()].map((tool) => tool.description)].join("\n\n");
}

/** The guidance blocks that `body` holds, in the order it renders them. */
function blocksOf(body: string): string[] {
  return Object.entries(BLOCK_MARKERS)
    .filter(([, marker]) => body.includes(marker))
    .sort(([, a], [, b]) => body.indexOf(a) - body.indexOf(b))
    .map(([block]) => block);
}

/** The chat body is the base of every chat on every model; a model entry adds guidance blocks to it. */
describe("chat body", () => {
  it("renders the same chat body in place of the core prompt for a model with or without an entry, and keeps every other part", () => {
    const tools = [...TOOLS, spec("skill"), spec("ask_user"), spec("subagent"), spec("edit", { action: "file_edit" })];
    const unlisted = build("claude-sonnet-4", { tools, engineeringDoctrine, agentsMd, skills: ["code-review"] });
    const listed = build("claude-opus-5.5", { tools, engineeringDoctrine, agentsMd, skills: ["code-review"] });

    expect(listed).toBe(unlisted);
    expect(unlisted).toStartWith("You are Flywheel's chat agent.");
    for (const rule of [...BASE_MARKERS, ...FOLDED_MARKERS]) expect(occurrences(unlisted, rule)).toBe(1);
    for (const kept of DOCTRINE_SECTIONS) expect(unlisted).toContain(kept);
    for (const gone of [...CORE_SECTIONS, "PROPORTIONALITY:", "CONVERSATION-FIRST DELIVERY:", "CHAT CHANGE REVIEW:", "COMMUNICATION:", "MODEL NOTES:", "Provider Interaction Notes"]) expect(unlisted).not.toContain(gone);
    for (const commitment of ["**Chat leads a change through delivery.**", "load the `code-review` skill", "the skill alone sizes the review to the change", "**Orchestration pays for itself.**", "**User messages come first.**", "**One coherent change at a time.**", "no change is needed is a successful result", "Understand the code before you change it", "Do only what the request needs, and still finish it", "Never test a copy of production code", "Never recommend that the user accept a narrowed draft", "rests on a spike that tested it", "do not stop at a feasibility verdict, a diagnosis, or design approval", "a request to plan first does not set such a limit", "and what that proof does not cover", "A pull request description gives the same three things", "Do not stop before publication to ask for a shape review", "explaining the code first; a question that needs only an explanation ends there", "A local objection gets a fix, verified and published to the same change, and an objection to the structure starts a reshape", "never send the user to read a file", "a subagent result carries them in its summary"]) {
      expect(unlisted).toContain(commitment);
    }
    expect(unlisted).not.toContain("trivial edits");
    expect(unlisted).toContain("Guidelines:");
    expect(unlisted).toContain(`# AGENTS.md Instructions\n\n${agentsMd}`);
  });

  it("states only the commitments that the request surface can honor", () => {
    const tuned = build("claude-sonnet-5.5");
    expect(tuned).not.toContain("**Chat leads a change through delivery.**");
    expect(tuned).not.toContain("**Orchestration pays for itself.**");
    // The first-draft commitment, with its report after a publication, holds in every chat.
    expect(tuned).toContain("end your reply with three things");
    expect(tuned).toContain("review it yourself against the intent");
    expect(tuned).toContain("Number the options that you offer");
    // No skill, memory, workflow, or subagent tool: the body names none of them and keeps each method.
    for (const absent of ["`design` skill", "memory", "subagent", "workflow", "the recorded history"]) expect(tuned).not.toContain(absent);
    expect(tuned).toContain("run it in the scratchpad before you design on the claim");
    const noShell = build("claude-sonnet-5.5", { tools: [spec("read")] });
    expect(noShell).toContain("settle that with the tools you have, or report it as an unverified assumption");
    expect(noShell).not.toContain("probe");
    // Workflows alone: the orchestration commitment names only the workflow route.
    const workflows = build("claude-sonnet-5.5", { tools: [...TOOLS, spec("workflow"), spec("ask_user")] });
    expect(workflows).toContain("**Orchestration pays for itself.** Add a reviewer or start a workflow only on a named trigger");
    expect(workflows).toContain("**Chat leads a change through delivery.**");
    // The design skill and memory add their pointers to the delivery commitment only when the request has them.
    const designed = build("claude-sonnet-5.5", { tools: [...TOOLS, spec("edit"), spec("ask_user"), spec("skill"), spec("memory")], skills: ["design"] });
    expect(designed).toContain("start design: load the `design` skill.");
    expect(designed).toContain("A request to design, plan, brainstorm, or assess feasibility");
    expect(designed).toContain("If the user objects to this proactive routing, save that preference to memory.");
  });

  it("adds each model's guidance blocks to the base in its order, a later family version inheriting the newest earlier entry", () => {
    const withFileTools = [...TOOLS, spec("edit"), spec("write")];
    const gpt = ["progress", "final-message", "authorization", "plain-writing", "corrections", "quiet-caveats"];
    const gptWithoutCorrections = gpt.filter((block) => block !== "corrections");
    const expected: readonly (readonly [model: string, blocks: readonly string[]])[] = [
      ["claude-opus-5.5", []],
      ["claude-sonnet-5.5", []],
      ["claude-sonnet-4", []],
      ["claude-fable-5.1", ["progress", "scope", "final-message"]],
      ["claude-fable-5.2", ["model-limits"]],
      ["claude-fable-5.3", ["model-limits"]],
      ["claude-haiku-5.5", ["scope"]],
      ["gpt-6.1-sol", gpt],
      ["gpt-6.2-sol", gpt],
      ["gpt-6-sol", gpt],
      ["gpt-6-astra", gptWithoutCorrections],
      ["gpt-6-luna", gptWithoutCorrections],
      // A new major version is a new line: it gets the base alone until it has its own entry.
      ["gpt-7-luna", []],
    ];
    for (const [model, blocks] of expected) {
      const body = build(model, { tools: withFileTools });
      expect(body).toStartWith("You are Flywheel's chat agent.");
      expect(blocksOf(body)).toEqual([...blocks]);
      const sections = BASE_SECTIONS.map((section) => body.indexOf(section));
      expect(sections.every((index, at) => index >= 0 && (at === 0 || index > sections[at - 1]!))).toBe(true);
      for (const shared of ["they/them", "Use no name that you made up during the work"]) expect(body).toContain(shared);
      // Each base rule renders once: an add-in block keeps only the conditions that it adds to the base.
      for (const rule of [...BASE_MARKERS, ...FOLDED_MARKERS, ...BASE_SECTIONS, "closing offers", "one idea per sentence", "one-line update before your first tool call", "Persist until the task is fully handled", "A long session is", "If one part is truly blocked"]) expect(occurrences(body, rule)).toBe(1);
      expect(body).not.toContain("\u2014");
    }
    // Every GPT entry but luna's takes an authorized next step without ending the turn.
    const continues = "When the session already shows that the next step is authorized, take it. Do not end the turn to check.";
    for (const model of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra"]) expect(build(model)).toContain(continues);
    expect(build("gpt-6-luna")).not.toContain(continues);
    expect(build("claude-opus-5.5", { tools: [...TOOLS, spec("recall")] })).toContain("session notes and the recorded history");
  });

  it("states each consolidated rule once in every assembled request, tool descriptions included", async () => {
    const consolidated = [...BASE_MARKERS, ...FOLDED_MARKERS, ...BASE_SECTIONS, "An assumption is the last resort", "Before you ask, start all work that does not depend on the answer", "in one area"];
    // Every table model, a model of a tuned family with no entry, and a model of a line that no entry covers.
    const chatModels = [...MODEL_GUIDANCE.map(([model]) => model), "claude-opus-5.5", "claude-sonnet-4", "gpt-7-luna"];
    for (const model of chatModels) {
      const text = await assembledRequest(model, { kind: "interactive-chat" });
      for (const rule of consolidated) expect({ model, rule, count: occurrences(text, rule) }).toEqual({ model, rule, count: 1 });
    }
    // A subagent keeps the core prompt's open-choice rule, gets the agent rendering of finishing on every model, and
    // learns from its unattended section that a turn never pauses its work, so it gets no chat rule on when to end the
    // turn, and no chat rule on how to answer a challenge.
    for (const model of ["gpt-6.1-sol", "claude-opus-5.5"]) {
      const subagent = await assembledRequest(model, { kind: "subagent", renderAs: "subagent", parentToolUseId: "call-1" });
      for (const rule of [OPEN_CHOICES, "never pauses your work", "in one area", "# Finishing the work", "A long session is not a reason to stop"]) expect({ model, rule, count: occurrences(subagent, rule) }).toEqual({ model, rule, count: 1 });
      for (const chatRule of [KEEP_GOING, CHALLENGE, "until the user writes again"]) expect(subagent).not.toContain(chatRule);
    }
  });

  it("keeps the core prompt outside chat, adding finishing and the agent blocks after it for a subagent or a workflow agent", () => {
    const purposes: readonly (readonly [AgentPurpose, Pick<BuildSystemPromptOptions, "promptKind" | "unattended">])[] = [
      [{ kind: "subagent", renderAs: "subagent", parentToolUseId: "call-1" }, { promptKind: "subagent", unattended: true }],
      [{ kind: "workflow-agent", briefScope: { briefId: "implement" }, workflowAttemptId: "implement:attempt:1" }, { promptKind: "workflow-agent", unattended: true }],
      [{ kind: "unattended-chat" }, { promptKind: "chat", unattended: true }],
      [{ kind: "headless-task", prompt: { kind: "assembled", corePrompt: "You are a helpful AI Agent." } }, { promptKind: "headless" }],
    ];
    const expected: readonly (readonly [model: string, blocks: readonly string[]])[] = [
      ["gpt-6.1-sol", ["corrections", "quiet-caveats"]],
      ["gpt-6-sol", ["corrections", "quiet-caveats"]],
      ["gpt-6-astra", ["quiet-caveats"]],
      ["gpt-6-luna", ["quiet-caveats"]],
      ["claude-opus-5.5", []],
      ["claude-haiku-5.5", []],
    ];
    for (const [model, blocks] of expected) {
      for (const [purpose, kind] of purposes) {
        const options = (guided: boolean) => promptOptions({ corePrompt, tools: TOOLS, ...kind, purpose, ...(guided ? guidanceOf(model) : {}) });
        const parts = buildSystemPromptParts(options(true));
        const withoutGuidance = buildSystemPromptParts(options(false));
        const agent = purpose.kind === "subagent" || purpose.kind === "workflow-agent";
        const text = parts.map((part) => part.text).join("\n\n");
        expect(blocksOf(text)).toEqual(agent ? [...blocks] : []);
        expect(occurrences(text, "# Finishing the work")).toBe(agent ? 1 : 0);
        expect(parts.filter((part) => part.label !== "agent guidance")).toEqual(withoutGuidance.filter((part) => part.label !== "agent guidance"));
        if (agent) {
          expect(parts.map((part) => part.label).slice(0, 2)).toEqual(["core system prompt", "agent guidance"]);
          expect(withoutGuidance[1]?.text).toStartWith("# Finishing the work");
          expect(blocksOf(withoutGuidance[1]?.text ?? "")).toEqual([]);
          // The agent learns how its turn ends from its unattended section, never from the chat's turn rules.
          expect(parts[1]?.text).not.toContain("until the user writes again");
        }
      }
    }
  });
});
