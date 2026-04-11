/**
 * Shell State — shared reactive state for all TUI hooks.
 *
 * Split into two interfaces:
 * - ShellSignals: pure reactive state (signals, memos)
 * - ShellServices: injected dependencies (non-reactive objects)
 *
 * Display state (outputBlocks, steps, agentState, sessionTitle) is derived
 * from the session store's SolidJS store via createMemo. The session store
 * is the single source of truth for all session display data — active,
 * ended, and historical sessions loaded from disk. Changing foregroundId
 * automatically updates all derived values — no manual sync needed.
 */

import { createSignal, createMemo } from "solid-js"
import type { Accessor, Setter } from "solid-js"
import type { AnyBlock } from "../types"
import type { StepState } from "../../orchestration/workflow-runner"
import type { SessionState } from "../../orchestration/session/state-machine"
import type { SessionStore, SessionEntry } from "../../orchestration/session-store-types"
import type { SessionManager } from "../../orchestration/session/manager"
import { useMetrics, type MetricsHook } from "./use-metrics.js"

export type AgentState = "idle" | "active"

/** Pure reactive state — signals and derived memos. */
export interface ShellSignals {
  /** Derived from store entry modelActivity. Read-only. */
  agentState: Accessor<AgentState>
  /** Derived from store entry outputBlocks. Read-only. */
  outputBlocks: Accessor<readonly AnyBlock[]>
  /** Derived from store entry steps (workflow) or [] (chat). Read-only. */
  steps: Accessor<readonly StepState[]>
  errorMessage: Accessor<string>
  setErrorMessage: Setter<string>
  /** Derived from store entry description. Read-only. */
  sessionTitle: Accessor<string>
  statusLine: Accessor<string>
  setStatusLine: Setter<string>
  foregroundId: Accessor<string | undefined>
  setForegroundId: Setter<string | undefined>
  /** Derived session state — re-evaluates when foregroundId or store changes. */
  sessionState: Accessor<SessionState | null>
  /** The foreground session's store entry (reactive proxy). Undefined when no foreground. */
  storeEntry: Accessor<SessionEntry | undefined>
  /** When set, bare /work was entered and we're waiting for a task description. Value is the command ("work" | "sprint"). */
  pendingWorkCommand: Accessor<string | undefined>
  setPendingWorkCommand: Setter<string | undefined>
}

/** Injected dependencies — non-reactive objects (metrics accessors are reactive but the object isn't). */
export interface ShellServices {
  sessionStore: SessionStore
  manager: SessionManager
  metrics: MetricsHook
  refreshList: () => void
  setTerminalTitle: (title: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
}

export function createShellState(deps: {
  sessionStore: SessionStore
  manager: SessionManager
  refreshList: () => void
  setTerminalTitle: (title: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
}): { signals: ShellSignals; services: ShellServices } {
  // ── Writable signals (user-set, not derived) ──
  const [errorMessage, setErrorMessage] = createSignal("")
  const [statusLine, setStatusLine] = createSignal("")
  const [foregroundId, setForegroundId] = createSignal<string | undefined>()

  // ── Pending work mode (bare /work with no description) ──
  const [pendingWorkCommand, setPendingWorkCommand] = createSignal<string | undefined>()

  // ── Derived memos — zero-copy, return store proxies directly ──

  const storeEntry = createMemo((): SessionEntry | undefined => {
    const fgId = foregroundId()
    return fgId ? deps.sessionStore.get(fgId) : undefined
  })

  // Metrics created here — storeEntry is already bound, no late-binding possible.
  const metrics = useMetrics(storeEntry)

  const outputBlocks = createMemo((): readonly AnyBlock[] =>
    storeEntry()?.outputBlocks ?? []
  )

  const steps = createMemo((): readonly StepState[] => {
    const e = storeEntry()
    return e?.kind === "workflow" ? e.steps : []
  })

  const agentState = createMemo((): AgentState => {
    const e = storeEntry()
    return e && e.modelActivity !== "idle" ? "active" : "idle"
  })

  const sessionTitle = createMemo((): string =>
    storeEntry()?.description ?? ""
  )

  const sessionState = createMemo((): SessionState | null => {
    const fgId = foregroundId()
    if (!fgId) return null
    // storeEntry() returns a reactive proxy — reading `ended` here tracks
    // the field directly, so this memo re-evaluates when the session finishes.
    const entry = storeEntry()
    if (entry && !entry.ended) return "active"
    return deps.manager.getState(fgId)
  })

  const signals: ShellSignals = {
    agentState,
    outputBlocks,
    steps,
    errorMessage, setErrorMessage,
    sessionTitle,
    statusLine, setStatusLine,
    foregroundId, setForegroundId,
    sessionState,
    storeEntry,
    pendingWorkCommand, setPendingWorkCommand,
  }

  const services: ShellServices = {
    sessionStore: deps.sessionStore,
    manager: deps.manager,
    metrics,
    refreshList: deps.refreshList,
    setTerminalTitle: deps.setTerminalTitle,
    showToast: deps.showToast,
  }

  return { signals, services }
}
