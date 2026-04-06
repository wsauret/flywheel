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
 * Context grouping and stale agent detection are delegated to dedicated helpers
 * (ContextGroupTracker and StaleAgentDetector) to keep this module focused on
 * block accumulation.
 */

import type {
  AnyBlock,
  TextBlock,
  ToolBlock,
  AgentBlock,
  SystemBlock,
} from "../types.js";
import { StaleAgentDetector } from "./stale-agent-detector.js";
import { ContextGroupTracker, isContextTool } from "./context-group-tracker.js";

const BLOCKS_CAP = 5000;
const AGENT_CHILDREN_CAP = 50;

import type { ModelActivity } from "../../infra/events.js";
export type { ModelActivity };

export class StructuredOutputBuilder {
  private blocks: AnyBlock[] = [];
  private dirty = false;
  private cachedSnapshot: AnyBlock[] = [];

  /** Map of agent ID → index in `blocks` for O(1) agent lookups. */
  private activeAgentId: string | null = null;
  private agentIndexById = new Map<string, number>();

  /** Stale agent detection — auto-completes agents with no activity. */
  private readonly staleDetector: StaleAgentDetector;

  /** Context tool grouping — groups consecutive context tools into synthetic AgentBlocks. */
  private readonly contextTracker: ContextGroupTracker;

  /**
   * Optional callback fired when an agent has activity (tool added).
   * Notification-only — does not alter accumulator behavior.
   */
  onAgentActivity?: (agentId: string) => void;

  /**
   * Optional callback fired on agent lifecycle transitions.
   * Notification-only — does not alter accumulator behavior.
   */
  onAgentLifecycle?: (type: "start" | "complete" | "error", agentId: string) => void;

  /**
   * Optional callback fired when model activity changes.
   * Used by the TUI to show context-aware thinking/generating indicators.
   */
  onModelActivityChange?: (activity: ModelActivity) => void;

  constructor() {
    this.staleDetector = new StaleAgentDetector({
      onStaleAgent: (agentId, durationMs) => this.completeAgent(agentId, durationMs, 0),
    });

    this.contextTracker = new ContextGroupTracker({
      startContextAgent: (id, timestamp) => this.startAgent(id, "Tools", "Using tools...", timestamp),
      appendToolToContextAgent: (agentId, tool) => this.appendToolToAgent(agentId, tool),
      completeContextAgent: (agentId, duration, toolCount) => this.completeAgent(agentId, duration, toolCount),
      getContextAgentChildCount: (agentId) => {
        const idx = this.agentIndexById.get(agentId);
        if (idx === undefined) return 0;
        return (this.blocks[idx] as AgentBlock).children.length;
      },
    });
  }

  // ── Public API ──

