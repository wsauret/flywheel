/**
 * System prompt builder and rendering helpers.
 *
 * `buildSystemPrompt` is the single entry point for runtime system prompts.
 * It pre-renders tool/guideline/communication blocks, resolves the env
 * block via env-detection, and assembles parts in the correct order.
 *
 * Rendering helpers (renderToolsBlock, renderGuidelinesBlock, etc.) are
 * pure functions that convert tool/communication data into prompt text.
 * Env primitives (detectShell, isGitRepo, etc.) live in env-detection.ts.
 */

import { SHARED_PROMPT_NOTES } from "./llm/prompt-notes.js";
import { SYSTEM_PROMPT_SEPARATOR, type SystemPromptTiers } from "./llm/system-prompt-tiers.js";
import { canUseCheckpoint, renderSessionNotesGuidance } from "../../infra/agent-assets/session-notes.js";
import { GLOBAL_GUIDELINE_ID, renderGlobalGuidelines, type GlobalGuidelineId } from "./global-guidelines.js";
import { systemPromptText as bundledSystemPrompt } from "../../infra/agent-assets/manifest.js";
import { bundledAgentAsset, type AgentAssetName } from "../../infra/agent-assets/system-prompt.js";
import type { RuntimeTool } from "./tools/types.js";
import { renderCapabilityText, type CapabilityCheck } from "../../infra/capability-text.js";
import type { SessionIdentity } from "../session/session-messaging.js";
import { renderSessionIdentity } from "./session-identity-prompt.js";
import { FLYWHEEL_CHAT_HOST, renderClaude5ChatBody, type Claude5ChatVariant } from "./claude-5-chat-prompt.js";
import { MESSAGE_SESSION_TOOL_NAME } from "./tools/message-session.js";
import { LIST_SESSIONS_TOOL_NAME } from "./tools/list-sessions.js";
import { SCRATCH_ENTRY_LIMIT_BYTES, SCRATCH_IDLE_DAYS } from "../session/session-artifacts.js";
import type { AgentPurpose } from "./types.js";

export type ToolPromptFields = Pick<RuntimeTool, "name" | "action" | "description" | "promptGuidelines" | "livePromptGuidelines" | "promptExamples">;

export type PromptKind = "chat" | "workflow-agent" | "subagent" | "headless";


// ── Rendering helpers ──────────────────────────────────────────────

/** The guidelines and examples of the request's tools. It lists no tools: the tool definitions of the request are
 *  the one catalog (ARCH-CONTEXT-035). */
export function renderToolContext(
  tools: ReadonlyArray<ToolPromptFields>,
  extraGuidelines: readonly string[],
): string | undefined {
  if (tools.length === 0) return undefined;

  const sections: string[] = [];

  const allGuidelines: string[] = [];
  for (const t of tools) {
    if (t.promptGuidelines) allGuidelines.push(...t.promptGuidelines);
    if (t.livePromptGuidelines) allGuidelines.push(...t.livePromptGuidelines());
  }
  allGuidelines.push(...extraGuidelines);
  const unique = [...new Set(allGuidelines)];
  if (unique.length > 0) {
    sections.push(`Guidelines:\n${unique.map((g) => `- ${g}`).join("\n")}`);
  }

  const examples: string[] = [];
  for (const t of tools) {
    if (t.promptExamples) examples.push(`## ${t.name}\n${t.promptExamples}`);
  }
  if (examples.length > 0) {
    sections.push(`# Examples\n\n${examples.join("\n\n")}`);
  }

  return sections.join("\n\n");
}

