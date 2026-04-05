/**
 * Context Group Tracker
 *
 * Tracks context tool grouping state: consecutive Read/Glob/Grep/etc. tools
 * are rendered as a synthetic "Tools" AgentBlock. This module manages the
 * context run lifecycle (start, accumulate, break) without knowing about
 * block storage — it delegates actual block mutations to the builder via callbacks.
 *
 * Extracted from StructuredOutputBuilder to isolate grouping logic from
 * block accumulation.
 */

import type { ToolBlock } from "../types.js"

/** Tool names that break context grouping. */
const NON_CONTEXT_TOOL_NAMES = new Set(["task_complete"])

export function isContextTool(name: string): boolean {
  return !NON_CONTEXT_TOOL_NAMES.has(name.toLowerCase())
}

export interface ContextGroupCallbacks {
  /** Start a new synthetic agent block for context tools. Returns the generated agent ID. */
  startContextAgent: (id: string, timestamp: number) => void
  /** Append a tool as a child of the current context agent. */
  appendToolToContextAgent: (agentId: string, tool: ToolBlock) => void
  /** Complete the context agent with duration and tool count. */
  completeContextAgent: (agentId: string, duration: number, toolCount: number) => void
  /** Get the number of children for the current context agent. */
  getContextAgentChildCount: (agentId: string) => number
}

export class ContextGroupTracker {
  /** The agent ID for the current context run, or null if no run is active. */
  private contextAgentId: string | null = null
  /** Increments to generate unique IDs across runs. */
  private contextRunCounter = 0
  /** When the current run started (for duration calculation). */
  private contextRunStartTime = 0

  private readonly callbacks: ContextGroupCallbacks

  constructor(callbacks: ContextGroupCallbacks) {
    this.callbacks = callbacks
  }

  /** The current context agent ID, or null if no run is active. */
  get currentAgentId(): string | null {
    return this.contextAgentId
  }

  /**
   * Push a context tool into the current run, starting a new run if needed.
   * Returns the context agent ID.
   */
  pushContextTool(tool: ToolBlock, timestamp: number): string {
    if (this.contextAgentId === null) {
      this.contextRunCounter++
      const id = `ctx-run-${this.contextRunCounter}`
      this.contextRunStartTime = timestamp
      this.callbacks.startContextAgent(id, timestamp)
      this.contextAgentId = id
    }

    this.callbacks.appendToolToContextAgent(this.contextAgentId, tool)
    return this.contextAgentId
  }

  /**
   * Break the current context run. Called when a non-context item is pushed.
   * Completes the synthetic "Tools" agent block with duration and tool count.
   */
  breakContextRun(timestamp: number): void {
    if (this.contextAgentId === null) return

    const id = this.contextAgentId
    const duration = timestamp - this.contextRunStartTime
    const childCount = this.callbacks.getContextAgentChildCount(id)
    this.callbacks.completeContextAgent(id, duration, childCount)
    this.contextAgentId = null
  }

  /** Reset context tracking state (preserves counter for unique IDs). */
  resetTracking(): void {
    this.contextAgentId = null
    this.contextRunStartTime = 0
  }

  /** Full reset — clears everything including counter. */
  reset(): void {
    this.contextAgentId = null
    this.contextRunCounter = 0
    this.contextRunStartTime = 0
  }

  /** Check if the given agent ID was evicted and clear tracking if so. */
  handleEviction(agentExists: boolean): void {
    if (this.contextAgentId !== null && !agentExists) {
      this.contextAgentId = null
    }
  }
}
