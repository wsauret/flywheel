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
import type { SessionManager, SessionSummary, SessionListResult } from "../../../session/manager"
import type { WorktreeManager } from "../../../session/worktree-manager.js"


// ---------------------------------------------------------------------------
// Context value type
// ---------------------------------------------------------------------------

export interface SessionContextValue {
  /** The underlying SessionManager instance. */
  manager: SessionManager

  /** Optional worktree manager for git worktree lifecycle. */
  worktreeManager: WorktreeManager | null

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
  { manager: SessionManager; worktreeManager?: WorktreeManager }
>({
  name: "Session",
  init: (props) => {
    const [sessions, setSessions] = createSignal<SessionSummary[]>([])

    // Load initial session list
    const initialResult = props.manager.list()
    setSessions(initialResult.sessions)

    // Startup crash recovery: transition stale work:active → work:paused
    // Must run BEFORE trashed sweep so recovered sessions aren't accidentally swept.
    try {
      const recovered = props.manager.recoverStaleSessions()
      if (recovered > 0) {
        const updated = props.manager.list()
        setSessions(updated.sessions)
      }
    } catch {
      // Non-fatal — don't block startup
    }

    // Startup sweep: clean up trashed sessions (fire-and-forget)
    try {
      const swept = props.manager.sweepTrashed()
      if (swept > 0) {
        // Refresh list to reflect deletions
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
      } catch {
        // Non-fatal — don't crash on transient disk errors
      }
    }, 5_000)
    onCleanup(() => clearInterval(pollInterval))

    return {
      manager: props.manager,
      worktreeManager: props.worktreeManager ?? null,
      refreshList,
      sessions,
    }
  },
})
