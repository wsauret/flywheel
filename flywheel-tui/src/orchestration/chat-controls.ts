import type { OutputSession } from "./output-session.js"
import type { WorkerLifecycle, ChatSessionState, ChatCallbacks } from "./chat-session.js"
import type { Unsubscribe } from "../infra/event-bus.js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"

const log = Log.create({ service: "chat" })

interface ChatControls {
  send(text: string): void
  interrupt(): void
  end(): void
}

interface ChatControlsInput {
  lifecycle: WorkerLifecycle
  session: OutputSession
  callbacks: ChatCallbacks
  eventUnsubs: Unsubscribe[]
  state: ChatSessionState
}

export function createChatControls(input: ChatControlsInput): ChatControls {
  const { lifecycle, session, callbacks, eventUnsubs, state } = input

  function interrupt() {
    if (state.ended) return
    log.info("chat interrupted by user")

    if (session.sessionId) state.captureSessionId(session.sessionId)

    state.runner?.abort()
    state.detachRunner()

    state.completeTurn()
    session.resetActivity()
    const pendingTexts = session.resolvePendingMessages()
    session.pushSystemMessage("Interrupted", Date.now())
    session.flush()

    const messageToResend = pendingTexts.join("\n\n") || undefined
    if (!messageToResend) callbacks.onWaiting(false)

    if (state.engineSessionId) {
      lifecycle.spawnWorker(state.engineSessionId, messageToResend).catch((err) => {
        log.warn("eager reconnect after interrupt failed", { error: errorMessage(err) })
        callbacks.onWaiting(false)
      })
    } else {
      callbacks.onWaiting(false)
    }
  }

  function end() {
    if (state.ended) return
    state.markEnded()
    // Unsubscribe EventBus listeners — no more infra event processing.
    eventUnsubs.forEach((u) => u())
    // Flush any remaining data before disposing (mirrors handleRunnerDone)
    session.flushParser()
    session.flush()
    session.dispose()
    // Resource disposal (budget flush, trace finalize, transcript close) is
    // handled by chat-runner's disposeSessionResources() — not duplicated here.
    if (state.runner) state.runner.abort()
    else callbacks.onEnded()
    state.detachRunner()
  }

  function send(text: string) {
    if (state.ended) { log.warn("chat send after ended"); return }

    // Message is "pending" only when the agent is actively producing output
    // (mid-turn injection). After interrupt or idle-exit, the message starts a new turn.
    const isPending = state.turnPhase === "agent-active" && state.runner != null
    state.beginTurn()
    callbacks.onWaiting(true)
    const now = Date.now()
    session.notifyInjected(text, now, isPending, false)
    // No explicit flush needed — OutputSession's 16ms interval handles it

    if (state.runner) {
      state.runner.send(text)
      log.info("chat message sent", { length: text.length })
      return
    }

    // Runner exited idle — reconnect via new runner and send the message as initial content
    if (state.engineSessionId) {
      log.info("chat runner idle-exited, reconnecting via new runner", { sessionId: state.engineSessionId })
      lifecycle.spawnWorker(state.engineSessionId, text).catch((err) => {
        log.warn("chat reconnect failed", { error: errorMessage(err) })
        callbacks.onWaiting(false)
        callbacks.onError(`Reconnect failed: ${errorMessage(err)}`)
      })
      return
    }

    // No runner and no session ID to resume — this should only happen before the
    // first turn completes (session ID not yet emitted by the engine).
    log.warn("chat send: no active runner and no session ID to resume")
    callbacks.onWaiting(false)
  }

  return { send, interrupt, end }
}
