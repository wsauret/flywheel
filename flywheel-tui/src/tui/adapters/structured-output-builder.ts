/**
 * Structured Output Builder
 *
 * Accumulates parsed engine output into structured blocks (TextBlock, ToolBlock,
 * AgentBlock, ContextGroupBlock) for display in the TUI output window.
 *
 * Manages all mutations internally — exposes only `getBlocks()` which returns
 * a new array reference when dirty, enabling efficient SolidJS reactivity via
 * `setOutputBlocks(builder.getBlocks())`.
 *
 * Context grouping: 3+ consecutive Read/Glob/Grep tools are collapsed into a
 * single ContextGroupBlock. Maintains a pointer for O(1) appending.
 */

import type {
  AnyBlock,
  TextBlock,
  ToolBlock,
  AgentBlock,
  ContextGroupBlock,
} from "../routes/work/state/types";

const BLOCKS_CAP = 5000;
const AGENT_CHILDREN_CAP = 50;
const CONTEXT_GROUP_THRESHOLD = 3;

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
   * Tracks consecutive context tools for grouping.
   * `contextRunStart` is the index in `blocks` where the current run of
   * consecutive context tools begins. -1 means no active run.
   * `contextRunLength` is the count of consecutive context tools in the run.
   */
  private contextRunStart = -1;
  private contextRunLength = 0;

  // ── Public API ──

  pushText(text: string, timestamp: number): void {
    this.breakContextRun();

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

  pushTool(name: string, detail: string, timestamp: number): void {
    const tool: ToolBlock = { kind: "tool", name, detail, timestamp };

    // If inside an active agent, add as child
    if (this.activeAgentId !== null) {
      if (this.appendToolToAgent(this.activeAgentId, tool)) return;
    }

    // Top-level tool: check context grouping
    if (isContextTool(name)) {
      this.pushContextTool(tool);
    } else {
      this.breakContextRun();
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
    let children = [...agent.children, tool];
    if (children.length > AGENT_CHILDREN_CAP) {
      children = children.slice(children.length - AGENT_CHILDREN_CAP);
    }
    // Update latestChild for live display (single-line "↳ ToolName: detail")
    const latestChild = `${tool.name}: ${tool.detail}`;
    this.blocks[agentIdx] = { ...agent, children, latestChild };
    this.markDirty();
    return true;
  }

  startAgent(id: string, agentLabel: string, description: string, timestamp: number): void {
    this.breakContextRun();

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
  }

  updateAgentLatestChild(id: string, childDisplay: string): void {
    const idx = this.agentIndexById.get(id);
    if (idx === undefined) return;

    const agent = this.blocks[idx] as AgentBlock;
    this.blocks[idx] = { ...agent, latestChild: childDisplay };
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

  reset(): void {
    this.blocks = [];
    this.dirty = false;
    this.cachedSnapshot = [];
    this.activeAgentId = null;
    this.agentIndexById.clear();
    this.contextRunStart = -1;
    this.contextRunLength = 0;
  }

  // ── Context grouping (private) ──

  /**
   * Push a context tool (Read/Glob/Grep) and manage grouping.
   * When 3+ consecutive context tools accumulate, they are collapsed
   * into a ContextGroupBlock in-place.
   */
  private pushContextTool(tool: ToolBlock): void {
    if (this.contextRunStart === -1) {
      // Start a new potential context run
      this.contextRunStart = this.blocks.length;
      this.contextRunLength = 1;
      this.blocks.push(tool);
    } else {
      this.contextRunLength++;

      if (this.contextRunLength === CONTEXT_GROUP_THRESHOLD) {
        // Collapse the previous standalone ToolBlocks into a group
        const startIdx = this.contextRunStart;
        const tools = this.blocks.slice(startIdx) as ToolBlock[];
        tools.push(tool);

        const group: ContextGroupBlock = {
          kind: "contextGroup",
          tools,
          timestamp: tools[0].timestamp,
        };

        // Replace the run with a single group block
        this.blocks.splice(startIdx, this.contextRunLength - 1, group);
        // Update contextRunStart to point to the group
        this.contextRunStart = startIdx;
      } else if (this.contextRunLength > CONTEXT_GROUP_THRESHOLD) {
        // Append to existing ContextGroupBlock
        const group = this.blocks[this.contextRunStart] as ContextGroupBlock;
        this.blocks[this.contextRunStart] = {
          ...group,
          tools: [...group.tools, tool],
        };
      } else {
        // contextRunLength < CONTEXT_GROUP_THRESHOLD — just append as standalone
        this.blocks.push(tool);
      }
    }
  }

  /**
   * Break the current context run. Called when a non-context item is pushed.
   */
  private breakContextRun(): void {
    this.contextRunStart = -1;
    this.contextRunLength = 0;
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
      // Reset context run tracking since indices shifted
      if (this.contextRunStart !== -1) {
        this.contextRunStart = Math.max(0, this.contextRunStart - overflow);
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
