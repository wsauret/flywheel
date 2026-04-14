import type { OutputSession } from "./output-session.js"
import type { WorkerLifecycle, ChatSessionState, ChatCallbacks } from "./chat-session.js"
import type { Unsubscribe } from "../infra/event-bus.js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"
import { formatStdinMessage } from "./engines/subprocess/stdin-format.js"

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
    log.info("chat interrupted by user", { pid: state.workerPid })

    if (session.sessionId) state.captureSessionId(session.sessionId)

    if (state.stdinHandle?.isOpen) {
      state.stdinHandle.close()
    }
    state.detachWorker()

    if (state.workerPid) {
      const pid = state.workerPid
      try { process.kill(pid, "SIGTERM") } catch { /* already gone */ }
      setTimeout(() => {
        try { process.kill(pid, "SIGKILL") } catch { /* already gone */ }
      }, 2_000)
    }

    state.completeTurn()
    callbacks.onWaiting(false)
    session.resetActivity()
    session.resolvePendingMessages()
    session.pushSystemMessage("Interrupted", Date.now())
    session.flush()

    if (state.claudeSessionId) {
      lifecycle.spawnWorker(state.claudeSessionId).catch((err) => {
        log.warn("eager reconnect after interrupt failed", { error: errorMessage(err) })
      })
    }
  }

  function end() {
    if (state.ended) return
    state.markEnded()
    // Unsubscribe EventBus listeners — no more infra event processing.
    eventUnsubs.forEach((u) => u())
    // Flush any remaining data before disposing (mirrors handleWorkerExit)
    session.flushParser()
    session.flush()
    session.dispose()
    // Resource disposal (budget flush, trace finalize, transcript close) is
    // handled by chat-runner's disposeSessionResources() — not duplicated here.
    if (state.stdinHandle?.isOpen) {
      state.stdinHandle.close()
      state.detachWorker()
    } else {
      state.detachWorker()
      callbacks.onEnded()
    }
  }

  function send(text: string) {
    if (state.ended) { log.warn("chat send after ended"); return }

    // Message is "pending" only when the agent is actively producing output
    // (mid-turn injection). After interrupt or idle-exit, the message starts a new turn.
    const isPending = state.turnPhase === "agent-active" && state.stdinHandle?.isOpen === true
    state.beginTurn()
    callbacks.onWaiting(true)
    const now = Date.now()
    session.notifyInjected(text, now, isPending, false)
    // No explicit flush needed — OutputSession's 16ms interval handles it

    if (state.stdinHandle?.isOpen) {
      const ok = state.stdinHandle.write(formatStdinMessage(text))
      log.info("chat message sent", { length: text.length, written: ok })
      return
    }

    // Worker exited idle — reconnect via --resume and send the message as initial content
    if (state.claudeSessionId) {
      log.info("chat worker idle-exited, reconnecting via --resume", { sessionId: state.claudeSessionId })
      lifecycle.spawnWorker(state.claudeSessionId, text).catch((err) => {
        log.warn("chat reconnect failed", { error: errorMessage(err) })
        callbacks.onWaiting(false)
        callbacks.onError(`Reconnect failed: ${errorMessage(err)}`)
      })
      return
    }

    // No worker and no session ID to resume — this should only happen before the
    // first turn completes (session ID not yet emitted by Claude Code).
    log.warn("chat send: no active worker and no session ID to resume")
    callbacks.onWaiting(false)
  }

  return { send, interrupt, end }
}