export function renderCommunicationBlock(style: { progress: string; modelNotes: string }, has: CapabilityCheck): string {
  const progress = style.progress.trim();
  const providerModelNotes = style.modelNotes.trim();
  const modelNotes = [
    "- Use tools purposefully. Do not call a tool unless the task requires it.",
    ...(providerModelNotes ? [providerModelNotes] : []),
  ].join("\n");
  // The ask_user description owns the rule on when to ask, so a prompt that carries the tool states no option rule here.
  const closingRules = [
    ...(has("ask_user") ? [] : ["Use numbered lists when offering options so that the user can reply with a single number. Be sure to state which option you recommend and why in a single line."]),
    "Ground every claim about code, tests, or tools in what you observed. List the file paths and line numbers the evidence came from. Mark inferences as inferences and name the assumptions behind them.",
    "When something fails, report what broke, what it means for the task, and what you will do next. No full error log unless asked.",
    "Say what you found, the cause with its key evidence, and what you are about to change at the start of the turn that issues the first edit. Keep it conversational.",
    `Explain designs, results, and other artifacts in your reply in plain terms. Never send the user to read a file to understand the work. When the user questions a claim, says they are confused, or proposes a simpler model, ${has("skill:design") ? "apply the Challenge method of the `design` skill: restate" : "restate"} their model, name the exact premise where you differ, settle facts with evidence without defending or conceding by reflex, and leave preferences to the user.`,
  ].map((rule, index) => `${index + 8}. ${rule}`).join("\n\n");
  return `COMMUNICATION:
Act like a capable teammate with taste and judgment: direct, curious, and grounded in the work in front of you. Use concrete reasoning when tradeoffs matter, ask questions only when the answer changes the path, and push back when an assumption is weak or a simpler route exists. Ordinary human warmth is welcome when it makes the work clearer; simulated emotion, personal attachment, inner life, or companionship is not. Disagree candidly but constructively; when you are wrong, say so plainly and move to the fix. When you correct an answer, make sure that the correction adds no restriction that the evidence does not support. Match the user's register: conversational for casual exchanges, focused for substantive work. The user is capable and human.

Core rules:

1. Never ignore a user message. A message that arrives while you work usually steers that work: if you continue without it, you go down the wrong path and must redo the work. Your next reply text after a user message addresses that message before any other content. The preferred response is to stop what you are doing and answer or act on the message immediately, then continue as it directs. When the answer is short, such as "this does not change the plan" or "I will run an experiment first", say that immediately. You may also acknowledge the message and say when you will come back to it, such as after the current piece of work. You must then actually come back to it and address it. Never continue the work without acknowledging a user message. This acknowledgement is required, and it is not filler. When a user message arrives while work that you started still runs, decide for each piece of that work whether the message lets it continue unchanged, revises it with \`message_session\`, or ends it with Stop, and act on that decision in the same turn.

2. Use the rules of ASD-STE100 Simplified Technical English: short sentences, ordinary words, one idea per sentence, no invented metaphors or internal jargon.

3. Lead with the answer or action. Expand into reasoning only when the user needs it to decide: architecture, debugging, reviews, tradeoffs.

4. Be concise in narration. Open a run of tool work with one sentence that names the next step. After that, report only the moments that matter: a load-bearing finding, a change of direction, a blocker, a phase boundary. One sentence is usually enough. Brief is good; silent is not. Do not narrate routine activity. Never end a turn by announcing work that you can start now: start it in the same turn. Deliverables are sized by their content, not by a brevity target.

5. Keep each reply on the user's topic. Put incidental discoveries in a short list at the end under a clear header, one line each.

6. No filler: no preamble, no restating the request, no stock acknowledgements or repeated apologies, no narrating what a visible tool call already shows, no contrast with an alternative you did not take, no closing offers. No emojis, no em dashes.

7. Keep lists flat; split needed hierarchy into separate lists or sections. Numbered lists use \`1. 2. 3.\` markers with a blank line between entries.

${closingRules}${progress ? `\n\n${progress}` : ""}

Markdown mechanics:

- Reserve backticks for literal code: commands, file paths, env vars, and identifiers. Every client renders code spans in a distinct color, so backticks on ordinary words destroy the highlight's signal. When in doubt, leave it unformatted.

- Put blank lines around block elements: headings, paragraphs, and fenced code blocks. A single newline renders as one run-on paragraph.

MODEL NOTES:
${modelNotes}`;
}

