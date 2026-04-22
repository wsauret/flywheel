import type {
  AnyBlock,
  ToolEntry,
  ToolGroupBlock,
  SystemBlock,
  TodoItem,
  UserMessageBlock,
  QuestionBlock,
  QuestionEntry,
  ModelActivity,
} from "../output-blocks.js";
import { ContextGroupTracker } from "./context-group-tracker.js";
import {
  contentInsertionIndex,
  insertBlockBeforePinned,
  rebuildAgentIndex,
  findTodoIndex,
  appendToolToAgentChildren,
} from "./structured-output-helpers.js";

const BLOCKS_CAP = 20_000;
const AGENT_CHILDREN_CAP = 50;

/**
 * Mark any children still in-flight (no completed/errorMessage) as completed.
 * Called when an agent closes: a pending child in a completed block is a lost
 * tool_result, and leaving a frozen spinner behind is worse than assuming the
 * tool succeeded.
 */
function resolveUnresolvedChildren(children: ToolEntry[]): ToolEntry[] {
  return children.map((c) => (c.completed === true || c.errorMessage ? c : { ...c, completed: true }));
}

// ADR-006 deviation: over 400 lines. All methods mutate shared private state
// (blocks, indexes, contextTracker, dirty flag). No natural seam exists —
// splitting would require passing 5+ mutable fields through an interface,
// creating more complexity than the single cohesive class.
export class StructuredOutputBuilder {
  private blocks: AnyBlock[] = [];
  private contentDirty = false;
  private toolDirty = false;
  private cachedSnapshot: AnyBlock[] = [];

  private agentIndexById = new Map<string, number>();
  private todoBlockIndex = -1;
  private readonly contextTracker: ContextGroupTracker;

  private _modelActivity: ModelActivity = "idle";
  private thinkingStartedAt: number | null = null;
  private pendingThinkingRow: { agentId: string; childIndex: number } | null = null;

  /** Fired on content mutations (text, thinking, system, user, question, todo, modelActivity).
   *  Only fires on the dirty false->true transition, so rapid mutations within
   *  one synchronous batch produce a single notification. */
  onContentChange: (() => void) | null = null;

  /** Fired on tool group mutations (tool rows, agent start/complete/error, patches, latestChild).
   *  Only fires on the dirty false->true transition, so rapid mutations within
   *  one synchronous batch produce a single notification. */
  onToolGroupChange: (() => void) | null = null;

  constructor() {
    this.contextTracker = new ContextGroupTracker({
      startContextAgent: (id, timestamp) => this.startAgent(id, "Tools", "Using tools...", timestamp, "tools"),
      appendToolToContextAgent: (agentId, tool) => this.appendToolToAgent(agentId, tool),
      completeContextAgent: (agentId, duration) => this.completeAgent(agentId, duration),
    });
  }

  private markContentDirty(): void {
    if (this.contentDirty) return;
    this.contentDirty = true;
    this.onContentChange?.();
  }

  private markToolDirty(): void {
    if (this.toolDirty) return;
    this.toolDirty = true;
    this.onToolGroupChange?.();
  }

  get modelActivity(): ModelActivity { return this._modelActivity; }

  /** True if there's an active Tools context group that thinking can join. */
  get hasActiveToolsContext(): boolean { return this.contextTracker.currentAgentId !== null; }

  resetActivity(): void {
    this._modelActivity = "idle";
  }

  notifyThinkingStarted(timestamp: number): void {
    this._modelActivity = "thinking";
    this.markContentDirty();
    if (this.thinkingStartedAt === null) {
      this.thinkingStartedAt = timestamp;
    }
  }

  /** Create a thinking tool row inside the Tools group. Only call when hasActiveToolsContext is true. */
  pushThinkingAsToolRow(timestamp: number): void {
    const startTime = this.thinkingStartedAt ?? timestamp;
    this.thinkingStartedAt = null;

    const loc = this.pushToolRow({
      kind: "tool",
      name: "Thinking",
      detail: "",
      timestamp: startTime,
    });
    this.pendingThinkingRow = loc;
    // Restore "thinking" activity — pushToolRow sets to "tool_executing" but this is a thinking phase
    this._modelActivity = "thinking";
  }

  /** Mark the pending thinking tool row as completed. No-op if none is pending. */
  completeThinkingRow(): void {
    if (!this.pendingThinkingRow) return;
    const { agentId, childIndex } = this.pendingThinkingRow;
    this.pendingThinkingRow = null;
    this.completeAgentChildTool(agentId, childIndex);
  }

