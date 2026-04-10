/**
 * Shell State — shared reactive state for all TUI hooks.
 *
 * Split into two interfaces:
 * - ShellSignals: pure reactive state (signals, memos)
 * - ShellServices: injected dependencies (non-reactive objects)
 *
 * Display state (outputBlocks, steps, agentState, sessionTitle) is derived
 * from the registry's SolidJS store via createMemo. Changing foregroundId
 * automatically updates all derived values — no manual sync needed.
 *
 * Overlay signals (viewedBlocks, viewedTitle) allow viewing historical
 * sessions without losing the live session context. When set (non-undefined),
 * they take precedence over registry-derived values.
 */

import { createSignal, createMemo } from "solid-js"
import type { Accessor, Setter } from "solid-js"
import type { AnyBlock } from "../types"
import type { StepState } from "../../orchestration/workflow-runner"
import type { SessionState } from "../../orchestration/session/state-machine"
import type { SessionRegistry, SessionEntry } from "../../orchestration/session-registry"
import type { SessionManager } from "../../orchestration/session/manager"
import { useMetrics, type MetricsHook } from "./use-metrics.js"

export type AgentState = "idle" | "active"

/** Pure reactive state — signals and derived memos. */
export interface ShellSignals {
  /** Derived from registry entry modelActivity. Read-only. */
  agentState: Accessor<AgentState>
  /** Derived: viewedBlocks overlay ?? registry entry outputBlocks ?? []. Read-only. */
  outputBlocks: Accessor<readonly AnyBlock[]>
  /** Derived from registry entry steps (workflow) or [] (chat). Read-only. */
  steps: Accessor<readonly StepState[]>
  errorMessage: Accessor<string>
  setErrorMessage: Setter<string>
  /** Derived: viewedTitle overlay ?? registry entry description ?? "". Read-only. */
  sessionTitle: Accessor<string>
  statusLine: Accessor<string>
  setStatusLine: Setter<string>
  foregroundId: Accessor<string | undefined>
  setForegroundId: Setter<string | undefined>
  /** Derived session state — re-evaluates when foregroundId or registry changes. */
  sessionState: Accessor<SessionState | null>
  /** The foreground session's registry entry (reactive proxy). Undefined when no foreground. */
  registryEntry: Accessor<SessionEntry | undefined>
  /** Overlay: when set, outputBlocks returns these instead of registry data. */
  viewedBlocks: Accessor<readonly AnyBlock[] | undefined>
  setViewedBlocks: Setter<readonly AnyBlock[] | undefined>
  /** Overlay: when set, sessionTitle returns this instead of registry description. */
  viewedTitle: Accessor<string | undefined>
  setViewedTitle: Setter<string | undefined>
}

/** Injected dependencies — non-reactive objects (metrics accessors are reactive but the object isn't). */
export interface ShellServices {
  registry: SessionRegistry
  manager: SessionManager
  metrics: MetricsHook
  refreshList: () => void
  setTerminalTitle: (title: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
}

export function createShellState(deps: {
  registry: SessionRegistry
  manager: SessionManager
  refreshList: () => void
  setTerminalTitle: (title: string) => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
}): { signals: ShellSignals; services: ShellServices } {
  // ── Writable signals (user-set, not derived) ──
  const [errorMessage, setErrorMessage] = createSignal("")
  const [statusLine, setStatusLine] = createSignal("")
  const [foregroundId, setForegroundId] = createSignal<string | undefined>()

  // ── Overlay signals for historical session viewing ──
  const [viewedBlocks, setViewedBlocks] = createSignal<readonly AnyBlock[] | undefined>()
  const [viewedTitle, setViewedTitle] = createSignal<string | undefined>()

  // ── Derived memos — zero-copy, return store proxies directly ──

  const registryEntry = createMemo((): SessionEntry | undefined => {
    const fgId = foregroundId()
    return fgId ? deps.registry.get(fgId) : undefined
  })

  // Metrics created here — registryEntry is already bound, no late-binding possible.
  const metrics = useMetrics(registryEntry)

  const outputBlocks = createMemo((): readonly AnyBlock[] =>
    viewedBlocks() ?? registryEntry()?.outputBlocks ?? []
  )

  const steps = createMemo((): readonly StepState[] => {
    const e = registryEntry()
    return e?.kind === "workflow" ? e.steps : []
  })

  const agentState = createMemo((): AgentState => {
    const e = registryEntry()
    return e && e.modelActivity !== "idle" ? "active" : "idle"
  })

  const sessionTitle = createMemo((): string =>
    viewedTitle() ?? registryEntry()?.description ?? ""
  )

  const sessionState = createMemo((): SessionState | null => {
    const fgId = foregroundId()
    if (!fgId) return null
    // registry.runningCount() reads Object.keys() on the store proxy —
    // SolidJS auto-tracks key changes when called inside a reactive context.
    deps.registry.runningCount()
    if (deps.registry.has(fgId)) return "active"
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
    registryEntry,
    viewedBlocks, setViewedBlocks,
    viewedTitle, setViewedTitle,
  }

  const services: ShellServices = {
    registry: deps.registry,
    manager: deps.manager,
    metrics,
    refreshList: deps.refreshList,
    setTerminalTitle: deps.setTerminalTitle,
    showToast: deps.showToast,
  }

  return { signals, services }
}