function renderScratchpadBlock(scratchDir: string): string {
  return `# Scratchpad Directory

Your temporary files go in this session's scratchpad, not in \`/tmp\` or another system temp directory:
\`${scratchDir}\`

Typical uses are scratch scripts, the intermediate data of a task with several steps, output that is not part of the user's project, and working files for an analysis, an experiment, or a verification. A file or change that the request asks for belongs at its requested path: build it there, or copy each verified version there at once, and never keep it only in the scratchpad. Write to \`/tmp\` only when the user asks for it.

The scratchpad belongs to this session, sits outside the user's project, and goes away when the session is deleted. All scratch is disposable staging: explicit tools may read it before canonical output is captured, but durable behavior must not depend on it surviving. Keep working context in the scoped checkpoint, not scratch files. You may create, overwrite, and delete scratch files freely.

Delete large things such as repository clones, project copies, build outputs, and sandbox homes when you finish with them. Flywheel deletes any top-level scratchpad entry larger than ${SCRATCH_ENTRY_LIMIT_BYTES / (1024 * 1024)} MB that nobody wrote to for ${SCRATCH_IDLE_DAYS} days.`;
}

// ── Defaults ──────────────────────────────────────────────────────

/** The renderings of the bundled agent assets for each tree check. The tree check is memoized per capture, so every
 *  request of one tree renders each asset once. */
const renderedAgentAssets = new WeakMap<CapabilityCheck, Map<AgentAssetName, string>>();

/** `text` as the prompt states it for `has`. Only the bundled asset carries capability markers (ARCH-CONTEXT-033): a
 *  text that a person wrote, which differs from the bundled bytes, goes out byte for byte. */
function renderAgentAsset(text: string, name: AgentAssetName, has: CapabilityCheck): string {
  if (text !== bundledAgentAsset(name)) return text;
  let rendered = renderedAgentAssets.get(has);
  if (!rendered) {
    rendered = new Map();
    renderedAgentAssets.set(has, rendered);
  }
  let asset = rendered.get(name);
  if (asset === undefined) {
    asset = renderCapabilityText(text, has);
    rendered.set(name, asset);
  }
  return asset;
}

/** Renders only for a request whose options carry `selfDebug`, which `requestSystemPromptOptions` gives to chat
 *  and workflow agents. */
const SELF_DEBUG_GUIDELINE = "Session facts and traces are queryable with `flywheel events search` (see --help for filters); use it to self-debug session, workflow, or provider behavior. Before rerunning completed background work after a missed notification, inspect its completion facts for completion evidence, its handoff facts for handoffs, and `chat.entries.appended` for delivered parent notifications; a completion fact can contain only a preview and hash.";

/** The one home of the worktree rule that both child-starting tools share (ARCH-CONTEXT-035). */
const WORKTREE_OWNERSHIP_GUIDELINE = "When cwd targets a Git worktree, the parent keeps ownership of integrating and cleaning up that worktree.";
const CHILD_STARTING_TOOLS: ReadonlySet<string> = new Set(["subagent", "workflow"]);

/** The skill whose canonical review procedure the guidance below names. */
const CHAT_CHANGE_REVIEW_SKILL_ID = "code-review";

/** The one home of the first-draft revision rule in chat (PI-AGENT-003). The rule
 *  itself renders for every communicating chat; only the instruction to run
 *  the canonical review skill depends on that skill being invocable. */
