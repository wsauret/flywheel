/**
 * Chat Controls — send, interrupt, and end operations for a chat session.
 *
 * Extracted from chat-session.ts. Operates on shared ChatSessionState
 * passed via ChatControlsInput.
 */

import type { OutputSession } from "./output-session"
import type { WorkerLifecycle, ChatSessionState, ChatCallbacks } from "./chat-session"
import type { SessionEntryBase } from "./session-store-types"
import type { Unsubscribe } from "../infra/event-bus"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"
import { formatStdinMessage } from "./engines/subprocess/stdin-format"

const log = Log.create({ service: "chat" })

export interface ChatControls {
  send(text: string): void
  interrupt(): void
  end(): void
}

export interface ChatControlsInput {
  lifecycle: WorkerLifecycle
  session: OutputSession
  callbacks: ChatCallbacks
  eventUnsubs: Unsubscribe[]
  state: ChatSessionState
  /** Raw (ungated) updateEntry — for setting idle which always passes through. */
  rawUpdateEntry: (patch: Partial<SessionEntryBase>) => void
}

export function createChatControls(input: ChatControlsInput): ChatControls {
  const { lifecycle, session, callbacks, eventUnsubs, state, rawUpdateEntry } = input

  function interrupt() {
    if (state.ended) return
    log.info("chat interrupted by user", { pid: state.workerPid })

    // Capture session ID before killing the worker
    if (session.sessionId) state.claudeSessionId = session.sessionId

    // Close stdin pipe if still open
    if (state.stdinHandle?.isOpen) {
      state.stdinHandle.close()
    }
    state.stdinHandle = null

    // Kill the worker process — SIGTERM first, escalate to SIGKILL after 2s
    if (state.workerPid) {
      const pid = state.workerPid
      try { process.kill(pid, "SIGTERM") } catch { /* already gone */ }
      setTimeout(() => {
        try { process.kill(pid, "SIGKILL") } catch { /* already gone */ }
      }, 2_000)
    }

    // Always reset session state — this is the escape hatch, it must work.
    // Why rawUpdateEntry here (bypassing gating): idle must always pass through,
    // and the builder's activity is stale since the process was just killed.
    state.turnPhase = "idle"
    callbacks.onWaiting(false)
    rawUpdateEntry({ modelActivity: "idle" })
    session.resolvePendingMessages()
    session.pushSystemMessage("Interrupted", Date.now())
    session.flush()

    // Eagerly reconnect so the worker is warm when the user sends the next message
    if (state.claudeSessionId) {
      lifecycle.spawnWorker(state.claudeSessionId).catch((err) => {
        log.warn("eager reconnect after interrupt failed", { error: errorMessage(err) })
      })
    }
  }

  function end() {
    if (state.ended) return
    state.ended = true
    // Unsubscribe EventBus listeners — no more infra event processing.
    eventUnsubs.forEach((u) => u())
    // Flush any remaining data before disposing (mirrors handleWorkerExit)
    session.flushParser()
    session.flush()
    session.dispose()
    // Resource disposal (budget flush, trace finalize, transcript close) is
    // handled by chat-runner's disposeSessionResources() — not duplicated here.
    if (state.stdinHandle?.isOpen) {
      // Worker is alive — close the pipe and let the process exit naturally.
      // onEnded fires from the spawnResult.result handler once the process exits.
      state.stdinHandle.close()
      state.stdinHandle = null
    } else {
      // Worker already idle-exited — fire immediately.
      state.stdinHandle = null
      callbacks.onEnded()
    }
  }

  function send(text: string) {
    if (state.ended) { log.warn("chat send after ended"); return }

    // Message is "pending" only when the agent is actively producing output
    // (mid-turn injection). After interrupt or idle-exit, the message starts a new turn.
    const isPending = state.turnPhase === "agent-active" && state.stdinHandle?.isOpen === true
    state.turnPhase = "awaiting-response"
    callbacks.onWaiting(true)
    const now = Date.now()
    session.notifyInjected(text, now, isPending, false)
    // No explicit flush needed — OutputSession's 16ms interval handles it

    if (state.stdinHandle?.isOpen) {
      // Normal path: worker is alive, write directly to the pipe
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
