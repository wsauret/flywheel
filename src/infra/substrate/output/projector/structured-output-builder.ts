import {
  type AnyBlock,
  type AgentFailureDisplay,
  type StreamPhase,
  type QuestionEntry,
  type PausedBy,
  type SystemMessageOptions,
  type ToolEntry,
  type ToolPresentation,
  type UserMessageImage,
  type UserMessageBlock,
  type MessageSender,
  type ProvisionalDiff,
  type ToolStreamingText,
  isVisibleMessageBlock,
} from "../../events/output-blocks.js";
import { formatAgentFailureDisplay } from "../output-formatter.js";
import { randomUUID } from "node:crypto";
import { Log } from "../../../diagnostics/log.js";
import { EMPTY_OUTPUT_CHANGE_BATCH, NO_CHANGED_TOOLS, type OutputBlockChange, type OutputChangeBatch } from "../output-block-delta.js";
import { StreamingToolTextStore } from "../streaming/streaming-tool-text.js";
import { appendKeyedDelta } from "./structured-output-grouping.js";
import { contentKey, definedProps, rebuildBlockIndexes } from "./structured-output-helpers.js";
import { resetFailedFileChange } from "./file-change-settlement.js";
import { resolveToolRowPresentation } from "../tools/tool-display-registry.js";
import type { StandaloneToolSink } from "../tools/types.js";
import {
  type AgentBlockIdentity,
  type CompleteAgentMeta,
  cancelAgentBlock,
  completeAgentBlock,
  dispatchAgentBlock,
  queueAgentBlock,
  errorAgentBlock,
  interruptAgentBlock,
  pauseAgentBlock,
  setAgentLinkBlock,
  setAgentModelBlock,
  startAgentBlock,
  transitionOpenAgentBlocks,
  updateAgentMetaBlock,
} from "./structured-output-agents.js";
import {
  drainQueuedUserMessages,
  enforceOutputBlockCap,
  hasQueuedUserMessage,
  insertOutputBlock,
  type OutputBuilderIndexes,
  patchStandaloneTool,
  pushQuestionBlock,
  updateQuestionBlock,
} from "./structured-output-state.js";

const log = Log.create({ service: "output-builder" });

const BLOCKS_CAP = 20_000;

type QuestionAnswers = { [questionId in string]: string };

/** The fields a call's input settles on its row as the input streams or
 *  completes. An absent field keeps the row's current value. */
export type ToolInputFields = Partial<Pick<ToolEntry, "presentation" | "sentence" | "invocationBody" | "linkUri" | "diff" | "content" | "filetype" | "fileChangeKind" | "declaresMutation" | "targetSessionId" | "proposedDiff">>;

/** The live phase of the current model response. `since` is when the work
 *  that the next new thinking block shows began: the start of the model call
 *  or of thinking. The first thinking block claims it (null), and every move
 *  to another phase ends it with the phase. */
type ResponsePhase =
  | { readonly kind: "waiting" | "thinking"; readonly since: number | null }
  | { readonly kind: "generating" | "tool_executing" };

/** What moves the response phase. `entered` is a phase the projector drives,
 *  `ended` closes the response, and `claimed` is a new block that takes the
 *  anchor, so the next new thinking block starts at its own time. */
type ResponsePhaseEvent =
  | { readonly kind: "entered"; readonly phase: StreamPhase; readonly at: number }
  | { readonly kind: "ended" }
  | { readonly kind: "claimed" };

const anchorOf = (phase: ResponsePhase | null): number | null =>
  phase !== null && "since" in phase ? phase.since : null;

/** The one transition of the response phase. */
function nextResponsePhase(current: ResponsePhase | null, event: ResponsePhaseEvent): ResponsePhase | null {
  if (event.kind === "ended") return null;
  if (event.kind === "claimed") return current !== null && "since" in current ? { kind: current.kind, since: null } : current;
  switch (event.phase) {
    case "waiting": return { kind: "waiting", since: event.at };
    case "thinking": return { kind: "thinking", since: anchorOf(current) ?? event.at };
    default: return { kind: event.phase };
  }
}