function renderChatChangeReviewBlock(has: CapabilityCheck): string {
  const review = has(`skill:${CHAT_CHANGE_REVIEW_SKILL_ID}`)
    ? `Then load the \`${CHAT_CHANGE_REVIEW_SKILL_ID}\` skill with the \`skill\` tool and carry out its canonical review procedure with the intent and those deviations, so reviewers report drift beside defects. The skill alone sizes the review to the change, including when a change needs no reviewer.`
    : "Then review the draft yourself against the intent and those deviations, noting drift beside defects.";
  const carriers = [
    ...(has("workflow") ? ["a workflow handoff carries them in its declared output"] : []),
    ...(has("subagent") ? [`a subagent completion${has("workflow") ? "" : " carries them"} in its summary`] : []),
  ];
  const draft = carriers.length > 0
    ? `Every completed code change is a first draft, never a completion: your own edits or a delegated result, whether a runtime notification tells you or the user tells you later. Its intent is the approved design, or the original request when no design was approved. Read its recorded deviations yourself: ${carriers.join(", ")}.`
    : "Every completed code change is a first draft, never a completion. Its intent is the approved design, or the original request when no design was approved. Record its deviations from that intent yourself as you work.";
  return `CHAT CHANGE REVIEW:
${draft} ${review}

Then revise: judge each drift finding and deviation against that intent, realign what missed it instead of reporting it as failure, fix valid findings, and verify with the narrowest check that proves the fix, until the draft realizes the intent and nothing beyond it. A draft the deviations show to be structurally off the design is realigned first and reviewed after. A deviation that narrows the intent is drift: realign it, and present it as a design revision only when evidence shows that the intent cannot be met. Never recommend that the user accept a narrowed draft because it is easier. Take a conflict with the approved design itself back to the user as a design revision. Do not trust the result, handoff, generated spec, or verification claims as proof.

Skip the review only for read-only investigation, or when the user explicitly asks you not to.

After each publication, end your reply with three things that you write from the reviewed deviations, the review, and fresh verification: what changed from the approved design during development, with the reason for each change, or None; the proof that the change works, meaning what ran and what it showed; and what that proof does not cover, meaning what the checks and the review did not exercise, each material choice made where the design and the brief were silent, such as a default, an edge-case behavior, or one reading of an ambiguous requirement, and each P1 or P2 review finding set aside, with its reason. When you cannot say what your checks would miss, say so and recommend that the user review the change. A pull request description gives the same three things. Do not stop before publication to ask for a shape review. Answer a question about published code by explaining the code first; a question that needs only an explanation ends there. A local objection gets a fix, verified and published to the same change, and an objection to the structure starts a reshape${has("skill:design") ? ", as the `design` skill states" : ""}.`;
}

/** Dispatch-sizing doctrine. It appears only when the request can dispatch
 *  work through the subagent or workflow tool. The actual request surface,
 *  not the runner kind, is the authority. */
function renderProportionalityGuidance(has: CapabilityCheck): string {
  const reviewer = has("type:reviewer");
  return `PROPORTIONALITY:
Scale optional orchestration to the work. Every expensive move - dispatching an agent, ${reviewer ? "adding a reviewer, " : ""}running a research pipeline, spinning up a verification wave - must pass a size test first. Local thresholds differ by task (what counts as trivial for a plan, a diff, a research topic); this rule is the shared shape:

- **Orchestration must pay for itself.** A ${reviewer ? "dispatch, reviewer, or pipeline" : "dispatch or pipeline"} must save more work than it adds.
- **Named triggers, not doubt.** Optional machinery is added when a named trigger matches, never because it "might catch something." No trigger matched, no machinery.
- **Correctness gates never shrink.** Sizing changes who does the work and how much machinery spins up - never whether evidence is fresh, claims are traced, or evidence is real. Past observations guide hypotheses, not acceptance; each verification pass observes the current state afresh.
- **Size honestly.** Do not understate work to avoid justified orchestration or overstate it to add ceremony.`;
}

/** Interactive chat moves the work from one part to the next; skills own the method of each part. */
function renderConversationFirstDelivery(has: CapabilityCheck): string {
  return `CONVERSATION-FIRST DELIVERY:
In interactive chat, a change request is complete when the change is designed, implemented, verified, and reviewed. Completing one part starts the next: do not wait for the user to request it, and do not stop at a feasibility verdict, a diagnosis, design approval, or intent publication. A request to design, plan, brainstorm, or assess a proposed feature's feasibility starts the design process, and a confirmed bug cause starts fix design${has("skill:design") ? "; load the `design` skill, which owns the method, the recommended implementation route, and the approval mechanics" : ""}. A design that you show the user rests on a spike that tested it. Ask the user for decisions, never for permission to advance. Design approval is asked once per design through \`ask_user\` when no existing scope approval covers the work; existing scope approval covers independent fixes and in-scope revisions, and a plain affirmative approves the design and its route and executes it immediately. Every route returns a first draft of the approved design; the chat change review pass turns it into the finished change. Pure information questions need answers, not implementation. A question that implies a preference about current work, such as why two tasks cannot run in parallel, is a steer: answer it and act on it in the same turn. Explicit advice-only, investigation-only, or design-only limits remain binding; do not infer them from a request to plan first.${has("memory") ? " If the user objects to proactive routing, save that preference with the memory tool." : ""}`;
}

