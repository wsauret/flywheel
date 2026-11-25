import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";

import { buildSystemPromptParts, buildSystemPrompt as buildSystemPromptTiers, type BuildSystemPromptOptions } from "../../../../../../src/orchestration/agent-runtime/request/prompt/system-prompt.js";
import { renderSystemPrompt } from "../../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { resolveModelInteractionProfile } from "../../../../../../src/orchestration/agent-runtime/request/prompt/model-interaction-profile.js";
import { FLYWHEEL_CHAT_HOST, MODEL_GUIDANCE, renderAgentGuidance, renderChatBody } from "../../../../../../src/orchestration/agent-runtime/request/prompt/model-chat-body.js";
import type { AgentPurpose } from "../../../../../../src/orchestration/agent-runtime/types.js";
import { captureRuntimeConfigRequest } from "../../../../../../src/orchestration/agent-runtime/request/request-config.js";
import { loadConfig } from "../../../../../../src/orchestration/config/loader.js";
import { installedDefinitionBundles } from "../../../../../../src/orchestration/module-catalog.js";
import { composeFirstPartyModules } from "../../../../../../src/orchestration/modules.js";
import { SUBAGENT_HANDOFF_SCHEMA } from "../../../../../../src/orchestration/modules/subagents/execution/prompts.js";
import { installedPersonaToolEntries } from "../../../../../../src/orchestration/agent-runtime/tools/dispatch/tool-catalog.js";
import { createProjectDefinitionRegistry } from "../../../../../../src/workflows/definitions/definition-registry.js";
import { loadEngineeringDoctrine, loadSystemPrompt } from "../../../../../../src/infra/definitions/agent-assets/system-prompt.js";
import { planPromptRequest, promptParts, type PromptAssembly } from "../../../../../../scripts/prompt-assembly.js";
import { testDirectories } from "../../../../../helpers/directories.js";
import { promptOptions, type ToolPromptFields } from "../../../../../helpers/prompt-capabilities.js";

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

/** The open-choice rule as the chat body states it. The agents' core prompt states the same sentences, so the
 *  assembled subagent request below fails when the two drift apart. */
const OPEN_CHOICES = (() => {
  const rule = /^- \*\*Open choices\.\*\* (.+)$/m.exec(build("claude-opus-5.5"))?.[1];
  if (rule === undefined) throw new Error("expected the open-choice commitment in the chat body");
  return rule;
})();
const KEEP_GOING = "Keep working until the task is done. End the turn before that only when you need an answer that only the user can give";
const FOLLOW_UP_WORK = "Do not drop follow-up work that you notice.";
const CHALLENGE = "When the user questions a claim, says that they are confused, or proposes a simpler model, first restate their model.";

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
  "gpt-6.2-codex": "Bias towards action, as long as it progresses",
  "gpt-6.1-codex": "Lead with the outcome and then develop",
  "gpt-6-codex": "Give each paragraph one main point",
} as const;

/** The vendored Codex model catalog whose `models[].model_messages.instructions_template` the Codex passage sets copy
 *  (ARCH-CONTEXT-045). The `slug` of each entry is the Flywheel model id. */
const CODEX_MODELS = resolve("inspiration/codex/codex-rs/models-manager/models.json");
const CodexModelsSchema = Schema.Struct({
  models: Schema.Array(Schema.Struct({ slug: Schema.String, model_messages: Schema.Struct({ instructions_template: Schema.String }) })),
});

/** A run of source lines, 1-based and inclusive, that a rendering copies with its own line breaks. */
type LineSpan = readonly [first: number, last: number];
/** The Flywheel edits of one source line, in order, as `[from, to]`. */
type CodexEdits = readonly (readonly [from: string, to: string])[];

/** The replacement ledger of one Codex passage set: the spans of the template's lines that the chat and the agent
 *  renderings copy, joined by a blank line, and every Flywheel edit, by line, as `[from, to]`. */
interface CodexLedger {
  readonly chat: readonly LineSpan[];
  readonly agent: readonly LineSpan[];
  readonly edits: ReadonlyMap<number, CodexEdits>;
}