export class StructuredOutputBuilder implements StandaloneToolSink {
  /** `onChange` hears that the blocks changed; with none, the builder neither
   *  notifies nor records changes for drainChanges. `blocksCap` is a test seam:
   *  eviction wiring is identical at any cap, and exceeding the production 20k
   *  in a test is seconds of pure allocation. */
  constructor(options: { readonly onChange?: () => void; readonly blocksCap?: number } = {}) {
    this.onChange = options.onChange ?? null;
    this.blocksCap = options.blocksCap ?? BLOCKS_CAP;
  }
  private readonly blocksCap: number;
  // Mints the stable id for blocks that carry no natural one (system/
  // divider/userMessage and provider-less tools): a uuid, unique across
  // reactivation seeds with no counter to resume.
  private readonly mintId: () => string = () => randomUUID();
  private blocks: AnyBlock[] = [];
  private _visibleMessageCountSuffix = 0;
  private changePending = false;
  private readonly streamingText = new StreamingToolTextStore(() => this.notifyChange());
  private agentIndexById = new Map<string, number>();
  private contentIndexById = new Map<string, number>();
  // Top-level tool blocks by their stable id, maintained beside the agent and
  // content maps so late result metadata (a recorded execution-output tail)
  // resolves without scanning the whole block array. Kept local to this class
  // because insertOutputBlock only shifts the helper-owned maps.
  private toolIndexById = new Map<string, number>();
  // The ids of the thinking rows that still stream. Only pushThinking opens
  // one and a seed can carry one, so completing thinking visits these rows
  // and never the transcript.
  private openThoughts = new Set<string>();
  // The absolute index of blocks[0] in the session's output sequence. Every
  // change is minted in that coordinate (ARCH-PROTOCOL-054), so no consumer
  // translates it.
  private sequenceStart = 0;
  private phase: ResponsePhase | null = null;
  private _streamingOutputChars = 0;
  // Changes are recorded at the write site instead of reconstructed later by
  // diffing full snapshots. `needsFullResync` covers rare structural rewrites
  // (cap eviction, retraction, queued-message recall), where reindexing every
  // already-queued change costs more than having drainChanges' consumer resend
  // the current block array from the session's base offset.
  private pendingChanges: OutputBlockChange[] = [];
  private needsFullResync = false;
  private onChange: (() => void) | null;
  private changeHolds = 0;
  private changeHeld = false;
  /** Stops notification and change recording for good: the listener's owner
   *  has gone, and nobody drains the changes again. */
  dispose(): void {
    this.onChange = null;
  }
  private notifyChange(): void {
    // No listener: don't arm the latch. A notification fired into the void
    // would otherwise suppress every later one until getBlocks() re-arms,
    // silencing changes that happen before a consumer wires onChange.
    if (!this.onChange) return;
    if (this.changeHolds > 0) { this.changeHeld = true; return; }
    if (this.changePending) return; // listeners already know; the pending period ends when they read getBlocks()
    this.changePending = true;
    this.onChange();
  }
  /** Runs `mutate` as one change: the listener hears it once, after the last
   *  step. A listener may read the builder as soon as it hears a change, so
   *  a notification between two steps would show it a state that no event
   *  produced, such as a new stream phase without the characters of the
   *  delta that started it. */
  asOneChange(mutate: () => void): void {
    this.changeHolds++;
    try {
      mutate();
    } finally {
      this.changeHolds--;
      if (this.changeHolds === 0 && this.changeHeld) {
        this.changeHeld = false;
        this.notifyChange();
      }
    }
  }
  // No listener: nobody will ever call drainChanges(), so buffering deltas
  // is pure waste - same reasoning as notifyChange's own guard. Without
  // this, an unwired builder (e.g. a stress test pushing tens of thousands
  // of blocks with no consumer) pays real GC pressure retaining a full-batch
  // worth of block references for nothing.
  private recordBlock(kind: "upsert" | "insert", index: number): void {
    if (!this.onChange || this.needsFullResync) return;
    const block = this.blocks[index];
    if (block) this.pendingChanges.push({ kind, index: this.sequenceStart + index, block });
  }
  private recordAppend(index: number, text: string): void {
    if (!this.onChange || this.needsFullResync) return;
    const block = this.blocks[index];
    if (!block || (block.kind !== "text" && block.kind !== "thinking")) return;
    this.pendingChanges.push({
      kind: "append-content",
      index: this.sequenceStart + index,
      identity: { kind: block.kind, id: block.id },
      contentOffset: block.content.length - text.length,
      text,
    });
  }
  // Structural rewrites (cap eviction, retraction, recall) can shift or drop
  // indices already recorded this batch; reindexing them is not worth the
  // complexity, so the whole batch degrades to a full resync - the same
  // graceful-degradation shape the diffing pipeline this replaces relied on
  // for structural rewrites.
  private recordStructuralChange(): void {
    if (!this.onChange) return;
    this.pendingChanges = [];
    this.needsFullResync = true;
  }
  /** Reads and clears the changes minted since the last drain. The app-service
   *  output projection is the sole consumer; each batch is meant to be
   *  applied once. */
  drainChanges(): OutputChangeBatch {
    // A full resync measures every tool, so it names none; the drain still
    // clears the marks it covers.
    const changed = this.streamingText.drainChanged();
    const changedTools = this.needsFullResync ? NO_CHANGED_TOOLS : changed;
    if (this.pendingChanges.length === 0 && !this.needsFullResync && changedTools.size === 0) return EMPTY_OUTPUT_CHANGE_BATCH;
    const batch: OutputChangeBatch = { changes: this.pendingChanges, fullResync: this.needsFullResync, changedTools };
    this.pendingChanges = [];
    this.needsFullResync = false;
    return batch;
  }
  get streamPhase(): StreamPhase | null { return this.phase?.kind ?? null; }
  get streamingOutputChars(): number { return this._streamingOutputChars; }
  get visibleMessageCountSuffix(): number { return this._visibleMessageCountSuffix; }
  addStreamingChars(count: number): void {
    this._streamingOutputChars += count;
    this.notifyChange();
  }
  /** The live text of every tool that is writing its input or output: one
   *  cached, read-only map per state, so a changed identity means changed text. */
  get streamingToolText(): Readonly<{ [toolUseId in string]: ToolStreamingText }> { return this.streamingText.snapshot(); }
  /** Appends one chunk of a tool's streamed input body to its live text. */
  appendToolText(toolUseId: string, text: string, filetype?: string): void {
    this.streamingText.append(toolUseId, text, filetype);
  }
  /** Sets a tool's whole live text: an execution-output tail arrives
   *  cumulative, not chunked. */
  replaceToolText(toolUseId: string, text: string): void {
    this.streamingText.replace(toolUseId, text);
  }
  /** Shows the diff that a streaming edit proposes in place of its text. */
  proposeToolDiff(toolUseId: string, proposedDiff: ProvisionalDiff): void {
    this.streamingText.setProposedDiff(toolUseId, proposedDiff);
  }
  /** Sets the advice of a proposed edit's preview check; null removes it. */
  setToolPreviewCheck(toolUseId: string, advice: string | null): void {
    if (advice === null) this.streamingText.clearPreviewCheck(toolUseId);
    else this.streamingText.setPreviewCheck(toolUseId, advice);
  }
  /** Ends a tool's live text. */
  clearToolText(toolUseId: string): void {
    this.streamingText.clear(toolUseId);
  }
  /** Ends a tool's live text without a notification of its own: the row
   *  change that the caller makes next publishes it. */
  clearToolTextSilently(toolUseId: string): void {
    this.streamingText.clearSilently(toolUseId);
  }
  /** Ends the live text of every tool. */
  clearAllToolText(): void {
    this.streamingText.clearAll();
  }
  setStreamPhase(phase: StreamPhase | null, timestamp: number): void {
    const before = this.phase?.kind ?? null;
    this.phase = nextResponsePhase(this.phase, phase === null ? { kind: "ended" } : { kind: "entered", phase, at: timestamp });
    if (before === phase) return;
    log.debug("phase transition", { from: before, to: phase });
    this.notifyChange();
  }
  resetPhase(): void {
    this.phase = nextResponsePhase(this.phase, { kind: "ended" });
    this._streamingOutputChars = 0;
    this.notifyChange();
  }
  /** Completes every thinking row that still streams. */
  completeThinking(timestamp = Date.now()): void {
    if (this.openThoughts.size === 0) return;
    let changed = false;
    for (const id of this.openThoughts) {
      const index = this.contentIndexById.get(contentKey("thinking", id));
      const block = index === undefined ? undefined : this.blocks[index];
      if (index === undefined || block?.kind !== "thinking" || block.status !== "streaming") continue;
      this.blocks[index] = { ...block, status: "completed", completedAt: timestamp };
      this.recordBlock("upsert", index);
      changed = true;
    }
    this.openThoughts.clear();
    if (changed) this.notifyChange();
  }
  /** Appends `text` to thought row `blockKey`. Blank text never creates a
   *  row, but it is part of the thought once the row exists, so the row
   *  holds the text that its settled part records. */
  pushThinking(text: string, timestamp: number, blockKey: string): void {
    if (!text.trim() && !this.contentIndexById.has(contentKey("thinking", blockKey))) { this.notifyChange(); return; }
    const blockTimestamp = anchorOf(this.phase) ?? timestamp;
    this.phase = nextResponsePhase(this.phase, { kind: "claimed" });
    const result = appendKeyedDelta(
      this.blocks,
      this.contentIndexById,
      "thinking",
      blockKey,
      text,
      (id, content) => ({ kind: "thinking", id, content, status: "streaming", timestamp: blockTimestamp }),
      (block) => this.insertBlock(block),
    );
    if (result?.created) this.openThoughts.add(blockKey);
    else if (result) this.recordAppend(result.index, text);
    this.notifyChange();
  }
  pushUserMessage(text: string, timestamp: number, pending = false, injected = false, submissionIds?: readonly string[], images?: readonly UserMessageImage[], from?: MessageSender, dispatchIds?: readonly string[], entryId?: string): void {
    this.completeThinking(timestamp);
    this.insertBlock({ kind: "userMessage", id: entryId ?? this.mintId(), content: text, timestamp, pending, injected, ...(submissionIds?.length ? { submissionIds } : {}), ...(dispatchIds?.length ? { dispatchIds } : {}), ...(images?.length ? { images } : {}), ...(from ? { from } : {}) });
    this.notifyChange();
  }
  hasQueued(): boolean {
    return hasQueuedUserMessage(this.indexes());
  }
  /** Marks matching queued rows sent, or all rows without an identity filter,
   *  and returns only the person's texts, never another session's message. */
  drainQueued(identity?: Pick<UserMessageBlock, "submissionIds" | "dispatchIds">): string[] {
    const drained = drainQueuedUserMessages(this.indexes(), identity);
    if (drained.length === 0) return [];
    for (const { index } of drained) {
      this._visibleMessageCountSuffix++;
      this.recordBlock("upsert", index);
    }
    this.notifyChange();
    return drained.filter(({ person }) => person).map(({ text }) => text);
  }
  /** Removes exactly the queued row whose input is being withdrawn. */
  withdrawQueued(dispatchIds: readonly string[]): (() => void) | null {
    const index = this.blocks.findIndex((block) => block.kind === "userMessage" && block.pending && block.dispatchIds?.some((id) => dispatchIds.includes(id)));
    const block = this.blocks[index];
    if (index < 0 || !block) return null;
    const following = this.blocks[index + 1];
    this.blocks.splice(index, 1);
    const changed = () => {
      rebuildBlockIndexes(this.blocks, this.agentIndexById, this.contentIndexById);
      this.rebuildToolIndex();
      this.recordStructuralChange();
      this.notifyChange();
    };
    changed();
    return () => {
      const next = following ? this.blocks.indexOf(following) : -1;
      this.blocks.splice(next < 0 ? Math.min(index, this.blocks.length) : next, 0, block);
      changed();
    };
  }
  pushText(text: string, timestamp: number, blockKey: string): void {
    this.completeThinking(timestamp);
    this._streamingOutputChars += text.length;
    this.phase = nextResponsePhase(this.phase, { kind: "claimed" });
    const result = appendKeyedDelta(
      this.blocks,
      this.contentIndexById,
      "text",
      blockKey,
      text,
      (id, content) => ({ kind: "text", id, content, timestamp }),
      (block) => this.insertBlock(block),
    );
    if (!result) return;
    if (!result.created) this.recordAppend(result.index, text);
    this.notifyChange();
  }
  insertTextBeforeTool(toolUseId: string, text: string, timestamp: number, blockKey: string): void {
    if (this.contentIndexById.has(contentKey("text", blockKey))) {
      this.replaceText(blockKey, text);
      return;
    }
    const toolIndex = this.toolIndexById.get(toolUseId);
    if (toolIndex === undefined) return;
    this.completeThinking(timestamp);
    this._streamingOutputChars += text.length;
    this.phase = nextResponsePhase(this.phase, { kind: "claimed" });
    this.blocks.splice(toolIndex, 0, { kind: "text", id: blockKey, content: text, timestamp });
    this._visibleMessageCountSuffix++;
    rebuildBlockIndexes(this.blocks, this.agentIndexById, this.contentIndexById);
    this.rebuildToolIndex();
    this.recordBlock("insert", toolIndex);
    this.notifyChange();
  }
  /** Corrects one public run without changing its identity or position. */
  replaceText(blockKey: string, content: string): void {
    this.replaceContent("text", blockKey, content);
  }
  /** Corrects one thought without changing its identity or position, so the
   *  row a client shows for it stays mounted. */
  replaceThinking(blockKey: string, content: string): void {
    this.replaceContent("thinking", blockKey, content);
  }
  /** The text that row `blockKey` of `kind` holds, or undefined when the
   *  builder has no such row. */
  contentOf(kind: "text" | "thinking", blockKey: string): string | undefined {
    const index = this.contentIndexById.get(contentKey(kind, blockKey));
    const block = index === undefined ? undefined : this.blocks[index];
    return block?.kind === kind ? block.content : undefined;
  }
  private replaceContent(kind: "text" | "thinking", blockKey: string, content: string): void {
    const index = this.contentIndexById.get(contentKey(kind, blockKey));
    const block = index === undefined ? undefined : this.blocks[index];
    if (index === undefined || block?.kind !== kind || block.content === content) return;
    this._streamingOutputChars += content.length - block.content.length;
    this.blocks[index] = { ...block, content };
    this.recordBlock("upsert", index);
    this.notifyChange();
  }
  pushSystemMessage(message: string, timestamp: number, options?: SystemMessageOptions): void {
    if (options?.id && this.blocks.some((block) => block.kind === "system" && block.id === options.id)) return;
    this.completeThinking(timestamp);
    this.insertBlock({ kind: "system", id: options?.id ?? this.mintId(), message, timestamp, ...definedProps(options ?? {}) });
    this.enforceBlocksCap();
    this.notifyChange();
  }
  pushDivider(label: string, timestamp: number): void {
    this.completeThinking(timestamp);
    this.insertBlock({ kind: "divider", id: this.mintId(), label, timestamp });
    this.enforceBlocksCap();
    this.notifyChange();
  }
  pushTool(name: string, presentation: ToolPresentation, timestamp: number, diff?: string, filetype?: string, content?: string, linkUri?: string, streaming?: boolean): number {
    return this.pushStandaloneToolEntry({
      kind: "tool", id: this.mintId(), name, presentation, timestamp,
      status: streaming ? "streaming" : "pending",
      ...(linkUri ? { linkUri } : {}),
      ...(diff ? { diff } : {}),
      ...(content ? { content } : {}),
      ...(filetype ? { filetype } : {}),
    });
  }
  pushStandaloneToolEntry(tool: ToolEntry): number {
    this.completeThinking(tool.timestamp);
    const idx = this.insertBlock(tool);
    this.enforceBlocksCap();
    this.notifyChange();
    return idx;
  }
  startAgent(id: string, identity: AgentBlockIdentity, timestamp: number, toolUseId: string): void {
    this.completeThinking(timestamp);
    const replaceIndex = this.toolIndexById.get(toolUseId);
    startAgentBlock(this.indexes(), id, identity, timestamp, toolUseId, replaceIndex);
    const idx = this.agentIndexById.get(id);
    if (replaceIndex !== undefined) {
      this.toolIndexById.delete(toolUseId);
      this.recordBlock("upsert", replaceIndex);
    } else if (idx !== undefined) { this.shiftToolIndexesFrom(idx); this.recordBlock("insert", idx); }
    this.enforceBlocksCap();
    this.notifyChange();
  }
  completeAgent(id: string, duration: number, meta?: CompleteAgentMeta): void {
    const idx = completeAgentBlock(this.indexes(), id, duration, meta);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  interruptAgent(id: string, duration: number): void {
    const idx = interruptAgentBlock(this.indexes(), id, duration);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  pauseAgent(id: string, pausedBy: PausedBy): void {
    const idx = pauseAgentBlock(this.indexes(), id, pausedBy);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  cancelAgent(id: string, duration: number, status: "cancelled" | "stopped"): void {
    const idx = cancelAgentBlock(this.indexes(), id, duration, status);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  errorAgent(id: string, error: string | AgentFailureDisplay, duration?: number): void {
    const failure = typeof error === "string" ? formatAgentFailureDisplay(error) : error;
    const idx = errorAgentBlock(this.indexes(), id, failure, duration);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  errorTool(blockIndex: number, message: string, extra?: Partial<ToolEntry>): void {
    const block = this.blocks[blockIndex];
    if (!block || block.kind !== "tool") return;
    this.blocks[blockIndex] = resetFailedFileChange({ ...block, ...extra, status: "error", errorMessage: message });
    this.recordBlock("upsert", blockIndex);
    this.notifyChange();
  }
  blockTool(blockIndex: number, statusMessage: string): void {
    const idx = patchStandaloneTool(this.blocks, blockIndex, { status: "blocked", statusMessage });
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  interruptTool(blockIndex: number): void {
    const idx = patchStandaloneTool(this.blocks, blockIndex, { status: "interrupted" });
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  completeTool(blockIndex: number, extra?: Partial<ToolEntry>): void {
    const idx = patchStandaloneTool(this.blocks, blockIndex, { status: "completed", ...extra });
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  /** Patch an existing row at its indexed position. */
  patchTool(blockIndex: number, patch: Partial<ToolEntry>): void {
    const idx = patchStandaloneTool(this.blocks, blockIndex, patch);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  finalizeStandaloneTool(blockIndex: number, fields: ToolInputFields, inputComplete = false): void {
    const block = this.blocks[blockIndex];
    if (!block || block.kind !== "tool") return;
    if (block.status === "error") return;
    const status = block.status === "completed" || block.status === "interrupted" || block.status === "blocked"
      ? block.status
      : inputComplete || fields.content !== undefined || fields.diff !== undefined ? "pending" : block.status;
    const idx = patchStandaloneTool(this.blocks, blockIndex, { status, ...definedProps(fields) });
    if (idx !== null) this.recordBlock("upsert", idx);
    this.notifyChange();
  }
  updateAgentMeta(id: string, label?: string, description?: string, agentType?: string, sentence?: ToolPresentation): void {
    const idx = updateAgentMetaBlock(this.indexes(), id, label, description, agentType, sentence);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  setAgentModel(id: string, model: string): void {
    const idx = setAgentModelBlock(this.indexes(), id, model);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  setAgentLink(id: string, linkUri: string): void {
    const idx = setAgentLinkBlock(this.indexes(), id, linkUri);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  dispatchAgent(id: string): void {
    const idx = dispatchAgentBlock(this.indexes(), id);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  queueAgent(id: string): void {
    const idx = queueAgentBlock(this.indexes(), id);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  pushQuestion(toolUseId: string, questions: QuestionEntry[], timestamp: number): number {
    this.completeThinking(timestamp);
    // The question shares the provisional row's identity (blockIdentity keys
    // both as tool:<toolUseId>), so this is an in-place upsert every client
    // applies without a repave.
    const provisionalIndex = this.blocks.findIndex((block) => block.kind === "tool" && block.id === toolUseId);
    if (provisionalIndex >= 0) {
      const provisional = this.blocks[provisionalIndex];
      const sentence = provisional?.kind === "tool" ? provisional.sentence : undefined;
      this.blocks[provisionalIndex] = { kind: "question", toolUseId, questions, timestamp, ...(sentence === undefined ? {} : { sentence }) };
      this.rebuildToolIndex();
      this.recordBlock("upsert", provisionalIndex);
      this.notifyChange();
      return provisionalIndex;
    }
    const idx = pushQuestionBlock(this.indexes(), toolUseId, questions, timestamp);
    this.blocks[idx] = { kind: "question", toolUseId, questions, timestamp, sentence: resolveToolRowPresentation("ask_user", {}, "").sentence };
    this.shiftToolIndexesFrom(idx);
    this.recordBlock("insert", idx);
    this.enforceBlocksCap();
    this.notifyChange();
    return idx;
  }
  answerQuestion(toolUseId: string, answers: QuestionAnswers): void {
    this.updateQuestion(toolUseId, { answers });
  }
  cancelQuestion(toolUseId: string): void {
    this.updateQuestion(toolUseId, { cancelled: true });
  }
  private updateQuestion(toolUseId: string, patch: { answers?: QuestionAnswers; cancelled?: true }): void {
    const idx = updateQuestionBlock(this.blocks, toolUseId, patch);
    if (idx !== null) { this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  closePendingAgentBlocks(timestamp: number): void {
    const changed = transitionOpenAgentBlocks(this.indexes(), null, timestamp, "complete");
    if (changed.length > 0) { for (const idx of changed) this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  interruptPendingAgentBlocks(timestamp: number): void {
    const changed = transitionOpenAgentBlocks(this.indexes(), null, timestamp, "pause");
    if (changed.length > 0) { for (const idx of changed) this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  interruptOpenAgentBlocks(timestamp: number): void {
    const changed = transitionOpenAgentBlocks(this.indexes(), null, timestamp, "teardown");
    if (changed.length > 0) { for (const idx of changed) this.recordBlock("upsert", idx); this.notifyChange(); }
  }
  // Returns the live array, not a copy: every element-level mutation replaces
  // the element reference, so consumers diff by identity; delivery forces
  // propagation via an equals:false signal rather than a fresh array ref.
  getBlocks(): readonly AnyBlock[] {
    this.changePending = false;
    return this.blocks;
  }
  /** Index of the top-level tool block carrying this id, or undefined when no
   *  such block exists. Projector updates resolve through this lookup because
   *  transcript insertion can shift a tracked tool. */
  toolBlockIndex(id: string): number | undefined {
    return this.toolIndexById.get(id);
  }
  /** Startup seed: the session's output window, whose first block sits at
   *  absolute index `sequenceStart`. A later durable fold supersedes an
   *  optimistic pre-runner seed before model output begins. Replacing in
   *  place preserves the live array identity held by store readers. */
  seedBlocks(prior: readonly AnyBlock[], sequenceStart: number): void {
    if (this.blocks.length > 0) this.recordStructuralChange();
    this.blocks.splice(0, this.blocks.length, ...prior);
    this.sequenceStart = sequenceStart;
    this._visibleMessageCountSuffix = 0;
    this.openThoughts.clear();
    for (const block of prior) {
      if (isVisibleMessageBlock(block)) this._visibleMessageCountSuffix++;
      if (block.kind === "thinking" && block.status === "streaming") this.openThoughts.add(block.id);
    }
    rebuildBlockIndexes(this.blocks, this.agentIndexById, this.contentIndexById);
    this.rebuildToolIndex();
    this.notifyChange();
  }
  resetTracking(): void {
    this.streamingText.reset();
    this.agentIndexById.clear();
    this.contentIndexById.clear();
    // toolIndexById stays: it mirrors the block array, which reset keeps, so a
    // late execution-output tail can still land on a pre-reset settled row.
    this.phase = nextResponsePhase(this.phase, { kind: "claimed" });
    this._streamingOutputChars = 0;
    this.notifyChange();
  }
  /** Removes streamed drafts of one kind by row key: a draft that no recorded
   *  part claimed, or a thought that a correction reclassified as text. */
  retractDrafts(kind: "text" | "thinking", blockKeys: readonly string[]): void {
    const indices = new Set<number>();
    for (const key of blockKeys) {
      const idx = this.contentIndexById.get(contentKey(kind, key));
      if (idx !== undefined) indices.add(idx);
    }
    if (indices.size === 0) return;
    for (const index of indices) {
      const block = this.blocks[index];
      if (block !== undefined && isVisibleMessageBlock(block)) this._visibleMessageCountSuffix--;
    }
    this.blocks = this.blocks.filter((_, i) => !indices.has(i));
    rebuildBlockIndexes(this.blocks, this.agentIndexById, this.contentIndexById);
    this.rebuildToolIndex();
    this.recordStructuralChange();
    this.notifyChange();
  }
  removeToolPreview(toolUseId: string): void {
    const index = this.blocks.findIndex((block) => (
      (block.kind === "tool" && block.id === toolUseId)
      || (block.kind === "agentGroup" && block.toolUseId === toolUseId && block.status === "pending")
    ));
    if (index < 0) return;
    this.blocks.splice(index, 1);
    rebuildBlockIndexes(this.blocks, this.agentIndexById, this.contentIndexById);
    this.rebuildToolIndex();
    this.recordStructuralChange();
    this.notifyChange();
  }
  private insertBlock(block: AnyBlock): number {
    const idx = insertOutputBlock(this.indexes(), block);
    if (isVisibleMessageBlock(block)) this._visibleMessageCountSuffix++;
    this.shiftToolIndexesFrom(idx);
    if (block.kind === "tool") this.toolIndexById.set(block.id, idx);
    this.recordBlock("insert", idx);
    return idx;
  }
  // A splice before the pinned tail shifts every later block up one index;
  // insertOutputBlock shifts the helper-owned maps, so the tool map catches up
  // here. A plain append (the common case) shifts nothing.
  private shiftToolIndexesFrom(insertedAt: number): void {
    if (insertedAt >= this.blocks.length - 1) return;
    for (const [id, toolIdx] of this.toolIndexById) {
      if (toolIdx >= insertedAt) this.toolIndexById.set(id, toolIdx + 1);
    }
  }
  private enforceBlocksCap() {
    const evicted = enforceOutputBlockCap(this.indexes(), this.blocksCap);
    if (evicted.length > 0) {
      for (const block of evicted) {
        if (isVisibleMessageBlock(block)) this._visibleMessageCountSuffix--;
      }
      this.rebuildToolIndex();
      this.recordStructuralChange();
    }
  }
  private rebuildToolIndex(): void {
    this.toolIndexById.clear();
    for (const [i, block] of this.blocks.entries()) {
      if (block.kind === "tool") this.toolIndexById.set(block.id, i);
    }
  }
  // Why mutable refs: indexes() is private; the refs go only to extracted
  // helper functions in structured-output-state.ts, not to external consumers.
  private indexes(): OutputBuilderIndexes {
    return {
      blocks: this.blocks,
      agentIndexById: this.agentIndexById,
      contentIndexById: this.contentIndexById,
    };
  }
}
