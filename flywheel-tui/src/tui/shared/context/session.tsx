/** @jsxImportSource @opentui/solid */
/**
 * Session Context Provider
 *
 * Provides SessionManager instance and active session tracking to child
 * components. Uses the createSimpleContext pattern from helper.tsx.
 *
 * The SessionProvider wraps FlywheelShell and sits inside DialogProvider
 * in the app.tsx provider stack.
 */

import { createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { Log } from "../../../infra/log.js"
import type { SessionManager, SessionSummary, SessionListResult } from "../../../orchestration/session/manager"

const log = Log.create({ service: "session-context" })

// Context value type

export interface SessionContextValue {
  /** The underlying SessionManager instance. */
  manager: SessionManager

  /** Refresh the session list from disk. Returns the current list. */
  refreshList: () => SessionListResult

  /** Reactive signal: the cached session list. */
  sessions: () => SessionSummary[]
}

// Provider

export const { use: useSession, provider: SessionProvider } = createSimpleContext<
  SessionContextValue,
  { manager: SessionManager }
>({
  name: "Session",
  init: (props) => {
    const [sessions, setSessions] = createSignal<SessionSummary[]>([])

    // Load initial session list
    const initialResult = props.manager.list()
    setSessions(initialResult.sessions)

    // Startup crash recovery: transition stale active → paused (work) or completed (chat)
    try {
      const recovered = props.manager.recoverStaleSessions()
      if (recovered > 0) {
        const updated = props.manager.list()
        setSessions(updated.sessions)
      }
    } catch {
      // Non-fatal — don't block startup
    }

    const refreshList = (): SessionListResult => {
      const result = props.manager.list()
      setSessions(result.sessions)
      return result
    }

    // Poll for session changes from other instances (every 5s)
    const pollInterval = setInterval(() => {
      try {
        refreshList()
      } catch (err) {
        log.warn("session list poll failed", { error: String(err) })
      }
    }, 5_000)
    onCleanup(() => clearInterval(pollInterval))

    return {
      manager: props.manager,
      refreshList,
      sessions,
    }
  },
})
