/**
 * Stale tool-result masking: static-cutoff retroactive context reduction.
 *
 * The mask cutoff T advances
 * only when context usage enters a higher pressure zone than ever seen this
 * conversation, and is frozen between advances. Frozen T means the masked
 * bytes before T are byte-identical turn-over-turn, so the provider prompt
 * cache prefix stays warm: one cache miss per zone advance instead of one per
 * turn. A/B evidence showed a rolling window is worse than no masking at
 * all; do not reintroduce one.
 *
 * Reference material, loaded skill instructions, and the person's answers
 * are never masked (see isStandingContext).
 *
 * Two block kinds are maskable before the cutoff:
 *  - tool RESULTS (the original scope), and
 *  - tool-USE input payloads of mutation tools (`write` content and `edit`
 *    patch text), which re-carry historical file bodies in assistant messages.
 *    The same static-cutoff zone mechanism supplies the cache safety for these.
 *
 * This is a pure transform applied at the provider-call boundary. The durable
 * conversation tree and the loop's in-memory history keep full tool-result
 * content (ARCH-CONTEXT-011); only the outbound request sees
 * placeholders. Placeholder bytes are a pure function of the tool result and
 * its tool_use block, so the same mask can be replayed deterministically for
 * provider-request-audit reconstruction (see maskToolResultsById).
 */

import type { ContentBlock, ConversationMessage } from "../llm/types.js";
import { DELIVERY_CONFIRMATION } from "../../../infra/delivery-confirmation.js";

interface ToolInput {
  [key: string]: unknown;
}

interface MaskableInputFields {
  [toolName: string]: readonly string[];
}

/** Context-usage ratios that open pressure zones (monotonically increasing).
 *  Source v1.7.0 delayed defaults; measured better than earlier triggers on
 *  long sessions. */
const ZONE_THRESHOLDS: readonly number[] = [0.3, 0.45, 0.6];

/** Fraction of current messages masked when each zone first opens. */
const ZONE_COVERAGE: readonly number[] = [0.6, 0.8, 0.95];

/** Minimum text size worth masking; below this the placeholder saves nothing. */
const MIN_MASK_TEXT_LENGTH = 120;

/** First-class project knowledge is never masked (ARCH-CONTEXT-011): the
 *  model must not lose standing instructions to staleness. */
const REFERENCE_BASENAMES: ReadonlySet<string> = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CONVENTIONS.md",
  "README.md",
  "SKILL.md",
  "package.json",
  "tsconfig.json",
  "biome.json",
]);

const REFERENCE_PATH_SUBSTRINGS: readonly string[] = [
  "docs/adrs/",
  "docs/product-intent/",
  "docs/architecture",
  "docs/elegance.md",
  "docs/terminology.md",
];

/** Heavy payload fields per mutation tool. Only these fields mask; the rest
 *  of the input (paths, counts) stays visible as the recover handle. */
const MASKABLE_INPUT_FIELDS: Readonly<MaskableInputFields> = {
  write: ["content"],
  edit: ["old_string", "new_string"],
  apply_patch: ["input"],
};

export interface StaleMaskResult {
  /** Transformed copy for the provider call; input messages are not mutated. */
  messages: ConversationMessage[];
  cutoffIndex: number;
  masksApplied: number;
  bytesSaved: number;
  /** Exact masked set, recorded on `prompt.assembled` so audit reconstruction
   *  can replay the mask and verify the stored prompt hash. */
  maskedToolUseIds: string[];
  /** tool_use blocks whose INPUT payload fields were masked. Kept separate
   *  from `maskedToolUseIds`: the cutoff can fall between a tool_use and its
   *  result, so replay must know which transform applied to which id. */
  maskedToolUseInputIds: string[];
}

export interface StaleToolResultMasker {
  /** Mask stale tool results for the next provider request. `usageRatio` is
   *  estimated prompt tokens / context limit. Returns null when nothing is
   *  masked (below all zones, or no eligible results before the cutoff). */
  mask(messages: ConversationMessage[], usageRatio: number): (StaleMaskResult & { zone: number }) | null;
}

export interface StaleMaskSeed {
  cutoffIndex: number;
  zone?: number;
}

/** Per-conversation masker. A restart continues the recorded cutoff and zone.
 *  A compaction resets the cutoff, keyed on the
 *  messages ARRAY identity: the agent loop appends in place between
 *  compactions and reassigns the array exactly when history is rewritten. */
