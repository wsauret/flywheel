/**
 * Shell State — shared reactive state for all TUI hooks.
 *
 * Split into two interfaces:
 * - ShellSignals: pure reactive state (signals, memos)
 * - ShellServices: injected dependencies (non-reactive objects)
 */

import { createSignal, createMemo } from "solid-js"
import type { Accessor, Setter } from "solid-js"
import type { AnyBlock } from "../types"
import type { StepState } from "../../orchestration/workflow-runner"
import type { SessionState } from "../../orchestration/session/state-machine"
import type { SessionRegistry } from "../../orchestration/session-registry"
import type { SessionManager } from "../../orchestration/session/manager"
import type { MetricsHook } from "./use-metrics"

export type AgentState = "idle" | "active"

/** Shared terminal title prefix used across TUI hooks. */
export const TERMINAL_TITLE_PREFIX = "flywheel \u00b7 "

/** Pure reactive state — signals and derived memos. */
export interface ShellSignals {
  agentState: Accessor<AgentState>
  setAgentState: Setter<AgentState>
  outputBlocks: Accessor<AnyBlock[]>
  setOutputBlocks: Setter<AnyBlock[]>
  steps: Accessor<StepState[]>
  setSteps: Setter<StepState[]>
  errorMessage: Accessor<string>
  setErrorMessage: Setter<string>
  sessionTitle: Accessor<string>
  setSessionTitle: Setter<string>
  statusLine: Accessor<string>
  setStatusLine: Setter<string>
  foregroundId: Accessor<string | undefined>
  setForegroundId: Setter<string | undefined>
  runningCount: Accessor<number>
  setRunningCount: Setter<number>
  /** Derived session state — re-evaluates when foregroundId or registryVersion changes. */
  sessionState: Accessor<SessionState | null>
}

/** Injected dependencies — non-reactive objects. */
export interface ShellServices {
  registry: SessionRegistry
  manager: SessionManager
  refreshList: () => void
  setTerminalTitle: (title: string) => void
  metrics: MetricsHook
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
  /** Increment the registry version signal — drives sessionState memo re-evaluation. */
  bumpRegistryVersion: () => void
}

export function createShellState(deps: {
  registry: SessionRegistry
  manager: SessionManager
  refreshList: () => void
  setTerminalTitle: (title: string) => void
  metrics: MetricsHook
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
}): { signals: ShellSignals; services: ShellServices } {
  const [agentState, setAgentState] = createSignal<AgentState>("idle")
  const [outputBlocks, setOutputBlocks] = createSignal<AnyBlock[]>([])
  const [steps, setSteps] = createSignal<StepState[]>([])
  const [errorMessage, setErrorMessage] = createSignal("")
  const [sessionTitle, setSessionTitle] = createSignal("")
  const [statusLine, setStatusLine] = createSignal("")
  const [foregroundId, setForegroundId] = createSignal<string | undefined>()
  const [runningCount, setRunningCount] = createSignal(0)
  const [registryVersion, setRegistryVersion] = createSignal(0)

  const sessionState = createMemo((): SessionState | null => {
    const fgId = foregroundId()
    if (!fgId) return null
    registryVersion()  // reactive dependency — re-evaluate on any registry change
    if (deps.registry.has(fgId)) return "active"
    return deps.manager.getState(fgId)
  })

  const signals: ShellSignals = {
    agentState, setAgentState,
    outputBlocks, setOutputBlocks,
    steps, setSteps,
    errorMessage, setErrorMessage,
    sessionTitle, setSessionTitle,
    statusLine, setStatusLine,
    foregroundId, setForegroundId,
    runningCount, setRunningCount,
    sessionState,
  }

  const services: ShellServices = {
    registry: deps.registry,
    manager: deps.manager,
    refreshList: deps.refreshList,
    setTerminalTitle: deps.setTerminalTitle,
    metrics: deps.metrics,
    showToast: deps.showToast,
    bumpRegistryVersion: () => setRegistryVersion((v) => v + 1),
  }

  return { signals, services }
}
