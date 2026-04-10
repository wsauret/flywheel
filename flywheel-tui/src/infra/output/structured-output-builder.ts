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
} from "../output-blocks.js";
import { StaleAgentDetector } from "./stale-agent-detector.js";
import { ContextGroupTracker, isContextTool } from "./context-group-tracker.js";

const BLOCKS_CAP = 20_000;
const AGENT_CHILDREN_CAP = 50;

import type { ModelActivity } from "../events.js";

export class StructuredOutputBuilder {
  private blocks: AnyBlock[] = [];
  private dirty = false;
  private cachedSnapshot: AnyBlock[] = [];

  /** Map of agent ID → index in `blocks` for O(1) agent lookups. */
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

  /** Timestamp captured when thinking activity starts (before text arrives). */
  private thinkingStartedAt: number | null = null;

  constructor() {
    this.staleDetector = new StaleAgentDetector({
      onStaleAgent: (agentId, durationMs) => this.completeAgent(agentId, durationMs),
    });

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
    const last = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1] : null;
    if (last && last.kind === "thinking") {
      this.blocks[this.blocks.length - 1] = { ...last, content: last.content + text };
    } else {
      this.blocks.push({ kind: "thinking", content: text, timestamp: blockTimestamp });
    }
    this.dirty = true;
  }

  pushUserMessage(text: string, timestamp: number, pending?: boolean, injected?: boolean): void {
    this.contextTracker.breakContextRun(timestamp);
    this.blocks.push({ kind: "userMessage", content: text, timestamp, pending, injected });
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
    this.thinkingStartedAt = null;
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

  pushTool(name: string, detail: string, timestamp: number, diff?: string, filetype?: string, content?: string, filePath?: string): void {
    this.onModelActivityChange?.("tool_executing");
    const tool: ToolBlock = { kind: "tool", name, detail, timestamp, ...(filePath && { filePath }), ...(diff && { diff }), ...(content && { content }), ...(filetype && { filetype }) };

    // Top-level tool: check context grouping.
    // Tools with diff/content data render standalone (not grouped) so the content is visible.
    if (isContextTool(name) && !diff && !content) {
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
  pushToolToAgent(agentId: string, name: string, detail: string, timestamp: number, diff?: string, filetype?: string, content?: string, filePath?: string): boolean {
    const tool: ToolBlock = { kind: "tool", name, detail, timestamp, ...(filePath && { filePath }), ...(diff && { diff }), ...(content && { content }), ...(filetype && { filetype }) };
    return this.appendToolToAgent(agentId, tool);
  }

  /** Internal: append a tool to a specific agent's children. Returns true if successful. */
  private appendToolToAgent(agentId: string, tool: ToolBlock): boolean {
    const agentIdx = this.agentIndexById.get(agentId);
    if (agentIdx === undefined) return false;

    const agent = this.blocks[agentIdx] as AgentBlock;
    // Create a new array reference so SolidJS <For> detects the change.
    // Mutating in place keeps the same reference, which <For> ignores.
    let children = [...agent.children, tool];
    if (children.length > AGENT_CHILDREN_CAP) {
      children = children.slice(-AGENT_CHILDREN_CAP);
    }
    const latestChild = `${tool.name}: ${tool.detail}`;

    // Re-activate agents that were prematurely completed by the stale detector.
    // The authoritative completion signal is the tool_result event, not the timeout.
    if (agent.status === "completed") {
      this.blocks[agentIdx] = { ...agent, status: "active", children, latestChild };
      this.staleDetector.trackSpawn(agentId);
    } else {
      this.blocks[agentIdx] = { ...agent, children, latestChild };
      if (agent.status === "active") {
        this.staleDetector.trackActivity(agentId);
      }
    }

    this.markDirty();
    this.onAgentActivity?.(agentId);
    return true;
  }

  startAgent(id: string, agentLabel: string, description: string, timestamp: number, opts?: { skipStaleDetection?: boolean }): void {
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
    if (!opts?.skipStaleDetection) {
      this.staleDetector.trackSpawn(id);
    }
    this.enforceBlocksCap();
    this.markDirty();
    this.onAgentLifecycle?.("start", id);
  }

  completeAgent(id: string, duration: number, description?: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    if (agent.status === "completed") {
      // Already completed (e.g. by stale detector) — update duration if the
      // authoritative signal (tool_result) arrives later with a better value.
      if (duration > (agent.duration ?? 0)) {
        this.blocks[idx] = { ...agent, duration };
        this.markDirty();
      }
      return;
    }
    if (agent.status !== "active") return;

    this.blocks[idx] = {
      ...agent,
      status: "completed",
      duration,
      ...(description !== undefined ? { description } : {}),
    };
    this.staleDetector.removeAgent(id);
    this.markDirty();
    this.onAgentLifecycle?.("complete", id);
  }

  errorAgent(id: string, message: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    this.blocks[idx] = { ...agent, status: "error", errorMessage: message };

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
    this.staleDetector.trackActivity(id);
    this.onAgentActivity?.(id);
  }

  /**
   * Auto-complete any active subagent blocks.
   *
   * Subagents are blocking — if top-level output arrives from the parent agent,
   * all subagents must be done. Call this when processing a top-level assistant
   * message (no parent_tool_use_id) to close agents whose tool_result was
   * delayed or lost. The stale detector remains as a safety net for cases where
   * no top-level events follow.
   */
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

  /**
   * Complete any open context tool run. Call at turn boundaries (e.g. chat
   * turn-complete) so the last group of context tools doesn't stay "active".
   */
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

  /**
   * Full reset — wipes blocks AND tracking state.
   * Used when starting a fresh standalone workflow (standalone).
   */
  reset(): void {
    this.blocks = [];
    this.dirty = false;
    this.cachedSnapshot = [];
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