export function createStaleToolResultMasker(initial?: StaleMaskSeed): StaleToolResultMasker {
  let previousCutoff = initial?.cutoffIndex ?? 0;
  let zoneEntered = initial?.zone ?? -1;
  let restoring = initial !== undefined;
  let lastMessagesRef: ConversationMessage[] | null = null;
  let cached: { length: number; cutoff: number; result: (StaleMaskResult & { zone: number }) | null } | undefined;

  return {
    mask(messages, usageRatio) {
      if (lastMessagesRef !== null && lastMessagesRef !== messages) {
        previousCutoff = 0;
        zoneEntered = -1;
        restoring = false;
        cached = undefined;
      }
      lastMessagesRef = messages;
      // Startup token estimates can cross a zone the last serving request did
      // not enter. Preserve its prefix for the first request, then advance normally.
      if (restoring && usageRatio > 0) {
        // Remove this pre-zone-record conversion after 2027-04-19.
        if (initial?.zone === undefined) zoneEntered = decideCutoff(messages.length, usageRatio, { previousCutoff, zoneEntered: -1 }).activeZone;
        restoring = false;
        cached = undefined;
        const result = maskStaleToolResults(messages, previousCutoff);
        const masked = result ? { ...result, zone: zoneEntered } : null;
        cached = { length: messages.length, cutoff: previousCutoff, result: masked };
        return masked;
      }
      const decision = decideCutoff(messages.length, usageRatio, { previousCutoff, zoneEntered });
      if (decision.zoneAdvanced) {
        previousCutoff = decision.cutoffIndex;
        zoneEntered = decision.activeZone;
        cached = undefined;
      }
      if (decision.cutoffIndex <= 0) return null;
      if (cached && cached.cutoff === decision.cutoffIndex && cached.length <= messages.length) {
        if (cached.length === messages.length) return cached.result;
        const result = cached.result
          ? { ...cached.result, messages: [...cached.result.messages, ...messages.slice(cached.length)] }
          : null;
        cached = { length: messages.length, cutoff: decision.cutoffIndex, result };
        return result;
      }
      const masked = maskStaleToolResults(messages, decision.cutoffIndex);
      const result = masked ? { ...masked, zone: zoneEntered } : null;
      cached = { length: messages.length, cutoff: decision.cutoffIndex, result };
      return result;
    },
  };
}

/** Per-turn masking seam for the agent loop: transform the provider request
 *  view without touching the loop's history, and shape the audit metadata for
 *  the request. */
export interface TurnStaleMasking {
  messages: ConversationMessage[];
  staleMasking: (Omit<StaleMaskResult, "messages"> & { zone: number }) | undefined;
}

export function maskStaleForTurn(input: {
  masker: StaleToolResultMasker;
  messages: ConversationMessage[];
  estimatedContextTokens: number;
  contextLimit: number;
}): TurnStaleMasking {
  const usageRatio = input.contextLimit > 0 ? input.estimatedContextTokens / input.contextLimit : 0;
  const result = input.masker.mask(input.messages, usageRatio);
  if (!result) return { messages: input.messages, staleMasking: undefined };
  // No diagnostic record: these fields ride into the request's durable
  // prompt.assembled fact, which is the one record of the masking decision.
  // Explicit fields (not a rest-spread): a future StaleMaskResult field must
  // not silently ride into the prompt.assembled fact payload.
  return {
    messages: result.messages,
    staleMasking: {
      cutoffIndex: result.cutoffIndex,
      zone: result.zone,
      masksApplied: result.masksApplied,
      bytesSaved: result.bytesSaved,
      maskedToolUseIds: result.maskedToolUseIds,
      maskedToolUseInputIds: result.maskedToolUseInputIds,
    },
  };
}

interface CutoffState {
  previousCutoff: number;
  zoneEntered: number;
}

export interface CutoffDecision {
  cutoffIndex: number;
  activeZone: number;
  zoneAdvanced: boolean;
}

/** Static cutoff: a zone opens exactly once (when usage first crosses its
 *  threshold); the cutoff is frozen at messages.length-at-entry × coverage and
 *  never re-derived while the zone is unchanged, and never decreases. */
export function decideCutoff(messageCount: number, usageRatio: number, state: CutoffState): CutoffDecision {
  let activeZone = -1;
  for (let zone = ZONE_THRESHOLDS.length - 1; zone >= 0; zone -= 1) {
    // SAFETY: zone indexes a module-const array within bounds.
    if (usageRatio >= ZONE_THRESHOLDS[zone]!) {
      activeZone = zone;
      break;
    }
  }

  // Defense in depth: a history rewrite the caller failed to reset on shrinks
  // messages.length below a stale cutoff; clamp so at worst everything before
  // the rewrite boundary is masked rather than everything in the conversation.
  const clampedPrevious = Math.min(state.previousCutoff, messageCount);

  if (activeZone <= state.zoneEntered) {
    return { cutoffIndex: clampedPrevious, activeZone, zoneAdvanced: false };
  }
  // SAFETY: activeZone > zoneEntered >= -1 implies activeZone indexes ZONE_COVERAGE.
  const newCutoff = Math.floor(messageCount * ZONE_COVERAGE[activeZone]!);
  return {
    cutoffIndex: Math.max(clampedPrevious, newCutoff),
    activeZone,
    zoneAdvanced: true,
  };
}