  pushThinking(text: string, timestamp: number): void {
    this.onModelActivityChange?.("thinking");
    if (!text.trim()) return;
    const last = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1] : null;
    if (last && last.kind === "thinking") {
      this.blocks[this.blocks.length - 1] = { ...last, content: last.content + text };
    } else {
      this.blocks.push({ kind: "thinking", content: text, timestamp });
    }
    this.dirty = true;
  }

  pushUserMessage(text: string, timestamp: number, pending?: boolean): void {
    this.contextTracker.breakContextRun(timestamp);
    this.blocks.push({ kind: "userMessage", content: text, timestamp, pending });
    this.dirty = true;
  }

  /** Transition all pending user messages to sent (pending = false). */
  resolvePendingMessages(): boolean {
    let resolved = false;
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (b.kind === "userMessage" && b.pending) {
        this.blocks[i] = { ...b, pending: false };
        resolved = true;
      }
    }
    if (resolved) this.dirty = true;
    return resolved;
  }

  pushText(text: string, timestamp: number): void {
    this.onModelActivityChange?.("generating");
    this.contextTracker.breakContextRun(timestamp);

    const last = this.blocks[this.blocks.length - 1];
    if (last && last.kind === "text") {
      this.blocks[this.blocks.length - 1] = {
        ...last,
        content: last.content + text,
      };
    } else {
      this.blocks.push({ kind: "text", content: text, timestamp });
    }

    this.markDirty();
  }

  /**
   * Push a system message as a SystemBlock.
   * Used for lifecycle events (queue:step-started, dispatcher:invoked, etc.)
   * that are user-relevant but not worker output.
   */
  pushSystemMessage(message: string, timestamp: number): void {
    this.contextTracker.breakContextRun(timestamp);
    this.blocks.push({ kind: "system", message, timestamp } as SystemBlock);
    this.enforceBlocksCap();
    this.markDirty();
  }

  pushTool(name: string, detail: string, timestamp: number, diff?: string, filetype?: string): void {
    this.onModelActivityChange?.("tool_executing");
    const tool: ToolBlock = { kind: "tool", name, detail, timestamp, ...(diff && { diff }), ...(filetype && { filetype }) };

    // If inside an active (real) agent, add as child — context tools inside
    // real agents stay as plain children, not grouped.
    if (this.activeAgentId !== null && this.activeAgentId !== this.contextTracker.currentAgentId) {
      if (this.appendToolToAgent(this.activeAgentId, tool)) return;
    }

    // Top-level tool: check context grouping.
    // Tools with diff data render standalone (not grouped) so the diff is visible.
    if (isContextTool(name) && !diff) {
      this.contextTracker.pushContextTool(tool, timestamp);
    } else {
      this.contextTracker.breakContextRun(timestamp);
      this.blocks.push(tool);
    }

    this.enforceBlocksCap();
    this.markDirty();
  }

  /**
   * Push a tool as a child of a specific agent (by builder agent ID).
   * Used when Claude's `parent_tool_use_id` identifies the owning agent.
   * Returns false if the agent was not found (caller should fall through to top-level).
   */
  pushToolToAgent(agentId: string, name: string, detail: string, timestamp: number, diff?: string, filetype?: string): boolean {
    const tool: ToolBlock = { kind: "tool", name, detail, timestamp, ...(diff && { diff }), ...(filetype && { filetype }) };
    return this.appendToolToAgent(agentId, tool);
  }

  /** Internal: append a tool to a specific agent's children. Returns true if successful. */
  private appendToolToAgent(agentId: string, tool: ToolBlock): boolean {
    const agentIdx = this.agentIndexById.get(agentId);
    if (agentIdx === undefined) return false;

    const agent = this.blocks[agentIdx] as AgentBlock;
    const children = agent.children;
    children.push(tool);
    if (children.length > AGENT_CHILDREN_CAP) {
      children.splice(0, children.length - AGENT_CHILDREN_CAP);
    }
    const latestChild = `${tool.name}: ${tool.detail}`;
    const description = `${tool.name}: ${tool.detail}`;
    this.blocks[agentIdx] = { ...agent, children, latestChild, description };
    this.markDirty();
    this.staleDetector.trackActivity(agentId);
    this.onAgentActivity?.(agentId);
    return true;
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
    this.blocks.push(agent);
    this.agentIndexById.set(id, this.blocks.length - 1);
    this.activeAgentId = id;
    this.staleDetector.trackSpawn(id);
    this.enforceBlocksCap();
    this.markDirty();
    this.onAgentLifecycle?.("start", id);
  }

  completeAgent(id: string, duration: number, toolCount: number): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    if (agent.status !== "active") return;
    const actualCount = toolCount > 0 ? toolCount : agent.children.length;
    this.blocks[idx] = { ...agent, status: "completed", duration, toolCount: actualCount };

    this.staleDetector.removeAgent(id);
    if (this.activeAgentId === id) {
      this.activeAgentId = null;
    }
    this.markDirty();
    this.onAgentLifecycle?.("complete", id);
  }

  errorAgent(id: string, message: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    this.blocks[idx] = { ...agent, status: "error", errorMessage: message };

    if (this.activeAgentId === id) {
      this.activeAgentId = null;
    }
    this.staleDetector.removeAgent(id);
    this.markDirty();
    this.onAgentLifecycle?.("error", id);
  }

  /**
   * Update the latestChild display text on an agent block without adding a child.
   * Used for status updates like thinking text that shouldn't accumulate as tool entries.
   * Also triggers onAgentActivity to keep the stale-agent tracker alive.
   */
  updateAgentLatestChild(id: string, childDisplay: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    if (agent.kind !== "agent" || agent.status !== "active") return;

    this.blocks[idx] = { ...agent, latestChild: childDisplay };
    this.markDirty();
    this.onAgentActivity?.(id);
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

  /**
   * Full reset — wipes blocks AND tracking state.
   * Used when starting a fresh standalone workflow (standalone).
   */
  reset(): void {
    this.blocks = [];
    this.dirty = false;
    this.cachedSnapshot = [];
    this.activeAgentId = null;
    this.agentIndexById.clear();
    this.contextTracker.reset();
    this.staleDetector.clearTracking();
  }

  /** Stop the stale check interval and clean up. Call when the builder is no longer needed. */
  dispose(): void {
    this.staleDetector.dispose();
  }

  /**
   * Reset only worker-level tracking state, preserving accumulated blocks.
   * Used at queue step boundaries: a new worker means new agent IDs and
   * context runs, but the output log is continuous.
   */
  resetTracking(): void {
    this.activeAgentId = null;
    this.agentIndexById.clear();
    this.contextTracker.resetTracking();
    this.dirty = true;
    this.cachedSnapshot = [];
  }

  // ── Private helpers ──

  private markDirty(): void {
    this.dirty = true;
  }

  private enforceBlocksCap(): void {
    if (this.blocks.length > BLOCKS_CAP) {
      const overflow = this.blocks.length - BLOCKS_CAP;
      this.blocks.splice(0, overflow);
      this.rebuildAgentIndex();
      const ctxId = this.contextTracker.currentAgentId;
      if (ctxId !== null) {
        this.contextTracker.handleEviction(this.agentIndexById.has(ctxId));
      }
    }
  }

  private rebuildAgentIndex(): void {
    this.agentIndexById.clear();
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      if (block.kind === "agent") {
        this.agentIndexById.set(block.id, i);
      }
    }
  }
}
