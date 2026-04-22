import type { ToolEntry } from "../output-blocks.js"

interface ContextGroupCallbacks {
  startContextAgent: (id: string, timestamp: number) => void
  appendToolToContextAgent: (agentId: string, tool: ToolEntry) => void
  completeContextAgent: (agentId: string, duration: number) => void
  pauseContextAgent: (agentId: string, duration: number) => void
}

export class ContextGroupTracker {
  private contextAgentId: string | null = null
  private contextRunCounter = 0
  private contextRunStartTime = 0

  private readonly callbacks: ContextGroupCallbacks

  constructor(callbacks: ContextGroupCallbacks) {
    this.callbacks = callbacks
  }

  get currentAgentId(): string | null {
    return this.contextAgentId
  }

  pushContextTool(tool: ToolEntry, timestamp: number): string {
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

  breakContextRun(timestamp: number): void {
    if (this.contextAgentId === null) return

    const id = this.contextAgentId
    const duration = timestamp - this.contextRunStartTime
    this.callbacks.completeContextAgent(id, duration)
    this.contextAgentId = null
  }

  pauseContextRun(timestamp: number): void {
    if (this.contextAgentId === null) return

    const id = this.contextAgentId
    const duration = timestamp - this.contextRunStartTime
    this.callbacks.pauseContextAgent(id, duration)
    this.contextAgentId = null
  }

  resetTracking(): void {
    this.contextAgentId = null
    this.contextRunStartTime = 0
  }

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
