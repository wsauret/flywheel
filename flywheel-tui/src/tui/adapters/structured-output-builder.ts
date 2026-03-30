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
 * Context grouping: Consecutive Read/Glob/Grep/WebSearch/WebFetch tools are
 * rendered as a synthetic AgentBlock ("Context") with live tool display — each
 * tool call replaces the previous in the `latestChild` field (spinner + ↳ line).
 * When context gathering ends (non-context item arrives), the block shows a
 * completed summary: `✓ Context · N toolcalls · Xs`.
 */

import type {
  AnyBlock,
  TextBlock,
  ToolBlock,
  AgentBlock,
  SystemBlock,
} from "../routes/work/state/types";

const BLOCKS_CAP = 5000;
const AGENT_CHILDREN_CAP = 50;

/** Tool names that qualify for context grouping (matched case-insensitively). */
const CONTEXT_TOOL_NAMES = new Set(["read", "glob", "grep", "websearch", "webfetch"]);

function isContextTool(name: string): boolean {
  return CONTEXT_TOOL_NAMES.has(name.toLowerCase());
}

export class StructuredOutputBuilder {
  private blocks: AnyBlock[] = [];
  private dirty = false;
  private cachedSnapshot: AnyBlock[] = [];

  /**
   * Map of agent ID → index in `blocks` for O(1) agent lookups.
   * Cleared on reset.
   */
  private activeAgentId: string | null = null;
  private agentIndexById = new Map<string, number>();

  /**
   * Tracks the active context agent block (synthetic AgentBlock for context tool runs).
   * `contextAgentId` is the agent ID for the current run, or null if no run is active.
   * `contextRunCounter` increments to generate unique IDs across runs.
   * `contextRunStartTime` tracks when the run started for duration calculation.
   */
  private contextAgentId: string | null = null;
  private contextRunCounter = 0;
  private contextRunStartTime = 0;

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

  // ── Public API ──

  pushText(text: string, timestamp: number): void {
    this.breakContextRun(timestamp);

    const last = this.blocks[this.blocks.length - 1];
    if (last && last.kind === "text") {
      // Extend existing TextBlock (create new object for immutability)
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
    this.breakContextRun(timestamp);
    this.blocks.push({ kind: "system", message, timestamp } as SystemBlock);
    this.enforceBlocksCap();
    this.markDirty();
  }

  pushTool(name: string, detail: string, timestamp: number): void {
    const tool: ToolBlock = { kind: "tool", name, detail, timestamp };

    // If inside an active (real) agent, add as child — context tools inside
    // real agents stay as plain children, not grouped.
    if (this.activeAgentId !== null && this.activeAgentId !== this.contextAgentId) {
      if (this.appendToolToAgent(this.activeAgentId, tool)) return;
    }

    // Top-level tool: check context grouping
    if (isContextTool(name)) {
      this.pushContextTool(tool, timestamp);
    } else {
      this.breakContextRun(timestamp);
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
  pushToolToAgent(agentId: string, name: string, detail: string, timestamp: number): boolean {
    const tool: ToolBlock = { kind: "tool", name, detail, timestamp };
    return this.appendToolToAgent(agentId, tool);
  }

  /** Internal: append a tool to a specific agent's children. Returns true if successful. */
  private appendToolToAgent(agentId: string, tool: ToolBlock): boolean {
    const agentIdx = this.agentIndexById.get(agentId);
    if (agentIdx === undefined) return false;

    const agent = this.blocks[agentIdx] as AgentBlock;
    // Mutate in-place: push + splice (O(1) amortized vs O(n) spread)
    const children = agent.children;
    children.push(tool);
    if (children.length > AGENT_CHILDREN_CAP) {
      children.splice(0, children.length - AGENT_CHILDREN_CAP);
    }
    // Update latestChild for live display (single-line "↳ ToolName: detail")
    const latestChild = `${tool.name}: ${tool.detail}`;
    this.blocks[agentIdx] = { ...agent, children, latestChild };
    this.markDirty();
    this.onAgentActivity?.(agentId);
    return true;
  }

  startAgent(id: string, agentLabel: string, description: string, timestamp: number): void {
    this.breakContextRun(timestamp);

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
    this.enforceBlocksCap();
    this.markDirty();
    this.onAgentLifecycle?.("start", id);
  }

  completeAgent(id: string, duration: number, toolCount: number): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    // Use actual children count if caller passes 0 (common when count isn't known upstream)
    const actualCount = toolCount > 0 ? toolCount : agent.children.length;
    this.blocks[idx] = { ...agent, status: "completed", duration, toolCount: actualCount };

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
    this.contextAgentId = null;
    this.contextRunCounter = 0;
    this.contextRunStartTime = 0;
  }

  /**
   * Reset only worker-level tracking state, preserving accumulated blocks.
   * Used at queue step boundaries: a new worker means new agent IDs and
   * context runs, but the output log is continuous.
   */
  resetTracking(): void {
    this.activeAgentId = null;
    this.agentIndexById.clear();
    this.contextAgentId = null;
    this.contextRunStartTime = 0;
    // Mark dirty so the next getBlocks() returns a fresh snapshot
    // (tracking changes may affect how subsequent blocks are grouped).
    this.dirty = true;
    this.cachedSnapshot = [];
  }

  // ── Context grouping (private) ──

  /**
   * Push a context tool as a child of the synthetic "Context" agent block.
   * On first context tool, creates a new AgentBlock. Subsequent tools update
   * `latestChild` in place (live display like subagent traces).
   */
  private pushContextTool(tool: ToolBlock, timestamp: number): void {
    if (this.contextAgentId === null) {
      // Start a new context agent run
      this.contextRunCounter++;
      const id = `ctx-run-${this.contextRunCounter}`;
      this.contextRunStartTime = timestamp;

      // Create the synthetic agent block via startAgent (contextAgentId is still
      // null, so startAgent's breakContextRun is a no-op). Set contextAgentId
      // AFTER startAgent to avoid premature completion.
      this.startAgent(id, "Context", "Gathering context...", timestamp);
      this.contextAgentId = id;
    }

    // Add the tool as a child of the context agent (updates latestChild)
    this.appendToolToAgent(this.contextAgentId, tool);
  }

  /**
   * Break the current context run. Called when a non-context item is pushed.
   * Completes the synthetic "Context" agent block with duration and tool count.
   */
  private breakContextRun(timestamp: number): void {
    if (this.contextAgentId === null) return;

    const id = this.contextAgentId;
    const agentIdx = this.agentIndexById.get(id);
    if (agentIdx !== undefined) {
      const agent = this.blocks[agentIdx] as AgentBlock;
      const duration = timestamp - this.contextRunStartTime;
      this.completeAgent(id, duration, agent.children.length);
    }

    this.contextAgentId = null;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private enforceBlocksCap(): void {
    if (this.blocks.length > BLOCKS_CAP) {
      const overflow = this.blocks.length - BLOCKS_CAP;
      this.blocks.splice(0, overflow);
      // Rebuild agent index map since indices shifted
      this.rebuildAgentIndex();
      // If the context agent was evicted, clear its tracking
      if (this.contextAgentId !== null && !this.agentIndexById.has(this.contextAgentId)) {
        this.contextAgentId = null;
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