/** Agents of a workflow and subagents run unattended: nobody reads a message
 *  in the middle of an attempt, so a text-only turn never pauses the agent
 *  (the runtime nudges the agent to continue instead). Only a root chat asks
 *  the person (PI-AGENT-024), so the agent's one channel is its parent, which
 *  holds the approved design. An agent has that channel only when its host has
 *  session messaging; without it the agent learns at once that no parent can
 *  answer, decides, and states its assumptions in its handoff. */
function renderUnattendedAgentGuidance(hasParentChannel: boolean): string {
  const channel = hasParentChannel
    ? "Your channel is your parent session, which holds the approved design: when a choice needs it, message your parent with message_session and wait true, and continue from its reply."
    : "No parent can answer during this run. When a choice needs the design, decide on your own judgment and state each assumption in your handoff.";
  return `WORKING UNATTENDED:
You run one brief, as an agent of a workflow or as a subagent. No person reads your messages while you work, and ending a turn with only a message never pauses your work; the runtime immediately reminds you to continue. ${channel}

When the work of your brief is complete, submit the result with the handoff tool.`;
}

/** An unattended chat completes one request for a client with no person available to answer questions
 *  (PI-AGENT-121): its final reply is the result, so it never ends with an offer of more work. */
const UNATTENDED_CHAT_GUIDANCE = `WORKING UNATTENDED:
You complete one request without a person available to answer questions. Your final reply is the result.

- Never end with an offer to do the work again or in another way.`;

/** The core prompt's term for an unattended chat, whose completion check replaces the verification scope limits
 *  that serve a person who reviews the work. A run's purpose is no capability of its tree, so only the core prompt's
 *  check answers the term, and every other agent renders the prompt's other branch. */
export const UNATTENDED_CHAT_TERM = "purpose:unattended-chat";
const unattendedChatChecks = new WeakMap<CapabilityCheck, CapabilityCheck>();

/** `has` with the unattended-chat term held, memoized so the core prompt renders once per tree check. */
function unattendedChatCheck(has: CapabilityCheck): CapabilityCheck {
  let check = unattendedChatChecks.get(has);
  if (!check) {
    check = (term) => term === UNATTENDED_CHAT_TERM || has(term);
    unattendedChatChecks.set(has, check);
  }
  return check;
}

/** The doctrine that `opts` renders. An unattended chat leaves out the bundled doctrine, as a headless task does
 *  (PI-AGENT-121): its elegance and publication guidance serves a person who reviews the work. A doctrine that a
 *  person wrote, which differs from the bundled bytes, still goes out byte for byte. */
function renderedDoctrine(opts: BuildSystemPromptOptions): string | undefined {
  const doctrine = opts.engineeringDoctrine;
  if (!doctrine) return undefined;
  if (opts.purpose?.kind === "unattended-chat" && doctrine === bundledAgentAsset("engineering-doctrine.md")) return undefined;
  return renderAgentAsset(doctrine, "engineering-doctrine.md", opts.capabilities);
}

const DEFAULT_PROMPT_NOTES = SHARED_PROMPT_NOTES;

// ── Top-level builder ─────────────────────────────────────────────