  /** Create/append to a standalone thinking block. Used when no tool context exists. */
  pushThinking(text: string, timestamp: number): void {
    this._modelActivity = "thinking";
    if (!text.trim()) return;
    this.contextTracker.breakContextRun(timestamp);
    const blockTimestamp = this.thinkingStartedAt ?? timestamp;
    this.thinkingStartedAt = null;
    const lastIdx = this.lastContentIndex();
    const last = lastIdx >= 0 ? this.blocks[lastIdx] : null;
    if (last && last.kind === "thinking") {
      this.blocks[lastIdx] = { ...last, content: last.content + text };
    } else {
      this.insertBlock({ kind: "thinking", content: text, timestamp: blockTimestamp });
    }
    this.markContentDirty();
  }

  pushUserMessage(text: string, timestamp: number, pending?: boolean, injected?: boolean): void {
    this.contextTracker.breakContextRun(timestamp);
    const block = { kind: "userMessage" as const, content: text, timestamp, pending, injected };
    if (pending) {
      // Pending messages pin above the todo but below content
      if (this.todoBlockIndex >= 0 && this.todoBlockIndex < this.blocks.length) {
        const idx = this.todoBlockIndex;
        this.blocks.splice(idx, 0, block);
        for (const [id, agentIdx] of this.agentIndexById) {
          if (agentIdx >= idx) this.agentIndexById.set(id, agentIdx + 1);
        }
        this.todoBlockIndex++;
      } else {
        this.blocks.push(block);
      }
    } else {
      this.insertBlock(block);
    }
    this.markContentDirty();
  }

  // Transitions pending injected messages to resolved once the engine acknowledges them.
  resolvePendingMessages(): string[] {
    const pendingIndices: number[] = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (b.kind === "userMessage" && b.pending) {
        pendingIndices.push(i);
      }
    }
    if (pendingIndices.length === 0) return [];

    const resolved: AnyBlock[] = [];
    const texts: string[] = [];
    for (let i = pendingIndices.length - 1; i >= 0; i--) {
      const [msg] = this.blocks.splice(pendingIndices[i]!, 1) as [UserMessageBlock];
      resolved.unshift({ ...msg, pending: false });
      texts.unshift(msg.content);
    }
    const todoIdx = this.blocks.findIndex(b => b.kind === "todoList");
    if (todoIdx >= 0) {
      this.blocks.splice(todoIdx, 0, ...resolved);
    } else {
      this.blocks.push(...resolved);
    }

