import { runToCompletion } from "../../../infra/task-scheduling.js";
import { conversationRole, trailingAlternatingMessage, type ContentBlock, type ConversationMessage } from "../../agent-runtime/llm/types.js";
import type { CompactionEntry, MessageEntry, ConversationEntry } from "./conversation-entry-types.js";
import type { DegradedTranscriptRecord } from "./conversation-projection.js";
import { repairToolAdjacencyWork } from "./conversation-tool-adjacency.js";
import { parseRuntimeReminder } from "../../agent-runtime/llm/runtime-reminders.js";
import { installedModules } from "../../module-catalog.js";
import type { ModuleHistoricalFraming } from "../../module-seams.js";

// Cooperative history work in this file yields once per branch entry or
// provider message, because branch length is the dimension that grows without
// bound. Work inside one entry or message stays native.

type PersistedMessage = MessageEntry["message"];
type PersistedTextContent = Extract<PersistedMessage, { kind: "user" }>["content"];

// The persisted content schema mirrors ContentBlock member-for-member. Copy
// the array so the readonly modifier is dropped; each block already matches a
// ContentBlock member, so no per-field rebuild is needed.
function toConversationContent(content: PersistedTextContent): string | ContentBlock[] {
  return typeof content === "string" ? content : [...content];
}

/** Maps a schema-validated persisted message into the canonical model shape.
 * Preserves its role and available model metadata without validation, history
 * repair, or source mutation. Content arrays are copied; their blocks are shared.
 * The persisted system kinds share one struct, so each maps to its own member. */
export function persistedToConversationMessage(message: PersistedMessage): ConversationMessage {
  switch (message.kind) {
    case "user":
      return {
        kind: "user",
        content: toConversationContent(message.content),
        ...(message.origin ? { origin: message.origin } : {}),
        ...(message.producer ? { producer: message.producer } : {}),
        ...(message.invocation ? { invocation: message.invocation } : {}),
        ...(message.submissionIds?.length ? { submissionIds: message.submissionIds } : {}),
        ...(message.replyRequired === true ? { replyRequired: true } : {}),
        ...(message.runtimeNotice === true ? { runtimeNotice: true } : {}),
        ...(message.framing ? { framing: message.framing === "conversation-tier" ? conversationTierFraming(message.content) : message.framing } : {}),
      };
    case "assistant":
      return {
        kind: "assistant",
        content: toConversationContent(message.content),
        ...(message.incomplete === true ? { incomplete: true } : {}),
        ...(message.accessProvider ? { accessProvider: message.accessProvider } : {}),
        ...(message.provider ? { provider: message.provider } : {}),
        ...(message.api ? { api: message.api } : {}),
        ...(message.model ? { model: message.model } : {}),
        ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
        ...(message.stopReason ? { stopReason: message.stopReason } : {}),
        ...(message.responseId ? { responseId: message.responseId } : {}),
        ...(message.reasoningTokens !== undefined ? { reasoningTokens: message.reasoningTokens } : {}),
      };
    case "toolResult":
      return {
        kind: "toolResult",
        toolUseId: message.toolUseId,
        content: [...message.content],
        ...(message.isError === true ? { isError: true } : {}),
        ...(message.interrupted === true ? { interrupted: true } : {}),
        ...(message.blocked === true ? { blocked: true } : {}),
      };
    case "system":
      return { kind: "system", content: message.content, ...("contentRepair" in message ? { contentRepair: message.contentRepair } : {}) };
    case "compactionSummary":
      return { kind: "compactionSummary", content: message.content };
  }
}

/** The framing of an entry that a build before 2026-10-27 labeled `conversation-tier`: a hosted agent's system tier,
 *  which the shared host wrapped as a system reminder, or else its tool notice. Remove after 2027-04-27. */
function conversationTierFraming(content: Extract<PersistedMessage, { kind: "user" }>["content"]): "agent-host" | "tool-notice" {
  return typeof content === "string" && content.startsWith("<system-reminder>\n") ? "agent-host" : "tool-notice";
}

/**
 * Labels the request framing of hidden entries that earlier builds wrote without it or with a label they no longer
 * carry, in the messages that the reader returns; the stored bytes keep their shape. The Claude reminders read as
 * `claude` and `reminder` here (`historicalReminderFraming`), and each installed module labels the entries that it wrote
 * (`ModuleHistoricalFraming`): builds before 2026-10-26 wrote them without a label, and builds before 2026-10-27 wrote
 * the shared engine host's text as `claude`. So a request that the host does not serve and a fork leave them out.
 * Remove this conversion after 2027-04-27.
 * @yields {void} A boundary between two messages, where the runner can give the task queue a turn.
 */