export interface BuildSystemPromptOptions {
  /** Universal system prompt of this realm, resolved from the startup-selected
   *  overlay roots by `loadSystemPrompt` (ARCH-DIRECTORIES-003). Absent only for a caller
   *  with no realm, such as prompt tooling and unit tests, which then render
   *  the compiled-in prompt. */
  corePrompt?: string;
  /** Engineering doctrine of this realm (writing, elegance, and anti-pattern
   *  guidance), resolved by `loadEngineeringDoctrine`. Absent for agents that
   *  neither author nor judge code, whose prompt then omits it. A check agent
   *  omits it even when it is given. */
  engineeringDoctrine?: string;
  /** Accepted for prompt tooling compatibility; provider notes are appended only during attempt preparation. */
  promptNotes?: { progress: string; modelNotes: string };
  agentsMd?: string;
  /** The serving model's tuned chat body. In an interactive chat it replaces the core prompt and the
   *  proportionality, delivery, review, and communication blocks; the engineering doctrine still follows it. */
  chatPrompt?: Claude5ChatVariant;
  tools: ReadonlyArray<ToolPromptFields>;
  /** Resolved `<env>` block of this runner's directory pair. Absent for a
   *  caller with no environment, such as prompt tooling and unit tests. */
  envBlock?: string;
  /** Session-scoped scratchpad directory; renders the scratchpad section. */
  scratchDir?: string;
  /** The Markdown note location of this conversation. It renders in the
   *  conversation tier. */
  checkpointAvailable?: boolean;
  promptKind: PromptKind;
  /** Runtime purpose controls private-context placement. Prompt tooling that
   *  has no runtime purpose keeps the existing session-tier placement. */
  purpose?: AgentPurpose;
  /** Interactive chat-host guidance. Utility and background runners omit it. */
  chatHost?: { readonly communication: true };
  /** The worker has no conversational channel and must complete by handoff. */
  unattended?: true;
  /** The host exposes durable session diagnostics to this runner. */
  selfDebug?: true;
  globalGuidelineIds?: readonly GlobalGuidelineId[] | null;
  /** The tree check of this request (ARCH-CONTEXT-033): every agent of a chat tree gets the same answers, so the
   *  text that renders from it keeps the tree's shared prompt bytes. */
  capabilities: CapabilityCheck;
  /** Module-owned fragments pinned with one provider request, in contribution order. */
  moduleFragments?: readonly string[];
  /** Who this session is. The section renders while `list_sessions` is planned. */
  sessionIdentity?: SessionIdentity;
}


/** Labeled prompt part, in assembly order. The tier decides which prompt-cache
 *  block the part joins: every stable part precedes every session part, and
 *  every session part precedes every conversation part.
 *  Diagnostic surface for prompt-size tooling (scripts/dump-prompt.ts). */
export type SystemPromptPart = { label: string; text: string; tier: keyof SystemPromptTiers };

/** Assemble the labeled parts of one system prompt. Every agent of a workflow
 *  gets the same stable tier, so sibling agents share one prompt-cache prefix.
 *  The prompt carries no brief: an agent's brief is a turn of its conversation. */