    rebuildAgentIndex(this.blocks, this.agentIndexById);
    this.todoBlockIndex = findTodoIndex(this.blocks);
    this.markContentDirty();
    return texts;
  }

  pushText(text: string, timestamp: number): void {
    this._modelActivity = "generating";
    this.thinkingStartedAt = null;
    this.contextTracker.breakContextRun(timestamp);

    const lastIdx = this.lastContentIndex();
    const last = lastIdx >= 0 ? this.blocks[lastIdx] : undefined;
    if (last && last.kind === "text") {
      this.blocks[lastIdx] = { ...last, content: last.content + text };
    } else {
      this.insertBlock({ kind: "text", content: text, timestamp });
    }

    this.markContentDirty();
  }

  pushSystemMessage(message: string, timestamp: number): void {
    this.contextTracker.breakContextRun(timestamp);
    this.insertBlock({ kind: "system", message, timestamp } as SystemBlock);
    this.enforceBlocksCap();
    this.markContentDirty();
  }

  /**
   * Insert a top-level standalone tool entry — used for tools that render with
   * their own body (diffs, content) rather than as a row inside a Tools group.
   * Breaks any active Tools group. Parser routes here only for blacklisted
   * tools (Edit, Write) that always render standalone.
   */
  pushTool(name: string, detail: string, timestamp: number, diff?: string, filetype?: string, content?: string, filePath?: string): number {
    this._modelActivity = "tool_executing";
    const tool: ToolEntry = {
      kind: "tool", name, detail, timestamp,
      ...(filePath && { filePath }),
      ...(diff && { diff }),
      ...(content && { content }),
      ...(filetype && { filetype }),
    };
    this.contextTracker.breakContextRun(timestamp);
    const idx = this.insertBlock(tool);
    this.enforceBlocksCap();
    this.markToolDirty();
    return idx;
  }

  /**
   * Append a tool row to the ad-hoc Tools group, opening a new group if none
   * is active. The tool may be pending (no completed/errorMessage) — status is
   * filled in later via completeAgentChildTool/errorAgentChildTool, keyed by
   * the returned {agentId, childIndex}. Returns null only on unrecoverable
   * append failure (shouldn't happen in practice).
   */
  pushToolRow(tool: ToolEntry): { agentId: string; childIndex: number } | null {
    this._modelActivity = "tool_executing";
    const agentId = this.contextTracker.pushContextTool(tool, tool.timestamp);
    const agentIdx = this.agentIndexById.get(agentId);
    if (agentIdx === undefined) return null;
    const agent = this.blocks[agentIdx] as ToolGroupBlock;
    const childIndex = agent.children.length - 1;
    this.enforceBlocksCap();
    this.markToolDirty();
    return { agentId, childIndex };
  }

  /**
   * Append a tool row to a specific agent's children. The tool may be pending.
   * Returns the child index, or -1 if the agent was not found.
   */
  pushToolRowToAgent(agentId: string, tool: ToolEntry): number {
    return this.appendToolToAgent(agentId, tool);
  }

  pushTodoWrite(todos: TodoItem[], timestamp: number): void {
    this._modelActivity = "tool_executing";
    this.contextTracker.breakContextRun(timestamp);

    if (todos.length === 0) {
      if (this.todoBlockIndex >= 0 && this.todoBlockIndex < this.blocks.length) {
        this.blocks.splice(this.todoBlockIndex, 1);
        rebuildAgentIndex(this.blocks, this.agentIndexById);
        this.todoBlockIndex = -1;
      }
      this.markContentDirty();
      return;
    }

    const block = { kind: "todoList" as const, todos, timestamp };

    if (this.todoBlockIndex >= 0 && this.todoBlockIndex < this.blocks.length && this.blocks[this.todoBlockIndex].kind === "todoList") {
      this.blocks[this.todoBlockIndex] = block;
    } else {
      this.blocks.push(block);
      this.todoBlockIndex = this.blocks.length - 1;
    }

    this.enforceBlocksCap();
    this.markContentDirty();
  }

  private appendToolToAgent(agentId: string, tool: ToolEntry): number {
    const result = appendToolToAgentChildren(this.blocks, this.agentIndexById, agentId, tool, AGENT_CHILDREN_CAP);
    if (result >= 0) this.markToolDirty();
    return result;
  }

  startAgent(id: string, label: string, description: string, timestamp: number, groupKind: "agent" | "tools" = "agent"): void {
    this.contextTracker.breakContextRun(timestamp);

    const agent: ToolGroupBlock = {
      kind: "toolGroup",
      id,
      groupKind,
      label,
      description,
      status: "active",
      children: [],
      timestamp,
    };
    const idx = this.insertBlock(agent);
    this.agentIndexById.set(id, idx);
    this.enforceBlocksCap();
    this.markToolDirty();
  }

  completeAgent(id: string, duration: number, description?: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as ToolGroupBlock;
    if (agent.status !== "active") return;

    this.blocks[idx] = {
      ...agent,
      status: "completed",
      duration,
      children: resolveUnresolvedChildren(agent.children),
      ...(description !== undefined ? { description } : {}),
    };
    this.markToolDirty();
  }

  errorAgent(id: string, message: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as ToolGroupBlock;
    this.blocks[idx] = {
      ...agent,
      status: "error",
      errorMessage: message,
      children: resolveUnresolvedChildren(agent.children),
    };
    this.markToolDirty();
  }

  completeAgentChildTool(agentId: string, childIndex: number): void {
    this.patchAgentChild(agentId, childIndex, { completed: true });
  }

  errorAgentChildTool(agentId: string, childIndex: number, message: string): void {
    this.patchAgentChild(agentId, childIndex, { errorMessage: message });
  }

  private patchAgentChild(agentId: string, childIndex: number, patch: Partial<ToolEntry>): void {
    const idx = this.agentIndexById.get(agentId);
    if (idx === undefined) return;
    const agent = this.blocks[idx];
    if (!agent || agent.kind !== "toolGroup") return;
    const child = agent.children[childIndex];
    if (!child) return;
    const updatedChildren = [...agent.children];
    updatedChildren[childIndex] = { ...child, ...patch };
    this.blocks[idx] = { ...agent, children: updatedChildren };
    this.markToolDirty();
  }

  errorTool(blockIndex: number, message: string): void {
    const block = this.blocks[blockIndex];
    if (!block || block.kind !== "tool") return;
    this.blocks[blockIndex] = { ...block, errorMessage: message };
    this.markToolDirty();
  }

  completeTool(blockIndex: number): void {
    const block = this.blocks[blockIndex];
    if (!block || block.kind !== "tool") return;
    this.blocks[blockIndex] = { ...block, completed: true };
    this.markToolDirty();
  }

  pushQuestion(toolUseId: string, questions: QuestionEntry[], timestamp: number): number {
    this._modelActivity = "tool_executing";
    this.contextTracker.breakContextRun(timestamp);
    const block: QuestionBlock = {
      kind: "question",
      toolUseId,
      questions,
      timestamp,
    };
    const idx = this.insertBlock(block);
    this.enforceBlocksCap();
    this.markContentDirty();
    return idx;
  }

  // Preserve locally-set answers (from the dock) — the parser sees a verbose
  // echo in the tool_result ("User has answered your questions: ..."), which
  // is noisier than the option labels we already stored.
  answerQuestion(toolUseId: string, answers: Record<string, string>): void {
    this.updateQuestion(toolUseId, { answers });
  }

  cancelQuestion(toolUseId: string): void {
    this.updateQuestion(toolUseId, { cancelled: true });
  }

  private updateQuestion(toolUseId: string, patch: { answers?: Record<string, string>; cancelled?: true }): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i];
      if (block.kind !== "question" || block.toolUseId !== toolUseId) continue;
      if (block.answers !== undefined || block.cancelled) return;
      this.blocks[i] = { ...block, ...patch };
      this.markContentDirty();
      return;
    }
  }

  updateAgentLatestChild(id: string, childDisplay: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as ToolGroupBlock;
    if (agent.status !== "active") return;

    this.blocks[idx] = { ...agent, latestChild: childDisplay };
    this.markToolDirty();
  }

  closeOpenSubagents(timestamp: number): void {
    const ctxId = this.contextTracker.currentAgentId;
    for (const [id, idx] of this.agentIndexById) {
      if (id === ctxId) continue;
      const block = this.blocks[idx];
      if (block.kind === "toolGroup" && block.status === "active") {
        this.completeAgent(id, timestamp - block.timestamp);
      }
    }
  }

  flushContextRun(timestamp: number): void {
    this.contextTracker.breakContextRun(timestamp);
    this.markToolDirty();
  }

  getBlocks(): AnyBlock[] {
    if (!this.contentDirty && !this.toolDirty) return this.cachedSnapshot;
    this.contentDirty = false;
    this.toolDirty = false;
    this.cachedSnapshot = [...this.blocks];
    return this.cachedSnapshot;
  }

  reset(): void {
    this.blocks = [];
    this.contentDirty = false;
    this.toolDirty = false;
    this.cachedSnapshot = [];
    this.agentIndexById.clear();
    this.todoBlockIndex = -1;
    this.thinkingStartedAt = null;
    this.pendingThinkingRow = null;
    this.contextTracker.reset();
  }

  // Preserves blocks for display continuity across engine restarts; only rebuilds index maps.
  resetTracking(): void {
    this.agentIndexById.clear();
    this.todoBlockIndex = -1;
    this.thinkingStartedAt = null;
    this.pendingThinkingRow = null;
    this.contextTracker.resetTracking();
    this.markContentDirty();
    this.markToolDirty();
    this.cachedSnapshot = [];
  }

  private insertBlock(block: AnyBlock): number {
    const result = insertBlockBeforePinned(this.blocks, block, this.agentIndexById, this.todoBlockIndex);
    this.todoBlockIndex = result.todoBlockIndex;
    return result.index;
  }

  private lastContentIndex() {
    return contentInsertionIndex(this.blocks) - 1;
  }

  private enforceBlocksCap() {
    if (this.blocks.length > BLOCKS_CAP) {
      const overflow = this.blocks.length - BLOCKS_CAP;
      this.blocks.splice(0, overflow);
      rebuildAgentIndex(this.blocks, this.agentIndexById);
      if (this.todoBlockIndex >= 0) {
        this.todoBlockIndex = this.todoBlockIndex < overflow ? -1 : this.todoBlockIndex - overflow;
      }
      const ctxId = this.contextTracker.currentAgentId;
      if (ctxId !== null) {
        this.contextTracker.handleEviction(this.agentIndexById.has(ctxId));
      }
    }
  }
}