function* labelHistoricalFraming(messages: ConversationMessage[]): Generator<void, ConversationMessage[]> {
  let modules: readonly ModuleHistoricalFraming[] | undefined;
  for (const [index, message] of messages.entries()) {
    yield;
    if (message.kind !== "user" || message.origin !== "system" || (message.framing !== undefined && message.framing !== "claude") || typeof message.content !== "string") continue;
    let framing: ReturnType<ModuleHistoricalFraming> = historicalReminderFraming(message, message.content);
    modules ??= installedModules().flatMap((module) => module.sessionHistory?.framing ?? []);
    for (const read of modules) framing ??= read(message.content, messages[index + 1]);
    framing ??= message.framing;
    if (framing !== message.framing) messages[index] = { ...message, ...(framing ? { framing } : {}) };
  }
  return messages;
}

/** The framing of a Claude reminder that an earlier build wrote: `claude` for the model reminder, and `reminder` for
 *  an environment or date reminder, which builds before 2026-11-01 wrote with no label. Only an entry that the
 *  runtime wrote with no other label can be such a reminder: a background notification (`replyRequired`), a runtime
 *  notice, or another session's message is input whatever its bytes. Remove the `reminder` conversion after
 *  2027-05-01. */
function historicalReminderFraming(message: Extract<ConversationMessage, { kind: "user" }>, content: string): "claude" | "reminder" | undefined {
  const kind = parseRuntimeReminder(content)?.kind;
  if (kind === "model") return "claude";
  if (kind === undefined || message.framing !== undefined || message.producer !== undefined || message.runtimeNotice === true || message.replyRequired === true) return undefined;
  return "reminder";
}

export interface SessionContext {
  messages: ConversationMessage[];
}

export class AssistantPrefillSessionContextError extends Error {
  constructor() {
    super("buildSessionContext: provider context must end with a user message, not assistant prefill");
    this.name = "AssistantPrefillSessionContextError";
  }
}

export type BranchWalkGap =
  | { kind: "leaf"; leafEntryId: string }
  | { kind: "parent"; childId: string; parentId: string };

/**
 * Walk the immutable parent chain from a leaf entry to the root, returning the
 * branch root-first. Entries never mutate once written, so this reproduces the
 * branch as it existed when the leaf was the tip, independent of later appends
 * or compaction.
 *
 * A missing leaf or a dangling parent reference signals corruption; the caller
 * maps the gap to its own error type via `onGap`.
 */
export function walkBranchFromLeaf(
  entriesById: StringMap<ConversationEntry>,
  leafEntryId: string | null,
  onGap: (gap: BranchWalkGap) => never,
): ConversationEntry[] {
  return runToCompletion(walkBranchWork(entriesById, leafEntryId, onGap));
}

/** Cooperative form of `walkBranchFromLeaf`. With `contextOnly`, the walk stops
 * at the source leaf of the latest compaction, because provider context reads
 * nothing older than that boundary. */
export function* walkBranchWork(
  entriesById: Readonly<StringMap<ConversationEntry>>,
  leafEntryId: string | null,
  onGap: (gap: BranchWalkGap) => never,
  contextOnly = false,
): Generator<void, ConversationEntry[]> {
  if (leafEntryId === null) return [];
  const reversed: ConversationEntry[] = [];
  let current: ConversationEntry | undefined = entriesById[leafEntryId];
  if (!current) onGap({ kind: "leaf", leafEntryId });
  let stopAtId: string | null = null;
  while (current) {
    yield;
    reversed.push(current);
    if (contextOnly && stopAtId === null && current.kind === "compaction") stopAtId = current.sourceLeafId;
    if (stopAtId !== null && current.id === stopAtId) break;
    if (current.parentId === null) break;
    const parent: ConversationEntry | undefined = entriesById[current.parentId];
    if (!parent) onGap({ kind: "parent", childId: current.id, parentId: current.parentId });
    current = parent;
  }
  // A native reverse of entry references costs microseconds even for long histories.
  reversed.reverse();
  return reversed;
}