const GPT_6_2_LEDGER: CodexLedger = {
  chat: [[7, 9], [35, 41], [43, 45], [51, 51], [53, 53], [55, 55], [59, 59], [65, 73], [77, 77], [81, 83], [86, 86], [92, 102]],
  agent: [[43, 43], [53, 53], [65, 73], [81, 83], [86, 86], [92, 102]],
  edits: new Map([
    // A Flywheel block heading is a first-level heading.
    [7, [["## ", "# "]]],
    [35, [["## ", "# "]]],
    // Flywheel renders no trailing space at the end of a line.
    [9, [["your reasoning. ", "your reasoning."]]],
    [51, [["edits they want. ", "edits they want."]]],
    [101, [["maintainability. ", "maintainability."]]],
    // Flywheel has no `commentary` channel, and the collapse of earlier updates describes the Codex client.
    [37, [["Disclosure in commentary alone", "Disclosure in progress updates alone"]]],
    [39, [
      ["intermediate commentary", "intermediate progress updates"],
      ["prior context from commentary", "prior context from progress updates"],
      ["read earlier commentary updates", "read earlier progress updates"],
      [", since they are collapsed after the final answer is shown to users", ""],
    ]],
    // Flywheel's approval rules decide when to ask.
    [59, [[" Ask only if the proposed action would address a specific, material gap in the user's requested outcome.", ""]]],
    // The repository's instructions decide worktrees, merges, and pull requests.
    [71, [[" (e.g. creating isolated worktrees / checkouts if needed, resolving merge conflicts, read-only actions, creating draft PRs etc)", ""]]],
    // Follow-up work stays inside the request's scope and approval rules.
    [77, [["When the user asks", "Within the limits above, when the user asks"]]],
    // Flywheel handles only reachable states.
    [96, [["If an operation can fail partway", "If an operation can, under supported conditions, fail partway"]]],
  ]),
};

// The edits that the GPT-6 and GPT-6.1 ledgers share. A Flywheel block heading is a first-level heading, and Flywheel
// has no `commentary` channel.
const INTERMEDIATE_HEADING_EDITS: CodexEdits = [["## Intermediate commentary", "# Intermediate progress updates"]];
// Flywheel has no `commentary` or `final` channel, and the collapse of earlier updates describes the Codex client.
const finalAnswerEdits = (questionRule: string, finalChannelRule: string): CodexEdits => [
  [questionRule, "Do NOT send user facing questions in intermediate progress updates."],
  [finalChannelRule, ""],
  ["read earlier commentary updates", "read earlier progress updates"],
  [", since they are collapsed after the final answer is shown to users", ""],
];
// Flywheel's approval rules decide when to ask, and the repository's instructions decide how the work is published.
const PERMISSION_EDITS: CodexEdits = [
  ["For example, before deploying a change, writing to an external application, merging a PR or publishing a site, do all the work first so that user approval is the final step. ", ""],
  ["You don't need user permission for", "Within the approval rules above, you don't need user permission for"],
];
// The repository's instructions decide worktrees, merges, and pull requests.
const PERSIST_EDITS: CodexEdits = [[" (e.g. creating isolated worktrees / checkouts if needed, resolving merge conflicts, read-only actions, creating draft PRs etc)", ""]];

const GPT_6_LUNA_LEDGER: CodexLedger = {
  chat: [[7, 9], [13, 13], [19, 19], [25, 25], [31, 37], [57, 57], [63, 63]],
  agent: [[7, 7], [13, 13], [31, 37]],
  edits: new Map([
    [7, [["## ", "# "]]],
    [25, PERMISSION_EDITS],
    [35, PERSIST_EDITS],
    [57, INTERMEDIATE_HEADING_EDITS],
    // The question rule also fixes the source's misspelling "intermedaite".
    [63, finalAnswerEdits("Do NOT send user facing questions in intermedaite commentary messages.", "Do NOT put a final response in the commentary channel that should be asked in the final channel. ")],
  ]),
};