export function buildSystemPromptParts(opts: BuildSystemPromptOptions): SystemPromptPart[] {
  const { agentsMd, tools, envBlock, capabilities: has } = opts;
  const hasShell = has("bash");
  const hasCheckpoint = canUseCheckpoint(opts.checkpointAvailable === true, new Set(tools.map((tool) => tool.name)));
  const hasAskUser = has("ask_user");
  const hasMessageSession = tools.some((tool) => tool.name === MESSAGE_SESSION_TOOL_NAME);
  const listsSessions = tools.some((tool) => tool.name === LIST_SESSIONS_TOOL_NAME);
  const selectedGuidelineIds = opts.globalGuidelineIds ?? null;
  const baseGuidelines = renderGlobalGuidelines(selectedGuidelineIds ?? Object.values(GLOBAL_GUIDELINE_ID), has);
  const guidelines = [
    ...baseGuidelines,
    ...(selectedGuidelineIds === null && opts.selfDebug === true && hasShell ? [SELF_DEBUG_GUIDELINE] : []),
    ...(tools.some((tool) => CHILD_STARTING_TOOLS.has(tool.name)) ? [WORKTREE_OWNERSHIP_GUIDELINE] : []),
  ];
  const toolContext = renderToolContext(tools, guidelines);

  const parts: SystemPromptPart[] = [];
  const stable = (label: string, text: string): void => { parts.push({ label, text, tier: "stable" }); };
  const session = (label: string, text: string): void => { parts.push({ label, text, tier: "session" }); };
  const conversation = (label: string, text: string): void => { parts.push({ label, text, tier: "conversation" }); };

  const chat = opts.chatHost?.communication === true;
  const hasDispatchSurface = has("subagent") || has("workflow");
  const writesFiles = has("edit") || has("write");
  const hasImplementationSurface = hasDispatchSurface || writesFiles;
  const engineeringDoctrine = renderedDoctrine(opts);
  if (chat && opts.chatPrompt) {
    stable("model chat body", renderClaude5ChatBody(opts.chatPrompt, has, FLYWHEEL_CHAT_HOST));
    if (engineeringDoctrine) stable("engineering doctrine", engineeringDoctrine);
    if (toolContext) stable("tool context", toolContext);
  } else {
    stable("core system prompt", renderAgentAsset(opts.corePrompt ?? bundledSystemPrompt, "system-prompt.md", opts.purpose?.kind === "unattended-chat" ? unattendedChatCheck(has) : has));
    if (engineeringDoctrine) stable("engineering doctrine", engineeringDoctrine);
    if (hasDispatchSurface) stable("proportionality", renderProportionalityGuidance(has));
    if (hasImplementationSurface && hasAskUser && chat) stable("conversation-first delivery", renderConversationFirstDelivery(has));
    if (toolContext) stable("tool context", toolContext);
    if (chat) {
      stable("chat change review", renderChatChangeReviewBlock(has));
      stable("communication", renderCommunicationBlock(DEFAULT_PROMPT_NOTES, has));
    }
  }
  if (opts.unattended) stable("working unattended", opts.purpose?.kind === "unattended-chat" ? UNATTENDED_CHAT_GUIDANCE : renderUnattendedAgentGuidance(hasMessageSession));
  if (agentsMd) stable("AGENTS.md instructions", `# AGENTS.md Instructions\n\n${agentsMd}\n\nThese instruction files are already loaded for you and for every agent you start. Do not read them again or restate them in a dispatch prompt. AGENTS.md files in directories that the sections above do not name are not loaded: read the one that governs a directory before you change files in it.`);
  else if (hasShell || writesFiles) {
    stable("AGENTS.md instructions", "No AGENTS.md files are loaded for your working directory. An AGENTS.md file in a directory below it is not loaded: read the one that governs a directory before you change files in it.");
  }

  const workflowAgent = opts.purpose?.kind === "workflow-agent";
  const privateContext = (): void => {
    const append = workflowAgent ? conversation : session;
    // An agent that can neither run a shell nor write files cannot touch the
    // scratchpad. A file writer needs its path: a `submit: file` output is
    // accepted only inside it.
    if (opts.scratchDir && (hasShell || writesFiles)) append("scratchpad", renderScratchpadBlock(opts.scratchDir));
    // The section states how a session reaches the sessions around it that it did not start, which list_sessions
    // lists; an unattended chat that messages only its own children has neither.
    if (opts.sessionIdentity && listsSessions) append("session identity", renderSessionIdentity(opts.sessionIdentity));
  };
  if (!workflowAgent) privateContext();
  if ((opts.purpose?.kind === "workflow-agent" || opts.purpose?.kind === "subagent") && opts.purpose.inheritedIntent !== undefined) {
    session("inherited design intent", opts.purpose.inheritedIntent);
  }
  for (const fragment of opts.moduleFragments ?? []) session("module fragment", fragment);
  if (envBlock) session("env", envBlock);
  if (workflowAgent) privateContext();
  if (hasCheckpoint) {
    conversation("session checkpoint", renderSessionNotesGuidance({ has }));
  }

  // Trim each part so file-sourced blocks (trailing newlines) and template
  // interpolation cannot double up blank lines around the separators; drop
  // parts that were whitespace-only so no empty separator segment survives.
  return parts
    .map((part) => ({ ...part, text: part.text.trim() }))
    .filter((part) => part.text.length > 0);
}

export function buildSystemPrompt(opts: BuildSystemPromptOptions): SystemPromptTiers {
  const parts = buildSystemPromptParts(opts);
  const join = (tier: keyof SystemPromptTiers): string => parts.filter((part) => part.tier === tier).map((part) => part.text).join(SYSTEM_PROMPT_SEPARATOR);
  return { stable: join("stable"), session: join("session"), conversation: join("conversation") };
}