function entryToMessage(entry: ConversationEntry | DegradedTranscriptRecord): ConversationMessage | undefined {
  if (entry.kind === "degraded") {
    return {
      kind: "user",
      origin: "system",
      content: `<conversationHistoryGap provenance="degraded" position="${entry.event.position}" version="${entry.event.version}" type="${entry.event.type}"${entry.sourceEntryId === undefined ? "" : ` entry="${entry.sourceEntryId}"`}>${JSON.stringify(entry.raw)}</conversationHistoryGap>`,
    };
  }
  if (entry.kind === "message") {
    // Display-only entries are persisted for inspection (e.g. system errors
    // surfaced to the user) but excluded from the model-visible context so
    // they never re-enter prompts on resume.
    if (entry.displayOnly === true) return undefined;
    return persistedToConversationMessage(entry.message);
  }
  if (entry.kind === "branch_summary") {
    return {
      kind: "user",
      origin: "system",
      content: `<branchSummary fromId="${entry.fromId}">${entry.summary}</branchSummary>`,
    };
  }
  return undefined;
}

function compactionMessage(entry: Extract<CompactionEntry, { summary: string }>): ConversationMessage {
  return {
    kind: "compactionSummary",
    content: entry.summary,
  };
}

export interface BuildSessionContextOptions {
  /** Skip the trailing-user check. That rule is a provider-request
   *  constraint (see validateTrailingUser); the loop's working history
   *  legitimately ends on an assistant message between turns, so loop-state
   *  rebuilds (compaction record/install) opt out. Adjacency validation
   *  still applies. */
  allowAssistantTail?: boolean;
}

/** Reconstruct provider messages from raw branch entries without repairing or
 * validating their adjacency. Consumers that copy history must validate this
 * result before any repair can hide malformed persisted structure.
 * @yields {void} A boundary between two entries or messages, where the runner can give the task queue a turn. */
export function* reconstructRawSessionMessages(branch: readonly (ConversationEntry | DegradedTranscriptRecord)[]): Generator<void, ConversationMessage[]> {
  return yield* labelHistoricalFraming(yield* assembleRawSessionMessages(branch));
}

function* assembleRawSessionMessages(branch: readonly (ConversationEntry | DegradedTranscriptRecord)[]): Generator<void, ConversationMessage[]> {
  const compaction = yield* findLatestCompaction(branch);
  const messages: ConversationMessage[] = [];

  if (compaction) {
    if (compaction.entry.mode !== "reset") {
      for (const message of compaction.entry.retainedMessages) {
        yield;
        messages.push({ ...message });
      }
      messages.push(compactionMessage(compaction.entry));
    }
    const sourceIndex = yield* findSourceIndex(branch, compaction.index, compaction.entry.sourceLeafId);
    const suffix = branch.slice(sourceIndex + 1, compaction.index);
    const after = branch.slice(compaction.index + 1);
    for (const entry of suffix) {
      yield;
      const m = entryToMessage(entry);
      if (m) messages.push(m);
    }
    for (const entry of after) {
      yield;
      const m = entryToMessage(entry);
      if (m) messages.push(m);
    }
    return messages;
  }

  for (const entry of branch) {
    yield;
    const message = entryToMessage(entry);
    if (message) messages.push(message);
  }
  return messages;
}

/** Validate forkable history before repair. A settled assistant tail is a
 * complete conversation boundary and is therefore accepted.
 * @yields {void} A boundary between two entries or messages, where the runner can give the task queue a turn. */
function* validateRawForkMessages(messages: readonly ConversationMessage[]): Generator<void, void> {
  yield* validateToolAdjacency(messages);
  yield* validateAssistantAdjacency(messages);
}

/** Validate every copied history segment and the context rebuilt across its
 * latest compaction boundary.
 * @yields {void} A boundary between two entries or messages, where the runner can give the task queue a turn. */
export function* validateRawForkBranchWork(branch: readonly ConversationEntry[]): Generator<void, ConversationMessage[]> {
  let segment: ConversationMessage[] = [];
  for (const entry of branch) {
    yield;
    if (entry.kind === "compaction") {
      yield* validateRawForkMessages(segment);
      segment = [];
      continue;
    }
    const message = entryToMessage(entry);
    if (message) segment.push(message);
  }
  yield* validateRawForkMessages(segment);
  const rebuilt = yield* reconstructRawSessionMessages(branch);
  yield* validateRawForkMessages(rebuilt);
  return rebuilt;
}

/** Build a fork seed from committed history. A running tool turn can have a
 * durable assistant call plus a proper subset of its results; that whole
 * exchange is not yet history for a child and is excluded as one suffix.
 * Every retained entry remains subject to strict raw validation.
 * @yields {void} A boundary between two entries or messages, where the runner can give the task queue a turn. */