/** The Sol ledger: the Luna lines, then the Sol rules on tests and corrections. */
const GPT_6_SOL_LEDGER: CodexLedger = {
  chat: [...GPT_6_LUNA_LEDGER.chat, [96, 96], [109, 110], [111, 111]],
  agent: [...GPT_6_LUNA_LEDGER.agent, [96, 96], [109, 110]],
  edits: new Map([
    ...GPT_6_LUNA_LEDGER.edits,
    // Fixing a correction stays inside the request's scope and approval rules.
    [111, [["When the user corrects", "Within the limits above, when the user corrects"]]],
  ]),
};

/** "Reviewer" names a Flywheel agent capability, which prompt text states only for a reader that holds it
 *  (ARCH-CONTEXT-033). The reader of a pull request description is the same person. */
const PR_READER_EDITS: CodexEdits = [["for a reviewer who", "for a reader who"], ["help reviewers assess", "help readers assess"]];

const GPT_6_ASTRA_FINAL_ANSWER_EDITS = finalAnswerEdits("Do NOT send user facing questions in intermediate commentary messages.", "Do NOT put a final response in the commentary channel. ");

/** The ledger of `gpt-6-astra` and `gpt-6.1-terra`, whose templates are the same. */
const GPT_6_ASTRA_LEDGER: CodexLedger = {
  chat: [[3, 3], [9, 9], [15, 21], [31, 33], [45, 57], [73, 73], [79, 79], [112, 112], [125, 126]],
  agent: [[15, 21], [45, 45], [49, 51], [112, 112], [125, 126]],
  edits: new Map([
    [9, PERMISSION_EDITS],
    [19, PERSIST_EDITS],
    [31, [["## ", "# "]]],
    [33, [["be useful. ", "be useful."]]],
    [45, [["## ", "# "]]],
    [49, [["practical limits. ", "practical limits."]]],
    [53, [["### ", "## "]]],
    [57, PR_READER_EDITS],
    [73, INTERMEDIATE_HEADING_EDITS],
    [79, GPT_6_ASTRA_FINAL_ANSWER_EDITS],
  ]),
};

/** The ledger of `gpt-6.1-sol`: the Astra lines, two lines later from the technical communication heading on, because
 *  its writing style adds a paragraph on apologies. */
const GPT_6_1_SOL_LEDGER: CodexLedger = {
  chat: [[3, 3], [9, 9], [15, 21], [31, 33], [47, 59], [75, 75], [81, 81], [114, 114], [127, 128]],
  agent: [[15, 21], [47, 47], [51, 53], [114, 114], [127, 128]],
  edits: new Map([
    [9, PERMISSION_EDITS],
    [19, PERSIST_EDITS],
    [31, [["## ", "# "]]],
    [33, [["be useful. ", "be useful."]]],
    [47, [["## ", "# "]]],
    [51, [["practical limits. ", "practical limits."]]],
    [55, [["### ", "## "]]],
    [59, PR_READER_EDITS],
    [75, INTERMEDIATE_HEADING_EDITS],
    [81, GPT_6_ASTRA_FINAL_ANSWER_EDITS],
  ]),
};

/** The ledger of each model whose guidance holds a Codex passage set, by model id. */
const CODEX_LEDGERS: ReadonlyMap<string, CodexLedger> = new Map([
  ["gpt-6.2-sol", GPT_6_2_LEDGER],
  ["gpt-6.2-astra", GPT_6_2_LEDGER],
  ["gpt-6.1-sol", GPT_6_1_SOL_LEDGER],
  ["gpt-6.1-terra", GPT_6_ASTRA_LEDGER],
  ["gpt-6-sol", GPT_6_SOL_LEDGER],
  ["gpt-6-astra", GPT_6_ASTRA_LEDGER],
  ["gpt-6-luna", GPT_6_LUNA_LEDGER],
]);

