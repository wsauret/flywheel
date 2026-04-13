/**
 * Structured Output Builder
 *
 * Accumulates parsed engine output into structured blocks (TextBlock, ToolBlock,
 * AgentBlock) for display in the TUI output window.
 *
 * Manages all mutations internally — exposes only `getBlocks()` which returns
 * a new array reference when dirty, enabling efficient SolidJS reactivity via
 * `setOutputBlocks(builder.getBlocks())`.
 *
 * Context grouping is delegated to ContextGroupTracker to keep this module
 * focused on block accumulation. Agent completion relies on authoritative
 * signals (tool_result events and closeOpenSubagents) rather than timeouts.
 */

import type {
  AnyBlock,
  TextBlock,
  ToolBlock,
  AgentBlock,
  SystemBlock,
  TodoItem,
  TodoListBlock,
  UserMessageBlock,
} from "../output-blocks.js";
import { ContextGroupTracker, isContextTool } from "./context-group-tracker.js";
import {
  contentInsertionIndex,
  insertBlockBeforePinned,
  rebuildAgentIndex,
  findTodoIndex,
  appendToolToAgentChildren,
} from "./structured-output-helpers.js";

const BLOCKS_CAP = 20_000;
const AGENT_CHILDREN_CAP = 50;

import type { ModelActivity } from "../events.js";

export class StructuredOutputBuilder {
  private blocks: AnyBlock[] = [];
  private dirty = false;
  private cachedSnapshot: AnyBlock[] = [];

  /** Map of agent ID → index in `blocks` for O(1) agent lookups. */
  private agentIndexById = new Map<string, number>();

  /** Index of the current TodoListBlock for in-place updates, or -1 if none. */
  private todoBlockIndex = -1;

  /** Context tool grouping — groups consecutive context tools into synthetic AgentBlocks. */
  private readonly contextTracker: ContextGroupTracker;

  onModelActivityChange?: (activity: ModelActivity) => void;
  private thinkingStartedAt: number | null = null;

  constructor() {
    this.contextTracker = new ContextGroupTracker({
      startContextAgent: (id, timestamp) => this.startAgent(id, "Tools", "Using tools...", timestamp),
      appendToolToContextAgent: (agentId, tool) => this.appendToolToAgent(agentId, tool),
      completeContextAgent: (agentId, duration) => this.completeAgent(agentId, duration),
    });
  }

  // ── Public API ──

  /** Record that the model entered thinking mode (before text arrives). */
  notifyThinkingStarted(timestamp: number): void {
    this.onModelActivityChange?.("thinking");
    if (this.thinkingStartedAt === null) {
      this.thinkingStartedAt = timestamp;
    }
  }

  pushThinking(text: string, timestamp: number): void {
    this.onModelActivityChange?.("thinking");
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
    this.dirty = true;
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
    this.dirty = true;
  }

  /** Transition pending user messages to sent and move to end of blocks array. */
  resolvePendingMessages(): boolean {
    const pendingIndices: number[] = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (b.kind === "userMessage" && b.pending) {
        pendingIndices.push(i);
      }
    }
    if (pendingIndices.length === 0) return false;

    // Extract pending messages in reverse order (preserves earlier indices during splice)
    const resolved: AnyBlock[] = [];
    for (let i = pendingIndices.length - 1; i >= 0; i--) {
      const [msg] = this.blocks.splice(pendingIndices[i]!, 1) as [UserMessageBlock];
      resolved.unshift({ ...msg, pending: false });
    }
    // Re-insert before the todo block (indices shifted from extractions, so find it fresh)
    const todoIdx = this.blocks.findIndex(b => b.kind === "todoList");
    if (todoIdx >= 0) {
      this.blocks.splice(todoIdx, 0, ...resolved);
    } else {
      this.blocks.push(...resolved);
    }