/** Pure transform: mask every eligible tool result strictly before the cutoff.
 *  Never mutates the input messages or their content arrays. */
export function maskStaleToolResults(
  messages: ReadonlyArray<ConversationMessage>,
  cutoffIndex: number,
): StaleMaskResult | null {
  const toolUseIndex = buildToolUseIndex(messages);
  const maskedToolUseIds: string[] = [];
  const maskedToolUseInputIds: string[] = [];
  let masksApplied = 0;
  let bytesSaved = 0;

  const result = messages.map((message, index) => {
    if (index >= cutoffIndex) return message;
    if (message.kind === "assistant") {
      const masked = maskAssistantToolUseInputs(message);
      if (!masked) return message;
      maskedToolUseInputIds.push(...masked.maskedIds);
      masksApplied += masked.maskedIds.length;
      bytesSaved += masked.bytesSaved;
      return masked.message;
    }
    if (message.kind !== "toolResult") return message;
    const toolUse = toolUseIndex.get(message.toolUseId);
    if (!eligibleForMasking(message, toolUse)) return message;

    const masked = maskedToolResult(message, toolUse);
    maskedToolUseIds.push(message.toolUseId);
    masksApplied += 1;
    bytesSaved += masked.bytesSaved;
    return masked.message;
  });

  if (masksApplied === 0) return null;
  return { messages: result, cutoffIndex, masksApplied, bytesSaved, maskedToolUseIds, maskedToolUseInputIds };
}

/** Reconstruction parity: replay a recorded mask over messages rebuilt from
 *  the durable tree. Applies the identical placeholder to exactly the recorded
 *  tool results and tool-use inputs, so the reassembled prompt hashes to the
 *  stored sha256. `toolUseInputIds` defaults empty because facts recorded
 *  before tool-use masking existed carry no such list. */
export function maskToolResultsById(
  messages: ReadonlyArray<ConversationMessage>,
  toolUseIds: ReadonlyArray<string>,
  toolUseInputIds: ReadonlyArray<string> = [],
): ConversationMessage[] {
  const resultIds = new Set(toolUseIds);
  const inputIds = new Set(toolUseInputIds);
  if (resultIds.size === 0 && inputIds.size === 0) return [...messages];
  const toolUseIndex = buildToolUseIndex(messages);
  return messages.map((message) => {
    if (message.kind === "assistant" && Array.isArray(message.content)) {
      if (!message.content.some((block) => block.type === "tool_use" && inputIds.has(block.id))) return message;
      const content = message.content.map((block) => {
        if (block.type !== "tool_use" || !inputIds.has(block.id)) return block;
        return maskedToolUseInput(block)?.block ?? block;
      });
      return { ...message, content };
    }
    if (message.kind !== "toolResult" || !resultIds.has(message.toolUseId)) return message;
    return maskedToolResult(message, toolUseIndex.get(message.toolUseId)).message;
  });
}

type ToolResultMessage = Extract<ConversationMessage, { kind: "toolResult" }>;
type AssistantMessage = Extract<ConversationMessage, { kind: "assistant" }>;
type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

function maskAssistantToolUseInputs(
  message: AssistantMessage,
): { message: AssistantMessage; maskedIds: string[]; bytesSaved: number } | null {
  if (!Array.isArray(message.content)) return null;
  const maskedIds: string[] = [];
  let bytesSaved = 0;
  const content = message.content.map((block) => {
    if (block.type !== "tool_use") return block;
    const masked = maskedToolUseInput(block);
    if (!masked) return block;
    maskedIds.push(block.id);
    bytesSaved += masked.bytesSaved;
    return masked.block;
  });
  if (maskedIds.length === 0) return null;
  return { message: { ...message, content }, maskedIds, bytesSaved };
}

/** Deterministic input-payload mask for one mutation tool_use block: each
 *  oversized payload field becomes a placeholder naming the field and its
 *  size; paths and other small fields stay visible as the recover handle.
 *  Returns null when nothing in the block is worth masking. */
function maskedToolUseInput(block: ToolUseBlock): { block: ToolUseBlock; bytesSaved: number } | null {
  const fields = MASKABLE_INPUT_FIELDS[block.name];
  if (!fields || isReferenceWriteTarget(block)) return null;
  let bytesSaved = 0;
  const input: ToolInput = { ...block.input };
  for (const field of fields) {
    const value = input[field];
    if (typeof value !== "string" || value.length < MIN_MASK_TEXT_LENGTH) continue;
    const placeholder = `[stale-masked ${block.name}.${field}] (${countLines(value)} lines, ${formatSize(value.length)}); input masked as stale, read the file for its current contents`;
    input[field] = placeholder;
    bytesSaved += Math.max(0, value.length - placeholder.length);
  }
  if (bytesSaved === 0) return null;
  return { block: { ...block, input }, bytesSaved };
}