/** The text that `spans` of `template` render with `edits` applied: each `from` must occur once in its line. */
function applyCodexLedger(template: string, spans: readonly LineSpan[], edits: CodexLedger["edits"]): string {
  const lines = template.split("\n");
  const line = (number: number): string => (edits.get(number) ?? []).reduce((text, [from, to]) => {
    expect({ number, from, count: text.split(from).length - 1 }).toEqual({ number, from, count: 1 });
    return text.replace(from, to);
  }, lines[number - 1] ?? "");
  return spans.map(([first, last]) => Array.from({ length: last - first + 1 }, (_, offset) => line(first + offset)).join("\n")).join("\n\n");
}

/** The sections of the base that every chat body holds in this order, whatever the model. */
const BASE_SECTIONS = ["# This session", "# Acting", "# Finishing the work", "# Initiative", "# Ambiguity", "# Working in Flywheel"] as const;

/** One phrase that marks each base rule, which every chat body states once. */
const BASE_MARKERS = [
  "Do not work them out again, and do not reopen them",
  "When you compare options, finish with the one that you recommend",
  "report the refused action, what refused it, and its reason",
  "Ask for permission only where a capable colleague would ask",
  "A permission covers that kind of step for the rest of the task",
  "Name the real risks and limits that remain",
  "It replaces that goal only when the user cancels it or asks for work that cannot go with it",
  KEEP_GOING,
  FOLLOW_UP_WORK,
  "name a file, a function, or a flag only when the reader must open or use it",
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
  "A change gets one review: after you fix its findings, verify the fixes and do not review the change again.",
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
    expect(unlisted.indexOf(KEEP_GOING)).toBeLessThan(unlisted.indexOf(FOLLOW_UP_WORK));
    for (const kept of DOCTRINE_SECTIONS) expect(unlisted).toContain(kept);
    for (const gone of [...CORE_SECTIONS, "PROPORTIONALITY:", "CONVERSATION-FIRST DELIVERY:", "CHAT CHANGE REVIEW:", "COMMUNICATION:", "MODEL NOTES:", "Provider Interaction Notes"]) expect(unlisted).not.toContain(gone);
    for (const commitment of ["**Chat leads a change through delivery.**", "load the `code-review` skill", "when its description says that the change needs review", "**Orchestration pays for itself.**", "**User messages come first.**", "**One coherent change at a time.**", "no change is needed is a successful result", "Understand the code before you change it", "Do only what the request needs, and still finish it", "Never test a copy of production code", "Never recommend that the user accept a narrowed draft", "rests on a spike that tested it", "do not stop at a feasibility verdict, a diagnosis, or design approval", "a request to plan first does not set such a limit", "and what that proof does not cover", "A pull request description gives the same three things", "Do not stop before publication to ask for a shape review", "explaining the code first; a question that needs only an explanation ends there", "A local objection gets a fix, verified and published to the same change, and an objection to the structure starts a reshape", "never send the user to read a file", "Record your own deviations from that intent as you work. After", "**Do what the request asks and do not expand its scope.** Avoid changing public interfaces or contracts without the approval of the user.", "Internal changes that the request needs, such as a new helper or a reworked private function, are not interface changes.", "Spikes and experiments are the exception"]) {
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
    // Each GPT model renders the Codex passage set of its own template in place of the final-message block.
    const gpt = (codex: string, corrections = true): string[] => ["progress", codex, "authorization", "plain-writing", ...(corrections ? ["corrections"] : []), "quiet-caveats"];
    const gpt62 = gpt("gpt-6.2-codex");
    const expected: readonly (readonly [model: string, blocks: readonly string[]])[] = [
      ["claude-opus-5.5", []],
      ["claude-sonnet-5.5", []],
      ["claude-sonnet-4", []],
      ["claude-fable-5.1", ["progress", "scope", "final-message"]],
      ["claude-fable-5.2", ["model-limits"]],
      ["claude-fable-5.3", ["model-limits"]],
      ["claude-haiku-5.5", ["scope"]],
      ["gpt-6.1-sol", gpt("gpt-6.1-codex")],
      ["gpt-6.1-terra", gpt("gpt-6.1-codex", false)],
      ["gpt-6.2-terra", gpt("gpt-6.1-codex", false)],
      ["gpt-6.2-sol", gpt62],
      ["gpt-6.2-astra", gpt62],
      ["gpt-6.3-sol", gpt62],
      ["gpt-6.3-astra", gpt62],
      ["gpt-6-sol", gpt("gpt-6-codex")],
      ["gpt-6-astra", gpt("gpt-6.1-codex", false)],
      ["gpt-6-luna", gpt("gpt-6-codex", false)],
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
      for (const rule of [...BASE_MARKERS, ...FOLDED_MARKERS, ...BASE_SECTIONS, "closing offers", "one idea per sentence", "one-line update before your first tool call", "A long session is", "If one part is truly blocked"]) expect(occurrences(body, rule)).toBe(1);
      expect(body).not.toContain("\u2014");
    }
    // Every GPT entry but luna's takes an authorized next step without ending the turn.
    const continues = "When the session already shows that the next step is authorized, take it. Do not end the turn to check.";
    for (const model of ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-astra"]) expect(build(model)).toContain(continues);
    expect(build("gpt-6-luna")).not.toContain(continues);
    // The GPT-6 Sol set adds the rules on tests and corrections that the Luna set leaves out.
    const solRules = "Broaden or repeat testing only to resolve a concrete remaining risk";
    expect(build("gpt-6-sol")).toContain(solRules);
    expect(build("gpt-6-luna")).not.toContain(solRules);
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
      ["gpt-6.2-sol", ["gpt-6.2-codex", "corrections", "quiet-caveats"]],
      ["gpt-6.2-astra", ["gpt-6.2-codex", "corrections", "quiet-caveats"]],
      ["gpt-6.1-sol", ["gpt-6.1-codex", "corrections", "quiet-caveats"]],
      ["gpt-6.1-terra", ["gpt-6.1-codex", "quiet-caveats"]],
      ["gpt-6-sol", ["gpt-6-codex", "corrections", "quiet-caveats"]],
      ["gpt-6-astra", ["gpt-6.1-codex", "quiet-caveats"]],
      ["gpt-6-luna", ["gpt-6-codex", "quiet-caveats"]],
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

  it.skipIf(!existsSync(CODEX_MODELS))("copies each Codex passage set from its model's Codex template with only the edits of its ledger", () => {
    const templates = new Map(Schema.decodeUnknownSync(CodexModelsSchema)(JSON.parse(readFileSync(CODEX_MODELS, "utf8"))).models.map((entry) => [entry.slug, entry.model_messages.instructions_template]));
    const guided = MODEL_GUIDANCE.filter(([, guidance]) => [...guidance.chat, ...guidance.agent].some((block) => typeof block !== "string"));
    expect(guided.map(([model]) => model).toSorted()).toEqual([...CODEX_LEDGERS.keys()].toSorted());
    const has = (): boolean => true;
    const base = renderChatBody([], has, FLYWHEEL_CHAT_HOST);
    for (const [model, guidance] of guided) {
      const ledger = CODEX_LEDGERS.get(model)!;
      const template = templates.get(model);
      if (template === undefined) throw new Error(`no Codex template for ${model}`);
      const chatLines = new Set(ledger.chat.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, offset) => first + offset)));
      for (const line of ledger.edits.keys()) expect({ model, line, copied: chatLines.has(line) }).toEqual({ model, line, copied: true });
      const chat = guidance.chat.filter((block) => typeof block !== "string");
      const agent = guidance.agent.filter((block) => typeof block !== "string");
      expect(renderChatBody(chat, has, FLYWHEEL_CHAT_HOST)).toBe(base.replace(FLYWHEEL_CHAT_HOST.commitmentsHeading, `${applyCodexLedger(template, ledger.chat, ledger.edits)}\n\n${FLYWHEEL_CHAT_HOST.commitmentsHeading}`));
      expect(renderAgentGuidance(agent, true)).toBe(`${renderAgentGuidance([], true)}\n\n${applyCodexLedger(template, ledger.agent, ledger.edits)}`);
    }
  });
});
