import type { RunnerContext } from "./runner-context.js"

export interface ChatCallbacks {
  onWaiting: (waiting: boolean) => void
  onError: (message: string) => void
  onEnded: () => void
}

export interface WorkerLifecycle {
  spawnWorker(resumeSessionId?: string, messageToSend?: string): Promise<void>
}

type ChatTurnPhase = "idle" | "awaiting-response" | "agent-active"

// Tracks chat-session lifecycle state that is distinct from the store:
//   - _ended: "has chat-controls.end() been called?" (proactive, set before disposal).
//     This is different from SessionEntryBase.ended which flips after the runner
//     finishes disposal — they are correlated but set at different timepoints.
//   - _engineSessionId: local cache of the engine's session ID for respawn on
//     unexpected exit / prompt-too-long reset. The store also carries this field
//     (written from the same EngineResult), but routing reads through the store
//     would require threading a read accessor into ChatSessionDeps — a larger
//     surface than the cache saves.
// Both are written by chat-session itself; neither is set elsewhere, so they are
// owned here, not copies of the store.
export class ChatSessionState {
  private _runner: RunnerContext | null = null
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
  end() { this._ended = true }
  markContextWarningFired() { this._contextWarningFired = true }
  captureSessionId(id: string) { this._engineSessionId = id }
  clearSessionId() { this._engineSessionId = null }
  attachRunner(runner: RunnerContext) { this._runner = runner }
  detachRunner() { this._runner = null }
}