/** The reference-file exemption applies to write targets exactly as it does
 *  to read results: standing instructions must not lose their content. */
function isReferenceWriteTarget(block: ToolUseBlock): boolean {
  const paths: string[] = [];
  const path = block.input["path"];
  if (typeof path === "string") paths.push(path);
  const files = block.input["files"];
  if (Array.isArray(files)) {
    for (const file of files) if (typeof file === "string") paths.push(file);
  }
  return paths.some(isReferencePath);
}

function eligibleForMasking(message: ToolResultMessage, toolUse: ToolUseBlock | undefined): boolean {
  // Errors and interruption tombstones stay visible: the model may still be
  // steering around them, and they are small.
  if (message.isError === true || message.interrupted === true) return false;
  // No matching tool_use block means no recover handle; leave it alone.
  if (!toolUse) return false;
  if (isStandingContext(toolUse)) return false;
  const textLength = textContentLength(message);
  const hasImage = message.content.some((part) => part.type === "image");
  return textLength >= MIN_MASK_TEXT_LENGTH || hasImage;
}

/** Context that the model cannot recover by re-running its tool
 *  (ARCH-CONTEXT-011): reference material, the instructions of a loaded
 *  skill, and the person's answers, which a re-run would ask again. */
function isStandingContext(toolUse: ToolUseBlock): boolean {
  if (toolUse.name === "ask_user") return true;
  if (toolUse.name === "skill") return toolUse.input["action"] === "load";
  const path = typeof toolUse.input["path"] === "string" ? toolUse.input["path"] : "";
  return toolUse.name === "read" && path.length > 0 && isReferencePath(path);
}

function isReferencePath(path: string): boolean {
  const basename = path.split("/").pop() ?? path;
  if (REFERENCE_BASENAMES.has(basename)) return true;
  return REFERENCE_PATH_SUBSTRINGS.some((substring) => path.includes(substring));
}

function maskedToolResult(
  message: ToolResultMessage,
  toolUse: ToolUseBlock | undefined,
) {
  const placeholder = placeholderText(message, toolUse);
  // A delivery confirmation is turn metadata, not tool output: the delivery
  // receipt communication rule defines its absence as "the turn rendered no text", so masking
  // must not erase the evidence that this turn's reply text reached the user.
  const confirmation = message.content.find((part) => part.type === "text" && part.text === DELIVERY_CONFIRMATION);
  const content = confirmation === undefined
    ? [{ type: "text" as const, text: placeholder }]
    : [{ type: "text" as const, text: placeholder }, confirmation];
  const originalBytes = message.content.reduce(
    (sum, part) => sum + (part.type === "text" ? part.text.length : part.data.length),
    0,
  );
  const maskedBytes = content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
  return {
    message: { ...message, content },
    bytesSaved: Math.max(0, originalBytes - maskedBytes),
  } satisfies { message: ToolResultMessage; bytesSaved: number };
}

/** Deterministic placeholder: a pure function of the tool result and its
 *  tool_use block. Byte-identical every time it is computed for the same
 *  message, which is what keeps the cache prefix stable and makes audit
 *  reconstruction replayable. Names the recover handle so the agent can
 *  re-run/re-read on demand (the just-in-time pattern). */
function placeholderText(message: ToolResultMessage, toolUse: ToolUseBlock | undefined): string {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const imageCount = message.content.filter((part) => part.type === "image").length;
  const meta = [`${countLines(text)} lines`, formatSize(text.length), ...(imageCount > 0 ? [`${imageCount} images`] : [])];
  const name = toolUse?.name ?? "tool";
  const handle = recoverHandle(toolUse);
  return `[stale-masked ${name}]${handle} (${meta.join(", ")}); result masked as stale, re-run the tool if needed`;
}

/** The most informative argument for re-invoking the tool, single-line, capped. */
function recoverHandle(toolUse: ToolUseBlock | undefined): string {
  if (!toolUse) return "";
  for (const key of ["command", "path", "pattern", "query", "url"]) {
    const value = toolUse.input[key];
    if (typeof value === "string" && value.length > 0) {
      return ` ${key}=${value.replace(/\s+/g, " ").slice(0, 80)}`;
    }
  }
  return "";
}

function buildToolUseIndex(messages: ReadonlyArray<ConversationMessage>): Map<string, ToolUseBlock> {
  const index = new Map<string, ToolUseBlock>();
  for (const message of messages) {
    if (message.kind !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") index.set(block.id, block);
    }
  }
  return index;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  return lines;
}

/** Deterministic size string; must not depend on locale or time. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function textContentLength(message: ToolResultMessage): number {
  return message.content.reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0);
}
