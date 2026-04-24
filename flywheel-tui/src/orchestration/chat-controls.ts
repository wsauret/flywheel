import type { OutputSession } from "./output-session.js"
import type { WorkerLifecycle, ChatSessionState, ChatCallbacks } from "./chat-types.js"
import type { Unsubscribe } from "../infra/event-bus.js"
import type { UserEventToolResult } from "../infra/ndjson-event-types.js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"

const log = Log.create({ service: "chat" })

interface ChatControls {
  send(text: string): void
  sendToolResult(toolUseId: string, content: string, isError?: boolean): void
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
    session.resetActivity("paused")
    session.pushSystemMessage("Interrupted", Date.now())
    const pendingTexts = session.drainQueued()
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
    state.end()
    eventUnsubs.forEach((u) => u())
    session.flushParser()
    session.flush()
    session.dispose()
    if (state.runner) state.runner.abort()
    else callbacks.onEnded()
    state.detachRunner()
  }

  function send(text: string) {
    if (state.ended) { log.warn("chat send after ended"); return }

    const queued = state.turnPhase === "agent-active" && state.runner != null
    state.beginTurn()
    callbacks.onWaiting(true)
    session.pushUserMessage(text, Date.now(), { queued, injected: false })
    if (state.runner) {
      state.runner.send(text)
      log.info("chat message sent", { length: text.length })
      return
    }

    if (state.engineSessionId) {
      log.info("chat runner idle-exited, reconnecting via new runner", { sessionId: state.engineSessionId })
      lifecycle.spawnWorker(state.engineSessionId, text).catch((err) => {
        log.warn("chat reconnect failed", { error: errorMessage(err) })
        callbacks.onWaiting(false)
        callbacks.onError(`Reconnect failed: ${errorMessage(err)}`)
      })
      return
    }

    log.warn("chat send: no active runner and no session ID to resume")
    callbacks.onWaiting(false)
  }

  function sendToolResult(toolUseId: string, content: string, isError?: boolean): void {
    if (state.ended) return
    const runner = state.runner
    if (!runner) {
      log.warn("sendToolResult: no active runner")
      return
    }
    if (!runner.sendToolResult) {
      log.warn("sendToolResult: engine does not accept external tool results", { toolUseId })
      return
    }

    const toolResult: UserEventToolResult = {
      type: "tool_result",
      tool_use_id: toolUseId,
      content,
      is_error: isError,
    }
    runner.sendToolResult(toolResult)
    log.info("tool result sent", { toolUseId, isError: isError ?? false })
  }

  return { send, sendToolResult, interrupt, end }
}
