import type { EngineRunner } from "./engines/core/types.js"

export interface ChatCallbacks {
  onWaiting: (waiting: boolean) => void
  onError: (message: string) => void
  onEnded: () => void
}

export interface WorkerLifecycle {
  spawnWorker(resumeSessionId?: string, messageToSend?: string): Promise<void>
}

type ChatTurnPhase = "idle" | "awaiting-response" | "agent-active"

// Duplicates _ended and _engineSessionId from the store as synchronous
// guards for chat-controls (send, interrupt, end) that can't await a store read.
export class ChatSessionState {
  private _runner: EngineRunner | null = null
  private _ended = false
  private _engineSessionId: string | null
  private _turnPhase: ChatTurnPhase = "idle"
  private _contextWarningFired = false

  constructor(engineSessionId?: string) {
    this._engineSessionId = engineSessionId ?? null
  }

  get runner() { return this._runner }
  get ended() { return this._ended }
  get engineSessionId() { return this._engineSessionId }
  get turnPhase() { return this._turnPhase }
  get contextWarningFired() { return this._contextWarningFired }

  beginTurn() { this._turnPhase = "awaiting-response" }
  activateTurn() { this._turnPhase = "agent-active" }
  completeTurn() { this._turnPhase = "idle" }
  markEnded() { this._ended = true }
  markContextWarningFired() { this._contextWarningFired = true }
  captureSessionId(id: string) { this._engineSessionId = id }
  clearSessionId() { this._engineSessionId = null }
  attachRunner(runner: EngineRunner) { this._runner = runner }
  detachRunner() { this._runner = null }
}
