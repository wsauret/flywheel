/**
 * Shell State — shared reactive state for all TUI hooks.
 *
 * Split into two interfaces:
 * - ShellSignals: pure reactive state (signals, memos)
 * - ShellServices: injected dependencies (non-reactive objects)
 */

import { createSignal, createMemo } from "solid-js"
import type { Accessor, Setter } from "solid-js"
import type { AnyBlock } from "../../infra/output-blocks.js"
import type { StepState } from "../../orchestration/workflow-runner.js"
import type { SessionState } from "../../orchestration/session/types.js"
import type { SessionStore, SessionEntry } from "../../orchestration/session-store-types.js"
import type { SessionManager, SessionSummary } from "../../orchestration/session/manager.js"
import { useMetrics, type MetricsHook } from "./use-metrics.js"

type AgentState = "idle" | "active"

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

export interface ShellServices {
  sessionStore: SessionStore
  manager: SessionManager
  metrics: MetricsHook
  refreshList: () => void
  setTerminalTitle: (title: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }) => void
}

export function createShellState(deps: {
  sessionStore: SessionStore
  manager: SessionManager
  sessions: Accessor<SessionSummary[]>
  refreshList: () => void
  setTerminalTitle: (title: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }) => void
  showThinking?: boolean
}): { signals: ShellSignals; services: ShellServices } {
  const [errorMessage, setErrorMessage] = createSignal("")
  const [foregroundId, setForegroundId] = createSignal<string | undefined>()

  const [pendingWorkCommand, setPendingWorkCommand] = createSignal<string | undefined>()

  const storeEntry = createMemo(() => {
    const fgId = foregroundId()
    return fgId ? deps.sessionStore.get(fgId) : undefined
  })

  // Metrics created here — storeEntry is already bound, no late-binding possible.
  const metrics = useMetrics(storeEntry)

  const showThinking = deps.showThinking ?? true
  const outputBlocks = createMemo(() => {
    const blocks = storeEntry()?.outputBlocks ?? []
    return showThinking ? blocks : blocks.filter((b) => b.kind !== "thinking")
  })

  const steps = createMemo(() => {
    const e = storeEntry()
    return e?.kind === "workflow" ? e.steps : []
  })

  const agentState = createMemo(() => {
    const e = storeEntry()
    return e && e.modelActivity !== "idle" ? "active" as const : "idle" as const
  })

  const sessionTitle = createMemo(() =>
    storeEntry()?.description ?? ""
  )

  const sessionState = createMemo((): SessionState | null => {
    const fgId = foregroundId()
    if (!fgId) return null
    // storeEntry() returns a reactive proxy — reading `ended` here tracks
    // the field directly, so this memo re-evaluates when the session finishes.
    const entry = storeEntry()
    if (entry && !entry.ended) return "active"
    // Derive from sessions() signal — the single in-memory representation
    // of historical session state. Refreshed after every state transition
    // (via refreshList in controllers) and polled every 5s for multi-instance sync.
    return deps.sessions().find((s) => s.id === fgId)?.state ?? null
  })

  const signals = {
    agentState,
    outputBlocks,
    steps,
    errorMessage, setErrorMessage,
    sessionTitle,
    foregroundId, setForegroundId,
    sessionState,
    storeEntry,
    pendingWorkCommand, setPendingWorkCommand,
  }

  const services = {
    sessionStore: deps.sessionStore,
    manager: deps.manager,
    metrics,
    refreshList: deps.refreshList,
    setTerminalTitle: deps.setTerminalTitle,
    showToast: deps.showToast,
  }

  return { signals, services }
}
