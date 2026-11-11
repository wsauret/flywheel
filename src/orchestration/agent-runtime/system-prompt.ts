/**
 * System prompt builder and rendering helpers.
 *
 * `buildSystemPrompt` is the single entry point for runtime system prompts.
 * It pre-renders the tool and guideline blocks and assembles the parts in the
 * correct order. Every chat opens with the chat body (model-chat-body.ts);
 * every other agent opens with the core prompt.
 *
 * Env primitives (detectShell, isGitRepo, etc.) live in env-detection.ts.
 */

import { SYSTEM_PROMPT_SEPARATOR, type SystemPromptTiers } from "./llm/system-prompt-tiers.js";
import { canUseCheckpoint, renderSessionNotesGuidance } from "../../infra/agent-assets/session-notes.js";
import { GLOBAL_GUIDELINE_ID, renderGlobalGuidelines, type GlobalGuidelineId } from "./global-guidelines.js";
import { systemPromptText as bundledSystemPrompt } from "../../infra/agent-assets/manifest.js";
import { bundledAgentAsset, type AgentAssetName } from "../../infra/agent-assets/system-prompt.js";
import type { RuntimeTool } from "./tools/types.js";
import { renderCapabilityText, type CapabilityCheck } from "../../infra/capability-text.js";
import type { SessionIdentity } from "../session/session-messaging.js";
import { renderSessionIdentity } from "./session-identity-prompt.js";
import { FLYWHEEL_CHAT_HOST, renderAgentGuidance, renderChatBody, type ModelGuidance } from "./model-chat-body.js";
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

/** Dispatch-sizing doctrine of an agent that is not a chat; the chat body states its own. It appears only when the
 *  request can dispatch work through the subagent or workflow tool. The actual request surface, not the runner kind,
 *  is the authority. */
function renderProportionalityGuidance(has: CapabilityCheck): string {
  const reviewer = has("type:reviewer");
  return `PROPORTIONALITY:
Scale optional orchestration to the work. Every expensive move - dispatching an agent, ${reviewer ? "adding a reviewer, " : ""}running a research pipeline, spinning up a verification wave - must pass a size test first. Local thresholds differ by task (what counts as trivial for a plan, a diff, a research topic); this rule is the shared shape:

- **Orchestration must pay for itself.** A ${reviewer ? "dispatch, reviewer, or pipeline" : "dispatch or pipeline"} must save more work than it adds.
- **Named triggers, not doubt.** Optional machinery is added when a named trigger matches, never because it "might catch something." No trigger matched, no machinery.
- **Correctness gates never shrink.** Sizing changes who does the work and how much machinery spins up - never whether evidence is fresh, claims are traced, or evidence is real. Past observations guide hypotheses, not acceptance; each verification pass observes the current state afresh.
- **Size honestly.** Do not understate work to avoid justified orchestration or overstate it to add ceremony.`;
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

// ── Top-level builder ─────────────────────────────────────────────

export interface BuildSystemPromptOptions {
  /** Core prompt of this realm, resolved from the startup-selected overlay
   *  roots by `loadSystemPrompt` (ARCH-DIRECTORIES-003). It opens the prompt of
   *  every agent that is not a chat; a chat opens with the chat body instead.
   *  Absent only for a caller with no realm, such as prompt tooling and unit
   *  tests, which then render the compiled-in prompt. */
  corePrompt?: string;
  /** Engineering doctrine of this realm (writing, elegance, and anti-pattern
   *  guidance), resolved by `loadEngineeringDoctrine`. Absent for agents that
   *  neither author nor judge code, whose prompt then omits it. A check agent
   *  omits it even when it is given. */
  engineeringDoctrine?: string;
  agentsMd?: string;
  /** The guidance blocks of the serving model, when it has an entry. A chat renders its chat blocks in the chat body;
   *  a subagent or a workflow agent renders its agent blocks after its finishing section. */
  modelGuidance?: ModelGuidance;
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
  const writesFiles = has("edit") || has("write");
  const engineeringDoctrine = renderedDoctrine(opts);
  if (chat) {
    stable("chat body", renderChatBody(opts.modelGuidance?.chat ?? [], has, FLYWHEEL_CHAT_HOST));
    if (engineeringDoctrine) stable("engineering doctrine", engineeringDoctrine);
  } else {
    stable("core system prompt", renderAgentAsset(opts.corePrompt ?? bundledSystemPrompt, "system-prompt.md", opts.purpose?.kind === "unattended-chat" ? unattendedChatCheck(has) : has));
    if (opts.purpose?.kind === "subagent" || opts.purpose?.kind === "workflow-agent") {
      stable("agent guidance", renderAgentGuidance(opts.modelGuidance?.agent ?? []));
    }
    if (engineeringDoctrine) stable("engineering doctrine", engineeringDoctrine);
    if (has("subagent") || has("workflow")) stable("proportionality", renderProportionalityGuidance(has));
  }
  if (toolContext) stable("tool context", toolContext);
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
