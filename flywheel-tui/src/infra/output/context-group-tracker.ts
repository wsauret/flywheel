// Decoupled from StructuredOutputBuilder via callbacks so grouping
// logic can be tested and reasoned about without block storage concerns.

import type { ToolBlock } from "../output-blocks.js"

/** Tool names that break context grouping. */
const NON_CONTEXT_TOOL_NAMES = new Set(["task_complete"])

export function isContextTool(name: string): boolean {
  return !NON_CONTEXT_TOOL_NAMES.has(name.toLowerCase())
}

interface ContextGroupCallbacks {
  startContextAgent: (id: string, timestamp: number) => void
  appendToolToContextAgent: (agentId: string, tool: ToolBlock) => void
  // Tool count is derived from children.length
  completeContextAgent: (agentId: string, duration: number) => void
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

  get currentAgentId(): string | null {
    return this.contextAgentId
  }

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

  /** Completes the synthetic "Tools" agent block with duration and tool count. */
  breakContextRun(timestamp: number): void {
    if (this.contextAgentId === null) return

    const id = this.contextAgentId
    const duration = timestamp - this.contextRunStartTime
    this.callbacks.completeContextAgent(id, duration)
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

  handleEviction(agentExists: boolean): void {
    if (this.contextAgentId !== null && !agentExists) {
      this.contextAgentId = null
    }
  }
}
