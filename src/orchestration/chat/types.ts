import type { Agent } from "../agent-runtime/types.js"
import type { OutputSession } from "../runner/output-session.js"
import type { SessionEntryBasePatch } from "../session-store/types.js"

export interface ChatCallbacks {
  onError: (message: string) => void
  onEnded: () => void
}


// Tracks chat-session lifecycle state distinct from the store entry:
//   - _ended: "has end() been called?", set proactively before disposal.
//   - _providerConversationId: the chat runner's provider session identity
//     (`providerSessionKey`): session headers and provider connection
//     lifetime. Adapter metadata only, never the prompt-cache key. Cleared
//     by clearProviderConversationId (on "prompt too long") while the
//     persisted entry keeps the last-seen id for cross-process resume.
//     NEVER consulted as Flywheel's chat-context source; the session tree
//     owns that.

export class ChatSessionState {
  private _runner: Agent | null = null
  private _ended = false
  private _providerConversationId: string | null

  constructor(
    providerConversationId: string | undefined,
    private readonly updateEntry: (patch: SessionEntryBasePatch) => void,
  ) {
    this._providerConversationId = providerConversationId ?? null
  }

  get runner() { return this._runner }
  get ended() { return this._ended }
  get providerConversationId() { return this._providerConversationId }

  end() { this._ended = true }
  captureProviderConversationId(id: string) {
    if (this._providerConversationId === id) return false
    this._providerConversationId = id
    return true
  }
  clearProviderConversationId() { this._providerConversationId = null }
  attachRunner(runner: Agent) {
    this._runner = runner
    // runnerState is written by SessionEventAdapter from lifecycle events;
    // no direct store write here.
  }
  detachRunner(session: OutputSession, finalStatus: "completed" | "paused" = "completed") {
    this._runner = null
    // Chat has no workflow.run.completed/paused/failed equivalent on the bus,
    // so detach owns the transition back to "absent" directly. Workflow paths go
    // through workflow.run.completed/paused/failed in SessionEventAdapter instead.
    this.updateEntry({ runnerState: "absent", streamingStartedAt: null, waitingOnBackgroundWork: false })
    session.endTurn(finalStatus)
  }
}
