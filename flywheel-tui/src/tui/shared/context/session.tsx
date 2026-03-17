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

import { createSignal } from "solid-js"
import { createSimpleContext } from "./helper"
import type { SessionManager, SessionSummary, SessionListResult } from "../../../session/manager"
import type { WorkflowSession } from "../../components/workflow-session"

// ---------------------------------------------------------------------------
// Context value type
// ---------------------------------------------------------------------------

export interface SessionContextValue {
  /** The underlying SessionManager instance. */
  manager: SessionManager

  /** Reactive signal: the currently active session ID (or null). */
  activeSessionId: () => string | null

  /** Set the active session ID. */
  setActiveSessionId: (id: string | null) => void

  /** Reactive signal: the live WorkflowSession for the active session (or null). */
  activeWorkflowSession: () => WorkflowSession | null

  /** Set the live WorkflowSession. */
  setActiveWorkflowSession: (session: WorkflowSession | null) => void

  /** Refresh the session list from disk. Returns the current list. */
  refreshList: () => SessionListResult

  /** Reactive signal: the cached session list. */
  sessions: () => SessionSummary[]
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const { use: useSession, provider: SessionProvider } = createSimpleContext<
  SessionContextValue,
  { manager: SessionManager }
>({
  name: "Session",
  init: (props) => {
    const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null)
    const [activeWorkflowSession, setActiveWorkflowSession] =
      createSignal<WorkflowSession | null>(null)
    const [sessions, setSessions] = createSignal<SessionSummary[]>([])

    // Load initial session list
    const initialResult = props.manager.list()
    setSessions(initialResult.sessions)

    const refreshList = (): SessionListResult => {
      const result = props.manager.list()
      setSessions(result.sessions)
      return result
    }

    return {
      manager: props.manager,
      activeSessionId,
      setActiveSessionId,
      activeWorkflowSession,
      setActiveWorkflowSession,
      refreshList,
      sessions,
    }
  },
})
