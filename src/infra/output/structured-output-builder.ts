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
  isVisibleMessageBlock,
} from "../output-blocks.js";
import { formatAgentFailureDisplay } from "./output-formatter.js";
import { randomUUID } from "node:crypto";
import { Log } from "../log.js";
import { EMPTY_OUTPUT_CHANGE_BATCH, NO_CHANGED_TOOLS, type OutputBlockChange, type OutputChangeBatch } from "./output-block-delta.js";
import { StreamingToolTextStore } from "./streaming-tool-text.js";
import { appendKeyedDelta } from "./structured-output-grouping.js";
import { definedProps, rebuildBlockIndexes } from "./structured-output-helpers.js";
import { resetFailedFileChange } from "./file-change-settlement.js";
import { resolveToolRowPresentation } from "../tools/tool-display-registry.js";
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
  updateAgentLatestChildBlock,
  updateAgentMetaBlock,
} from "./structured-output-agents.js";
import {
  appendAgentChild,
  drainQueuedUserMessages,
  enforceOutputBlockCap,
  hasQueuedUserMessage,
  insertOutputBlock,
  type OutputBuilderIndexes,
  patchAgentChildTool,
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

export class StructuredOutputBuilder {
  // blocksCap is a test seam: eviction wiring is identical at any cap, and
  // exceeding the production 20k in a test is seconds of pure allocation.
  constructor(private readonly blocksCap: number = BLOCKS_CAP) {}
  // Mints the stable id for blocks that carry no natural one (system/
  // divider/userMessage and provider-less tools): a uuid, unique across
  // reactivation seeds with no counter to resume.
  private readonly mintId: () => string = () => randomUUID();
  private blocks: AnyBlock[] = [];
  private _visibleMessageCountSuffix = 0;
  private changePending = false;
  readonly streamingText = new StreamingToolTextStore(() => this.notifyChange());
  private agentIndexById = new Map<string, number>();
  private contentIndexById = new Map<string, number>();
  // Top-level tool blocks by their stable id, maintained beside the agent and
  // content maps so late result metadata (a recorded execution-output tail)
  // resolves without scanning the whole block array. Kept local to this class
  // because insertOutputBlock only shifts the helper-owned maps.
  private toolIndexById = new Map<string, number>();
  private phase: ResponsePhase | null = null;
  private _streamingOutputChars = 0;
  // Changes are recorded at the write site instead of reconstructed later by
  // diffing full snapshots. `needsFullResync` covers rare structural rewrites
  // (cap eviction, retraction, queued-message recall), where reindexing every
  // already-queued change costs more than having drainChanges' consumer resend
  // the current block array from the session's base offset.
  private pendingChanges: OutputBlockChange[] = [];
  private needsFullResync = false;
  onChange: (() => void) | null = null;
  private changeHolds = 0;
  private changeHeld = false;
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
  private recordUpsert(index: number): void {
    if (!this.onChange || this.needsFullResync) return;
    const block = this.blocks[index];
    if (!block) return;
    this.pendingChanges.push({ kind: "upsert", index, block });
  }
  private recordInsert(index: number): void {
    if (!this.onChange || this.needsFullResync) return;
    const block = this.blocks[index];
    if (!block) return;
    this.pendingChanges.push({ kind: "insert", index, block });
  }
  private recordAppend(index: number, text: string): void {
    if (!this.onChange || this.needsFullResync) return;
    const block = this.blocks[index];
    if (!block || (block.kind !== "text" && block.kind !== "thinking")) return;
    this.pendingChanges.push({
      kind: "append-content",
      index,
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
  completeThinking(timestamp = Date.now()): void {
    this.completeStreamingThinkingBlocks(timestamp);
  }
  pushThinking(text: string, timestamp: number, blockKey: string): void {
    if (!text.trim()) { this.notifyChange(); return; }
    const blockTimestamp = anchorOf(this.phase) ?? timestamp;
    this.phase = nextResponsePhase(this.phase, { kind: "claimed" });
    const result = appendKeyedDelta(
      this.blocks,
      this.contentIndexById,
      blockKey,
      text,
      (id, content) => ({ kind: "thinking", id, content, status: "streaming", timestamp: blockTimestamp }),
      (block) => this.insertBlock(block),
    );
    if (result && !result.created) this.recordAppend(result.index, text);
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
      this.recordUpsert(index);
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
    if (this.contentIndexById.has(blockKey)) {
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
    this.recordInsert(toolIndex);
    this.notifyChange();
  }
  /** Corrects one public run without changing its identity or position. */
  replaceText(blockKey: string, content: string): void {
    const index = this.contentIndexById.get(blockKey);
    const block = index === undefined ? undefined : this.blocks[index];
    if (index === undefined || block?.kind !== "text" || block.content === content) return;
    this._streamingOutputChars += content.length - block.content.length;
    this.blocks[index] = { ...block, content };
    this.recordUpsert(index);
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
      ...(linkUri && { linkUri }),
      ...(diff && { diff }),
      ...(content && { content }),
      ...(filetype && { filetype }),
    });
  }
  pushStandaloneToolEntry(tool: ToolEntry): number {
    this.completeThinking(tool.timestamp);
    const idx = this.insertBlock(tool);
    this.enforceBlocksCap();
    this.notifyChange();
    return idx;
  }
  pushToolRowToAgent(agentId: string, tool: ToolEntry): number {
    const result = appendAgentChild(this.indexes(), agentId, tool);
    if (result >= 0) {
      const agentIdx = this.agentIndexById.get(agentId);
      if (agentIdx !== undefined) this.recordUpsert(agentIdx);
      this.notifyChange();
    }
    return result;
  }
  startAgent(id: string, identity: AgentBlockIdentity, timestamp: number, toolUseId: string): void {
    this.completeThinking(timestamp);
    const replaceIndex = this.toolIndexById.get(toolUseId);
    startAgentBlock(this.indexes(), id, identity, timestamp, toolUseId, replaceIndex);
    const idx = this.agentIndexById.get(id);
    if (replaceIndex !== undefined) {
      this.toolIndexById.delete(toolUseId);
      this.recordUpsert(replaceIndex);
    } else if (idx !== undefined) { this.shiftToolIndexesFrom(idx); this.recordInsert(idx); }
    this.enforceBlocksCap();
    this.notifyChange();
  }
  completeAgent(id: string, duration: number, meta?: CompleteAgentMeta): void {
    const idx = completeAgentBlock(this.indexes(), id, duration, meta);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  interruptAgent(id: string, duration: number): void {
    const idx = interruptAgentBlock(this.indexes(), id, duration);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  pauseAgent(id: string, pausedBy: PausedBy): void {
    const idx = pauseAgentBlock(this.indexes(), id, pausedBy);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  cancelAgent(id: string, duration: number, status: "cancelled" | "stopped"): void {
    const idx = cancelAgentBlock(this.indexes(), id, duration, status);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  errorAgent(id: string, error: string | AgentFailureDisplay, duration?: number): void {
    const failure = typeof error === "string" ? formatAgentFailureDisplay(error) : error;
    const idx = errorAgentBlock(this.indexes(), id, failure, duration);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  completeAgentChildTool(agentId: string, childIndex: number, extra?: Partial<ToolEntry>): void {
    this.patchAgentChild(agentId, childIndex, { status: "completed", ...extra });
  }
  errorAgentChildTool(agentId: string, childIndex: number, message: string, extra?: Partial<ToolEntry>): void {
    const groupIndex = this.agentIndexById.get(agentId);
    const group = groupIndex === undefined ? undefined : this.blocks[groupIndex];
    const child = group?.kind === "agentGroup" ? group.children[childIndex] : undefined;
    if (groupIndex === undefined || group?.kind !== "agentGroup" || !child) return;
    const children = [...group.children];
    children[childIndex] = resetFailedFileChange({ ...child, ...extra, status: "error", errorMessage: message });
    this.blocks[groupIndex] = { ...group, children };
    this.recordUpsert(groupIndex);
    this.notifyChange();
  }
  blockAgentChildTool(agentId: string, childIndex: number, statusMessage: string): void {
    this.patchAgentChild(agentId, childIndex, { status: "blocked", statusMessage });
  }
  interruptAgentChildTool(agentId: string, childIndex: number): void { this.patchAgentChild(agentId, childIndex, { status: "interrupted" }); }
  patchAgentChild(agentId: string, childIndex: number, patch: Partial<ToolEntry>): void {
    const idx = patchAgentChildTool(this.blocks, this.agentIndexById, agentId, childIndex, patch);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  errorTool(blockIndex: number, message: string, extra?: Partial<ToolEntry>): void {
    const block = this.blocks[blockIndex];
    if (!block || block.kind !== "tool") return;
    this.blocks[blockIndex] = resetFailedFileChange({ ...block, ...extra, status: "error", errorMessage: message });
    this.recordUpsert(blockIndex);
    this.notifyChange();
  }
  blockTool(blockIndex: number, statusMessage: string): void {
    const idx = patchStandaloneTool(this.blocks, blockIndex, { status: "blocked", statusMessage });
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  interruptTool(blockIndex: number): void {
    const idx = patchStandaloneTool(this.blocks, blockIndex, { status: "interrupted" });
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  completeTool(blockIndex: number, extra?: Partial<ToolEntry>): void {
    const idx = patchStandaloneTool(this.blocks, blockIndex, { status: "completed", ...extra });
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  /** Patch an existing row at its indexed position. */
  patchTool(blockIndex: number, patch: Partial<ToolEntry>): void {
    const idx = patchStandaloneTool(this.blocks, blockIndex, patch);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  finalizeStandaloneTool(blockIndex: number, fields: ToolInputFields, inputComplete = false): void {
    const block = this.blocks[blockIndex];
    if (!block || block.kind !== "tool") return;
    if (block.status === "error") return;
    const status = block.status === "completed" || block.status === "interrupted" || block.status === "blocked"
      ? block.status
      : inputComplete || fields.content !== undefined || fields.diff !== undefined ? "pending" : block.status;
    const idx = patchStandaloneTool(this.blocks, blockIndex, { status, ...definedProps(fields) });
    if (idx !== null) this.recordUpsert(idx);
    this.notifyChange();
  }
  updateAgentMeta(id: string, label?: string, description?: string, agentType?: string, sentence?: ToolPresentation): void {
    const idx = updateAgentMetaBlock(this.indexes(), id, label, description, agentType, sentence);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  setAgentModel(id: string, model: string): void {
    const idx = setAgentModelBlock(this.indexes(), id, model);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  setAgentLink(id: string, linkUri: string): void {
    const idx = setAgentLinkBlock(this.indexes(), id, linkUri);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  dispatchAgent(id: string): void {
    const idx = dispatchAgentBlock(this.indexes(), id);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  queueAgent(id: string): void {
    const idx = queueAgentBlock(this.indexes(), id);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  finalizeAgentChildTool(agentId: string, childIndex: number, fields: ToolInputFields, inputComplete = false): void {
    const child = this.blocks[this.agentIndexById.get(agentId) ?? -1];
    const currentStatus = child?.kind === "agentGroup" ? child.children[childIndex]?.status : undefined;
    if (currentStatus === "error") return;
    const status = inputComplete || fields.content !== undefined || fields.diff !== undefined ? "pending" : currentStatus ?? "pending";
    this.patchAgentChild(agentId, childIndex, { status, ...definedProps(fields) });
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
      this.recordUpsert(provisionalIndex);
      this.notifyChange();
      return provisionalIndex;
    }
    const idx = pushQuestionBlock(this.indexes(), toolUseId, questions, timestamp);
    this.blocks[idx] = { kind: "question", toolUseId, questions, timestamp, sentence: resolveToolRowPresentation("ask_user", {}, "").sentence };
    this.shiftToolIndexesFrom(idx);
    this.recordInsert(idx);
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
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  updateAgentLatestChild(id: string, childDisplay: string): void {
    const idx = updateAgentLatestChildBlock(this.indexes(), id, childDisplay);
    if (idx !== null) { this.recordUpsert(idx); this.notifyChange(); }
  }
  closePendingAgentBlocks(timestamp: number): void {
    const changed = transitionOpenAgentBlocks(this.indexes(), null, timestamp, "complete");
    if (changed.length > 0) { for (const idx of changed) this.recordUpsert(idx); this.notifyChange(); }
  }
  interruptPendingAgentBlocks(timestamp: number): void {
    const changed = transitionOpenAgentBlocks(this.indexes(), null, timestamp, "pause");
    if (changed.length > 0) { for (const idx of changed) this.recordUpsert(idx); this.notifyChange(); }
  }
  interruptOpenAgentBlocks(timestamp: number): void {
    const changed = transitionOpenAgentBlocks(this.indexes(), null, timestamp, "teardown");
    if (changed.length > 0) { for (const idx of changed) this.recordUpsert(idx); this.notifyChange(); }
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
  // Startup seed: a later durable fold supersedes an optimistic pre-runner
  // seed before model output begins. Replacing in place preserves the live
  // array identity held by store readers.
  seedBlocks(prior: readonly AnyBlock[]): void {
    if (this.blocks.length > 0) this.recordStructuralChange();
    this.blocks.splice(0, this.blocks.length, ...prior);
    this._visibleMessageCountSuffix = prior.reduce(
      (count, block) => count + (isVisibleMessageBlock(block) ? 1 : 0),
      0,
    );
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
  /** Remove streamed draft blocks by blockKey (text/thinking block ids). Used
   *  by stream-retry retraction so a failed attempt's partial output does not
   *  survive beside the retry's regeneration. */
  retractBlocks(blockKeys: readonly string[]): void {
    const indices = new Set<number>();
    for (const key of blockKeys) {
      const idx = this.contentIndexById.get(key);
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
  removeStreamingThinkingBlocks(blockKeys: readonly string[]): void {
    const keys = new Set(blockKeys);
    const retained = this.blocks.filter((block) => (
      block.kind !== "thinking" || block.status !== "streaming" || !keys.has(block.id)
    ));
    if (retained.length === this.blocks.length) return;
    this.blocks = retained;
    rebuildBlockIndexes(this.blocks, this.agentIndexById, this.contentIndexById);
    this.rebuildToolIndex();
    this.recordStructuralChange();
    this.notifyChange();
  }
  removeToolPreview(toolUseId: string): { agentId: string; childIndex: number } | null {
    const topLevelIndex = this.blocks.findIndex((block) => (
      (block.kind === "tool" && block.id === toolUseId)
      || (block.kind === "agentGroup" && block.toolUseId === toolUseId && block.status === "pending")
    ));
    if (topLevelIndex >= 0) {
      this.blocks.splice(topLevelIndex, 1);
      rebuildBlockIndexes(this.blocks, this.agentIndexById, this.contentIndexById);
      this.rebuildToolIndex();
      this.recordStructuralChange();
      this.notifyChange();
      return null;
    }
    for (const [blockIndex, block] of this.blocks.entries()) {
      if (block.kind !== "agentGroup") continue;
      const childIndex = block.children.findIndex((child) => child.id === toolUseId);
      if (childIndex < 0) continue;
      const children = [...block.children];
      children.splice(childIndex, 1);
      this.blocks[blockIndex] = { ...block, children };
      this.recordStructuralChange();
      this.notifyChange();
      return { agentId: block.id, childIndex };
    }
    return null;
  }
  private insertBlock(block: AnyBlock): number {
    const idx = insertOutputBlock(this.indexes(), block);
    if (isVisibleMessageBlock(block)) this._visibleMessageCountSuffix++;
    this.shiftToolIndexesFrom(idx);
    if (block.kind === "tool") this.toolIndexById.set(block.id, idx);
    this.recordInsert(idx);
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
  private completeStreamingThinkingBlocks(timestamp: number): void {
    let changed = false;
    for (let index = 0; index < this.blocks.length; index++) {
      const block = this.blocks[index];
      if (block?.kind === "thinking" && block.status === "streaming") {
        this.blocks[index] = { ...block, status: "completed", completedAt: timestamp };
        this.recordUpsert(index);
        changed = true;
      }
    }
    if (changed) this.notifyChange();
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
