// Adapted from the token-budget messages in OpenAI Codex `codex-rs/models-manager/models.json` (Apache-2.0). Flywheel changed this text; the replacement ledger in tests/unit/orchestration/agent-runtime/session-notes-prompts.test.ts records each change. Credited in THIRD-PARTY-NOTICES.md.
import type { CapabilityCheck } from "../capability-text.js";

export interface SessionNotesPromptInput {
  /** The capabilities of the reader: the tree check for the system prompt, the agent check for a turn. */
  readonly has: CapabilityCheck;
}

export const CHECKPOINT_TOOL_NAMES: ReadonlySet<string> = new Set(["checkpoint_read", "checkpoint_replace", "checkpoint_decide"]);

/** Recovery requires all scoped checkpoint tools to be advertised and executable. */
export function canUseCheckpoint(
  available: boolean,
  tools: { has(name: string): boolean },
  executionTools?: ReadonlySet<string>,
): boolean {
  return available && [...CHECKPOINT_TOOL_NAMES].every((name) => tools.has(name) && (!executionTools || executionTools.has(name)));
}

const SESSION_NOTES_GUIDANCE_TEMPLATE = "For tasks that may span context windows, keep your conversation's checkpoint current with the checkpoint tools. The complete checkpoint is limited to 24,576 UTF-8 bytes; when a write is refused, curate it, and never discard intent to save tokens. {skill_checkpoint_guidance} {design_intent_guidance} {request_reference_guidance} Use only the scoped checkpoint tools, not Markdown files or ordinary project file tools.\n\nIt is a good idea to update the checkpoint incrementally while you work so that you do not miss any important info. Compaction starts a fresh context without a generated summary; prior conversation messages are not carried into it. Once the token budget is exhausted, recover details from the checkpoint{recall_recovery_source}.\n\nDo not mention the checkpoint{recall_bookkeeping} in user-facing messages.\n";

const SESSION_NOTES_AUTO_COMPACT_FALLBACK_TEMPLATE = "<context_window_reminder>\nThe current context window is exhausted. Do not continue the task or give a final answer in this window. Compaction starts a fresh context without a generated summary; prior conversation messages are not carried into it. Save the checkpoint now: optionally use only `checkpoint_read` in the first response to recover saved context, then use `checkpoint_replace` or `checkpoint_decide` to save the sections that changed{request_reference_clause}, as well as important actions/tool calls for future reference. Read existing content before replacing it. Preserve saved user intent; if you cannot recover it, leave the existing checkpoint intact rather than replace it with empty recovery prose. {skill_checkpoint_guidance} {design_intent_guidance} {recall_guidance} After saving, continue in the next context; do not use other tools in this exhausted context.\n</context_window_reminder>";

const RECALL_GUIDANCE = "Use the `recall` tool to recover details by durable entry ID.";
const SKILL_CHECKPOINT_GUIDANCE = 'Keep a short "Relevant skills" section with the exact IDs of loaded skills that still apply to ongoing work and one short reason each remains relevant. Remove skills for completed phases. Do not copy skill bodies into the checkpoint.';
/** The design intent is the one value a compacted chat agent cannot rebuild
 *  from memory and must hold exactly to revise a returned first draft
 *  (ARCH-AGENCY-015, ARCH-AGENCY-024), so the checkpoint names it, labels it, and keeps it current. */
const DESIGN_INTENT_GUIDANCE = 'Keep a clearly labeled "Design intent" section and keep it first: the user\'s request in their own words and the current understood design (purpose, feature set, key decisions, non-goals, constraints, and each rejected alternative with its reason). Write it when the request arrives, update it as discussion, inspection, and experiments change the understood intent, and mark the version the user approved as approved. Record each later user decision with `checkpoint_decide`. A rejected alternative and a replaced decision are never obsolete: keep them when you remove other obsolete information. After compaction this section is the exact design intent you revise drafts against; do not reconstruct it from memory.';

function renderTemplate(template: string, { has }: SessionNotesPromptInput): string {
  const recall = has("recall");
  const skill = has("skill");
  return template
    .replace("{skill_checkpoint_guidance}", skill ? SKILL_CHECKPOINT_GUIDANCE : "")
    .replace("{design_intent_guidance}", DESIGN_INTENT_GUIDANCE)
    .replace("{recall_guidance}", recall ? RECALL_GUIDANCE : "")
    .replace("{request_reference_clause}", recall ? ", and the durable recall entry ID of every relevant user request still being solved" : "")
    .replace("{request_reference_guidance}", recall ? "Keep in References the durable recall entry IDs of every relevant user request you are solving and of important actions and tool calls." : "Include important actions and tool calls.")
    .replace("{recall_recovery_source}", recall ? ", and durable conversation recall" : "")
    .replace("{recall_bookkeeping}", recall ? " or recall" : "")
    .replace(/ {2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function renderSessionNotesGuidance(input: SessionNotesPromptInput): string {
  return renderTemplate(SESSION_NOTES_GUIDANCE_TEMPLATE, input);
}

export function renderSessionNotesAutoCompactFallback(input: SessionNotesPromptInput): string {
  return renderTemplate(SESSION_NOTES_AUTO_COMPACT_FALLBACK_TEMPLATE, input);
}
