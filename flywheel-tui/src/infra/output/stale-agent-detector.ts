/**
 * Stale Agent Detector
 *
 * Tracks agent activity timestamps and auto-completes agents that
 * have had no activity for a configurable timeout (default 5s).
 * Extracted from StructuredOutputBuilder to isolate timer-based
 * lifecycle management from block accumulation.
 */

const DEFAULT_STALE_TIMEOUT_MS = 5_000

export interface StaleAgentCallbacks {
  /** Called when an agent is detected as stale and should be auto-completed. */
  onStaleAgent: (agentId: string, durationMs: number) => void
}

export class StaleAgentDetector {
  /** Tracks last activity timestamp per agent. */
  private agentLastActivity = new Map<string, number>()
  /** Tracks spawn timestamp per agent for duration calculation on stale completion. */
  private agentSpawnTime = new Map<string, number>()
  /** Interval handle for stale agent checks (1s). Started on first agent spawn. */
  private staleCheckInterval: ReturnType<typeof setInterval> | null = null

  private readonly staleTimeoutMs: number
  private readonly callbacks: StaleAgentCallbacks

  constructor(callbacks: StaleAgentCallbacks, staleTimeoutMs = DEFAULT_STALE_TIMEOUT_MS) {
    this.callbacks = callbacks
    this.staleTimeoutMs = staleTimeoutMs
  }

  /** Record that an agent was spawned. Starts the stale check interval if not running. */
  trackSpawn(agentId: string): void {
    const now = Date.now()
    this.agentLastActivity.set(agentId, now)
    this.agentSpawnTime.set(agentId, now)
    this.startStaleCheck()
  }

  /** Record activity on an agent, resetting its stale timer. */
  trackActivity(agentId: string): void {
    this.agentLastActivity.set(agentId, Date.now())
  }

  /** Remove an agent from tracking (called on completion or error). */
  removeAgent(agentId: string): void {
    this.agentLastActivity.delete(agentId)
    this.agentSpawnTime.delete(agentId)
  }

  /** Stop the stale check interval and clean up all tracking state. */
  dispose(): void {
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval)
      this.staleCheckInterval = null
    }
    this.agentLastActivity.clear()
    this.agentSpawnTime.clear()
  }

  /** Clear tracking maps without stopping the interval. Used during reset. */
  clearTracking(): void {
    this.agentLastActivity.clear()
    this.agentSpawnTime.clear()
  }

  /** Start the stale agent check interval (1s). Idempotent — only one interval runs. */
  private startStaleCheck(): void {
    if (this.staleCheckInterval) return
    this.staleCheckInterval = setInterval(() => this.checkStaleAgents(), 1000)
  }

  private checkStaleAgents(): void {
    const now = Date.now()
    for (const [id, lastActivity] of this.agentLastActivity) {
      if (now - lastActivity > this.staleTimeoutMs) {
        const spawned = this.agentSpawnTime.get(id) ?? lastActivity
        this.callbacks.onStaleAgent(id, now - spawned)
      }
    }
  }
}