export function* buildCommittedForkMessagesWork(branch: readonly ConversationEntry[]): Generator<void, ConversationMessage[]> {
  const openExchange = yield* openToolExchangeSuffixWork(branch);
  return yield* validateRawForkBranchWork(openExchange === null ? branch : branch.slice(0, openExchange.index));
}

export interface OpenToolExchange {
  readonly index: number;
  readonly toolUseIds: ReadonlySet<string>;
}

/** Returns the assistant-owned tool IDs when the current branch leaf is an
 * incomplete live exchange. Display-only recovery evidence does not close it. */
export function openToolExchangeSuffix(branch: readonly ConversationEntry[]): OpenToolExchange | null {
  return runToCompletion(openToolExchangeSuffixWork(branch));
}

function* openToolExchangeSuffixWork(branch: readonly ConversationEntry[]): Generator<void, OpenToolExchange | null> {
  const resultIds: string[] = [];
  let index = branch.length - 1;
  while (index >= 0) {
    yield;
    const entry = branch[index];
    if (!entry) {
      index -= 1;
      continue;
    }
    if (entry.kind === "message" && entry.displayOnly === true) {
      index -= 1;
      continue;
    }
    const message = entryToMessage(entry);
    if (message?.kind === "toolResult") {
      resultIds.push(message.toolUseId);
      index -= 1;
      continue;
    }
    if (message?.kind !== "assistant") return null;
    const toolUseIds = toolUseIdsForMessage(message);
    if (toolUseIds.length === 0) return null;
    const expected = new Set(toolUseIds);
    if (expected.size !== toolUseIds.length) return null;
    const actual = new Set(resultIds);
    const properSubset = actual.size === resultIds.length
      && actual.size < expected.size
      && resultIds.every((id) => expected.has(id));
    return properSubset ? { index, toolUseIds: expected } : null;
  }
  return null;
}

export function buildSessionContext(branch: Array<ConversationEntry | DegradedTranscriptRecord>, options?: BuildSessionContextOptions): SessionContext {
  return runToCompletion(buildSessionContextWork(branch, options));
}

/** Cooperative form of `buildSessionContext`, for callers that compose it into one sliced operation.
 * @yields {void} A boundary between two entries or messages, where the runner can give the task queue a turn. */
export function* buildSessionContextWork(branch: readonly (ConversationEntry | DegradedTranscriptRecord)[], options?: BuildSessionContextOptions): Generator<void, SessionContext> {
  return yield* finalizeMessages(yield* reconstructRawSessionMessages(branch), options?.allowAssistantTail === true);
}

function* findLatestCompaction(branch: readonly (ConversationEntry | DegradedTranscriptRecord)[]): Generator<void, { entry: CompactionEntry; index: number } | null> {
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    yield;
    const entry = branch[i];
    if (entry?.kind === "compaction") return { entry, index: i };
  }
  return null;
}

function* findSourceIndex(branch: readonly (ConversationEntry | DegradedTranscriptRecord)[], compactionIndex: number, sourceLeafId: string): Generator<void, number> {
  for (let i = compactionIndex - 1; i >= 0; i -= 1) {
    yield;
    const item = branch[i];
    if (item?.kind !== "degraded" && item?.id === sourceLeafId) return i;
  }
  throw new Error(
    `buildSessionContext: compaction at index ${compactionIndex} has sourceLeafId ${sourceLeafId} which is not in the active branch`,
  );
}

function* finalizeMessages(messages: ConversationMessage[], allowAssistantTail: boolean): Generator<void, SessionContext> {
  const finalized = yield* repairToolAdjacencyWork(messages);
  // Validator order is load-bearing: the write gate
  // (ConversationTree.rejectInvalidExtension) tolerates only
  // AssistantPrefillSessionContextError as the benign mid-conversation state.
  // If the trailing-user check ran first, a batch that is BOTH internally
  // corrupt and assistant-trailing would read as benign prefill and land on
  // disk, so adjacency validation must precede it.
  yield* validateToolAdjacency(finalized);
  yield* validateAssistantAdjacency(finalized);
  if (!allowAssistantTail) validateTrailingUser(finalized);
  return { messages: finalized };
}