    // Indices shifted — rebuild lookups
    rebuildAgentIndex(this.blocks, this.agentIndexById);
    this.todoBlockIndex = findTodoIndex(this.blocks);
    this.dirty = true;
    return true;
  }

  pushText(text: string, timestamp: number): void {
    this.onModelActivityChange?.("generating");
    this.thinkingStartedAt = null;
    this.contextTracker.breakContextRun(timestamp);

    const lastIdx = this.lastContentIndex();
    const last = lastIdx >= 0 ? this.blocks[lastIdx] : undefined;
    if (last && last.kind === "text") {
      this.blocks[lastIdx] = { ...last, content: last.content + text };
    } else {
      this.insertBlock({ kind: "text", content: text, timestamp });
    }

    this.markDirty();
  }

  /** Push a system message block for lifecycle events. */
  pushSystemMessage(message: string, timestamp: number): void {
    this.contextTracker.breakContextRun(timestamp);
    this.insertBlock({ kind: "system", message, timestamp } as SystemBlock);
    this.enforceBlocksCap();
    this.markDirty();
  }

  pushTool(name: string, detail: string, timestamp: number, diff?: string, filetype?: string, content?: string, filePath?: string): void {
    this.onModelActivityChange?.("tool_executing");
    const tool = { kind: "tool" as const, name, detail, timestamp, ...(filePath && { filePath }), ...(diff && { diff }), ...(content && { content }), ...(filetype && { filetype }) };

    // Top-level tool: check context grouping.
    // Tools with diff/content data render standalone (not grouped) so the content is visible.
    if (isContextTool(name) && !diff && !content) {
      this.contextTracker.pushContextTool(tool, timestamp);
    } else {
      this.contextTracker.breakContextRun(timestamp);
      this.insertBlock(tool);
    }

    this.enforceBlocksCap();
    this.markDirty();
  }

  /** Push or update a TodoListBlock. Empty array removes it. */
  pushTodoWrite(todos: TodoItem[], timestamp: number): void {
    this.onModelActivityChange?.("tool_executing");
    this.contextTracker.breakContextRun(timestamp);

    if (todos.length === 0) {
      // All done — remove the block if it exists
      if (this.todoBlockIndex >= 0 && this.todoBlockIndex < this.blocks.length) {
        this.blocks.splice(this.todoBlockIndex, 1);
        rebuildAgentIndex(this.blocks, this.agentIndexById);
        this.todoBlockIndex = -1;
      }
      this.markDirty();
      return;
    }

    const block = { kind: "todoList" as const, todos, timestamp };

    if (this.todoBlockIndex >= 0 && this.todoBlockIndex < this.blocks.length && this.blocks[this.todoBlockIndex].kind === "todoList") {
      // Update in place
      this.blocks[this.todoBlockIndex] = block;
    } else {
      // First call — append
      this.blocks.push(block);
      this.todoBlockIndex = this.blocks.length - 1;
    }

    this.enforceBlocksCap();
    this.markDirty();
  }

  /** Push a tool as a child of an agent. Returns false if agent not found. */
  pushToolToAgent(agentId: string, name: string, detail: string, timestamp: number, diff?: string, filetype?: string, content?: string, filePath?: string): boolean {
    const tool = { kind: "tool" as const, name, detail, timestamp, ...(filePath && { filePath }), ...(diff && { diff }), ...(content && { content }), ...(filetype && { filetype }) };
    return this.appendToolToAgent(agentId, tool);
  }

  private appendToolToAgent(agentId: string, tool: ToolBlock): boolean {
    const ok = appendToolToAgentChildren(this.blocks, this.agentIndexById, agentId, tool, AGENT_CHILDREN_CAP);
    if (ok) this.markDirty();
    return ok;
  }

  startAgent(id: string, agentLabel: string, description: string, timestamp: number): void {
    this.contextTracker.breakContextRun(timestamp);

    const agent: AgentBlock = {
      kind: "agent",
      id,
      agentLabel,
      description,
      status: "active",
      children: [],
      timestamp,
    };
    const idx = this.insertBlock(agent);
    this.agentIndexById.set(id, idx);
    this.enforceBlocksCap();
    this.markDirty();
  }

  completeAgent(id: string, duration: number, description?: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    if (agent.status === "completed") return;
    if (agent.status !== "active") return;

    this.blocks[idx] = {
      ...agent,
      status: "completed",
      duration,
      ...(description !== undefined ? { description } : {}),
    };
    this.markDirty();
  }

  errorAgent(id: string, message: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    this.blocks[idx] = { ...agent, status: "error", errorMessage: message };
    this.markDirty();
  }

  /** Update agent's latestChild display without adding a child block. */
  updateAgentLatestChild(id: string, childDisplay: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    if (agent.kind !== "agent" || agent.status !== "active") return;

    this.blocks[idx] = { ...agent, latestChild: childDisplay };
    this.markDirty();
  }

  /** Auto-complete active subagent blocks (top-level output means all subagents are done). */
  closeOpenSubagents(timestamp: number): void {
    const ctxId = this.contextTracker.currentAgentId;
    for (const [id, idx] of this.agentIndexById) {
      if (id === ctxId) continue;
      const block = this.blocks[idx];
      if (block.kind === "agent" && block.status === "active") {
        this.completeAgent(id, timestamp - block.timestamp);
      }
    }
  }

  /** Complete any open context tool run at turn boundaries. */
  flushContextRun(timestamp: number): void {
    this.contextTracker.breakContextRun(timestamp);
    this.markDirty();
  }

  getBlocks(): AnyBlock[] {
    if (!this.dirty) return this.cachedSnapshot;
    this.dirty = false;
    this.cachedSnapshot = [...this.blocks];
    return this.cachedSnapshot;
  }

  hasChanged(): boolean {
    return this.dirty;
  }

  /** Full reset — wipes blocks and tracking state. */
  reset(): void {
    this.blocks = [];
    this.dirty = false;
    this.cachedSnapshot = [];
    this.agentIndexById.clear();
    this.todoBlockIndex = -1;
    this.contextTracker.reset();
  }

  /** Reset worker-level tracking state, preserving accumulated blocks. */
  resetTracking(): void {
    this.agentIndexById.clear();
    this.todoBlockIndex = -1;
    this.contextTracker.resetTracking();
    this.dirty = true;
    this.cachedSnapshot = [];
  }

  // ── Private helpers ──

  private insertBlock(block: AnyBlock): number {
    const result = insertBlockBeforePinned(this.blocks, block, this.agentIndexById, this.todoBlockIndex);
    this.todoBlockIndex = result.todoBlockIndex;
    return result.index;
  }

  private lastContentIndex(): number {
    return contentInsertionIndex(this.blocks) - 1;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private enforceBlocksCap(): void {
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
