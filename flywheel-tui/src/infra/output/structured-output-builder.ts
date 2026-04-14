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

function buildToolBlock(name: string, detail: string, timestamp: number, diff?: string, filetype?: string, content?: string, filePath?: string): ToolBlock {
  return { kind: "tool", name, detail, timestamp, ...(filePath && { filePath }), ...(diff && { diff }), ...(content && { content }), ...(filetype && { filetype }) };
}

export class StructuredOutputBuilder {
  private blocks: AnyBlock[] = [];
  private dirty = false;
  private cachedSnapshot: AnyBlock[] = [];

  private agentIndexById = new Map<string, number>();
  private todoBlockIndex = -1;
  private readonly contextTracker: ContextGroupTracker;

  private _modelActivity: ModelActivity = "idle";
  private thinkingStartedAt: number | null = null;

  constructor() {
    this.contextTracker = new ContextGroupTracker({
      startContextAgent: (id, timestamp) => this.startAgent(id, "Tools", "Using tools...", timestamp),
      appendToolToContextAgent: (agentId, tool) => this.appendToolToAgent(agentId, tool),
      completeContextAgent: (agentId, duration) => this.completeAgent(agentId, duration),
    });
  }

  get modelActivity(): ModelActivity { return this._modelActivity; }

  resetActivity(): void {
    this._modelActivity = "idle";
  }

  notifyThinkingStarted(timestamp: number): void {
    this._modelActivity = "thinking";
    if (this.thinkingStartedAt === null) {
      this.thinkingStartedAt = timestamp;
    }
  }

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

  // Moves injected messages from pending to resolved once the subprocess acknowledges them.
  resolvePendingMessages(): boolean {
    const pendingIndices: number[] = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (b.kind === "userMessage" && b.pending) {
        pendingIndices.push(i);
      }
    }
    if (pendingIndices.length === 0) return false;

    const resolved: AnyBlock[] = [];
    for (let i = pendingIndices.length - 1; i >= 0; i--) {
      const [msg] = this.blocks.splice(pendingIndices[i]!, 1) as [UserMessageBlock];
      resolved.unshift({ ...msg, pending: false });
    }
    const todoIdx = this.blocks.findIndex(b => b.kind === "todoList");
    if (todoIdx >= 0) {
      this.blocks.splice(todoIdx, 0, ...resolved);
    } else {
      this.blocks.push(...resolved);
    }

    rebuildAgentIndex(this.blocks, this.agentIndexById);
    this.todoBlockIndex = findTodoIndex(this.blocks);
    this.dirty = true;
    return true;
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

    this.dirty = true;
  }

  pushSystemMessage(message: string, timestamp: number): void {
    this.contextTracker.breakContextRun(timestamp);
    this.insertBlock({ kind: "system", message, timestamp } as SystemBlock);
    this.enforceBlocksCap();
    this.dirty = true;
  }

  pushTool(name: string, detail: string, timestamp: number, diff?: string, filetype?: string, content?: string, filePath?: string): void {
    this._modelActivity = "tool_executing";
    const tool = buildToolBlock(name, detail, timestamp, diff, filetype, content, filePath);

    // Tools with diff/content data render standalone (not grouped) so the content is visible.
    if (isContextTool(name) && !diff && !content) {
      this.contextTracker.pushContextTool(tool, timestamp);
    } else {
      this.contextTracker.breakContextRun(timestamp);
      this.insertBlock(tool);
    }

    this.enforceBlocksCap();
    this.dirty = true;
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
      this.dirty = true;
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
    this.dirty = true;
  }

  pushToolToAgent(agentId: string, name: string, detail: string, timestamp: number, diff?: string, filetype?: string, content?: string, filePath?: string): boolean {
    const tool = buildToolBlock(name, detail, timestamp, diff, filetype, content, filePath);
    return this.appendToolToAgent(agentId, tool);
  }

  private appendToolToAgent(agentId: string, tool: ToolBlock): boolean {
    const ok = appendToolToAgentChildren(this.blocks, this.agentIndexById, agentId, tool, AGENT_CHILDREN_CAP);
    if (ok) this.dirty = true;
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
    this.dirty = true;
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
    this.dirty = true;
  }

  errorAgent(id: string, message: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    this.blocks[idx] = { ...agent, status: "error", errorMessage: message };
    this.dirty = true;
  }

  updateAgentLatestChild(id: string, childDisplay: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    if (agent.kind !== "agent" || agent.status !== "active") return;

    this.blocks[idx] = { ...agent, latestChild: childDisplay };
    this.dirty = true;
  }

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

  flushContextRun(timestamp: number): void {
    this.contextTracker.breakContextRun(timestamp);
    this.dirty = true;
  }

  getBlocks(): AnyBlock[] {
    if (!this.dirty) return this.cachedSnapshot;
    this.dirty = false;
    this.cachedSnapshot = [...this.blocks];
    return this.cachedSnapshot;
  }

  reset(): void {
    this.blocks = [];
    this.dirty = false;
    this.cachedSnapshot = [];
    this.agentIndexById.clear();
    this.todoBlockIndex = -1;
    this.contextTracker.reset();
  }

  // Preserves blocks for display continuity across subprocess restarts; only rebuilds index maps.
  resetTracking(): void {
    this.agentIndexById.clear();
    this.todoBlockIndex = -1;
    this.contextTracker.resetTracking();
    this.dirty = true;
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