// Adjacency is judged on the alternating subsequence: a system notice between
// two assistant messages does not separate them on the wire, so it must not
// hide a lost user turn from this check.
function* validateAssistantAdjacency(messages: readonly ConversationMessage[]): Generator<void, void> {
  let previous: { message: ConversationMessage; index: number } | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    yield;
    const current = messages[index];
    if (!current || current.kind === "system") continue;
    if (
      previous
      && conversationRole(previous.message) === "assistant"
      && conversationRole(current) === "assistant"
      && !isIncompleteTextAssistant(previous.message)
    ) {
      throw new Error(`buildSessionContext: adjacent assistant messages at ${previous.index} and ${index} would violate provider role alternation`);
    }
    previous = { message: current, index };
  }
}

// A settled assistant tail is invalid provider prefill. An incomplete text
// assistant is canonical history and marks a recoverable provider boundary.
// Transcript-level system notices sit outside provider role alternation, so
// only the trailing alternating message determines whether the request can start.
function validateTrailingUser(messages: readonly ConversationMessage[]): void {
  const last = trailingAlternatingMessage(messages);
  if (last === undefined && messages.length > 0) throw new AssistantPrefillSessionContextError();
  if (!last || conversationRole(last) === "user" || isIncompleteTextAssistant(last)) return;
  throw new AssistantPrefillSessionContextError();
}

function isIncompleteTextAssistant(message: ConversationMessage): boolean {
  return message.kind === "assistant" && message.incomplete === true && toolUseIdsForMessage(message).length === 0;
}

function* validateToolAdjacency(messages: readonly ConversationMessage[]): Generator<void, void> {
  let pendingToolUseIds: Set<string> | null = null;
  let pendingAssistantIndex = -1;

  let index = 0;
  while (index < messages.length) {
    yield;
    const message = messages[index];
    if (!message) {
      index += 1;
      continue;
    }

    if (message.kind === "toolResult") {
      if (!pendingToolUseIds) {
        throw new Error(`buildSessionContext: unexpected toolResult message at ${index} without a preceding assistant tool_use message`);
      }
      const run = collectToolResultRun(messages, index);
      assertToolResultsMatch(run.start, pendingAssistantIndex, pendingToolUseIds, run.resultIds);
      pendingToolUseIds = null;
      pendingAssistantIndex = -1;
      index = run.nextIndex;
      continue;
    }

    if (pendingToolUseIds) {
      throw new Error(
        `buildSessionContext: assistant message ${pendingAssistantIndex} has tool_use blocks without an immediate following toolResult run`,
      );
    }

    const toolUseIds = toolUseIdsForMessage(message);
    if (toolUseIds.length > 0 && message.kind !== "assistant") {
      throw new Error(`buildSessionContext: tool_use blocks at message ${index} must belong to an assistant message`);
    }
    if (toolUseIds.length > 0) {
      const unique = new Set(toolUseIds);
      if (unique.size !== toolUseIds.length) {
        throw new Error(`buildSessionContext: assistant message ${index} contains duplicate tool_use ids`);
      }
      pendingToolUseIds = unique;
      pendingAssistantIndex = index;
    }
    index += 1;
  }

  if (pendingToolUseIds) {
    throw new Error(`buildSessionContext: assistant message ${pendingAssistantIndex} ends the context with unresolved tool_use blocks`);
  }
}

function collectToolResultRun(messages: readonly ConversationMessage[], start: number) {
  const resultIds: string[] = [];
  let nextIndex = start;
  while (nextIndex < messages.length) {
    const message = messages[nextIndex];
    if (!message || message.kind !== "toolResult") break;
    resultIds.push(message.toolUseId);
    nextIndex += 1;
  }
  return { start, nextIndex, resultIds };
}

function toolUseIdsForMessage(message: ConversationMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((block) => block.type === "tool_use").map((block) => block.id);
}

function assertToolResultsMatch(
  runIndex: number,
  assistantIndex: number,
  expected: ReadonlySet<string>,
  actualIds: readonly string[],
): void {
  const actual = new Set(actualIds);
  if (actual.size !== actualIds.length) {
    throw new Error(`buildSessionContext: toolResult run at ${runIndex} contains duplicate toolUse ids`);
  }
  const missing = [...expected].filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expected.has(id));
  if (missing.length === 0 && unexpected.length === 0) return;
  throw new Error(
    `buildSessionContext: toolResult run at ${runIndex} ids do not match assistant message ${assistantIndex} tool_use ids; missing=[${missing.join(",")}], unexpected=[${unexpected.join(",")}]`,
  );
}
interface StringMap<T> { [key: string]: T }
