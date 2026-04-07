/**
 * Registry Sync Hook — syncs foreground session registry entry to display signals.
 *
 * Subscribes to the session registry and propagates changes to the shell's
 * display signals (output blocks, steps, tokens, cost, etc). Handles terminal
 * states (completed/error) by updating session manager state and cleaning up.
 *
 * Uses `kind` guards to safely handle both workflow and chat entries:
 * - `steps` and `result` only exist on workflow entries
 * - Chat entries never transition to "paused"
 */

import type { Accessor, Setter } from "solid-js"
import type { SessionRegistry, SessionEntry } from "../../orchestration/session-registry.js"
import type { MetricsHook } from "./use-metrics.js"
import type { AnyBlock } from "../types.js"
import type { StepState } from "../../orchestration/workflow-runner.js"
import type { AgentState, SessionStatus } from "./use-workflow-lifecycle.js"
import { TERMINAL_TITLE_PREFIX } from "./use-workflow-lifecycle.js"
import { safeUpdateState } from "../../orchestration/session/safe-transition.js"
import { formatElapsed, formatCost, formatTokens } from "../format.js"

export interface RegistrySyncDeps {
  registry: SessionRegistry
  foregroundId: Accessor<string | undefined>
  setForegroundId: Setter<string | undefined>
  setAgentState: Setter<AgentState>
  setSessionStatus: Setter<SessionStatus>
  setOutputBlocks: Setter<AnyBlock[]>
  setSteps: Setter<StepState[]>
  setRunningCount: Setter<number>
  setStatusLine: Setter<string>
  setSessionTitle: Setter<string>
  setErrorMessage: Setter<string>
  setTerminalTitle: (title: string) => void
  metrics: MetricsHook
  manager: { updateState(id: string, state: string): void }
  refreshList: () => void
  showToast: (opts: { message: string; variant: "info" | "error" }) => void
}

/**
 * Subscribe to the session registry and sync foreground entry changes to
 * display signals. Returns the unsubscribe function for cleanup.
 */
export function useRegistrySync(deps: RegistrySyncDeps): () => void {
  const {
    registry,
    foregroundId,
    setForegroundId,
    setAgentState,
    setSessionStatus,
    setOutputBlocks,
    setSteps,
    setRunningCount,
    setStatusLine,
    setSessionTitle,
    setErrorMessage,
    setTerminalTitle,
    metrics,
    manager,
    refreshList,
    showToast,
  } = deps

  // Track previous outputBlocks reference for identity-check optimization
  let prevOutputBlocks: readonly import("../../infra/output-blocks.js").AnyBlock[] | null = null

  // ── SRP: terminal state handling ──

  function handleWorkflowCompleted(fgId: string, entry: SessionEntry & { kind: "workflow" }, totalElapsed: string): void {
    const r = entry.result!
    if (r.completed) {
      safeUpdateState((id, s) => manager.updateState(id, s), fgId, "completed")
      setStatusLine(`\u2713 ${r.stepsCompleted}/${r.stepsTotal} steps \u00b7 ${totalElapsed} \u00b7 ${formatCost(r.cost)} \u00b7 ${formatTokens(r.tokens)} tokens`)
    } else {
      safeUpdateState((id, s) => manager.updateState(id, s), fgId, "work:paused")
      setStatusLine(`\u2717 ${r.reason ?? "stopped"} (${r.stepsCompleted}/${r.stepsTotal}) \u00b7 ${totalElapsed} \u00b7 ${formatCost(r.cost)}`)
    }
    refreshList()
  }

  function handleChatCompleted(entry: SessionEntry, totalElapsed: string): void {
    setStatusLine(`Chat ended \u00b7 ${totalElapsed} \u00b7 ${formatCost(entry.cost)} \u00b7 ${formatTokens(entry.tokens)} tokens`)
  }

  function handleTerminalState(fgId: string, entry: SessionEntry): void {
    const totalElapsed = formatElapsed(Date.now() - metrics.workStartTime())

    if (entry.status === "error") {
      if (entry.kind === "workflow") {
        safeUpdateState((id, s) => manager.updateState(id, s), fgId, "work:paused")
      }
      refreshList()
      setErrorMessage(entry.errorMessage ?? "Unknown error")
      setAgentState("idle")
      setSessionStatus("error")
      setTerminalTitle(`${TERMINAL_TITLE_PREFIX}error`)
    } else if (entry.kind === "workflow" && entry.result) {
      handleWorkflowCompleted(fgId, entry as SessionEntry & { kind: "workflow" }, totalElapsed)
      setAgentState("idle")
      setSessionStatus("completed")
      setTerminalTitle(`${TERMINAL_TITLE_PREFIX}done`)
    } else if (entry.kind === "chat") {
      handleChatCompleted(entry, totalElapsed)
      setAgentState("idle")
      setSessionStatus("completed")
      setTerminalTitle(`${TERMINAL_TITLE_PREFIX}done`)
    }

    queueMicrotask(() => {
      registry.remove(fgId)
      setForegroundId(undefined)
    })
  }

  // ── SRP: background session garbage collection ──

  function gcBackgroundSessions(fgId: string): void {
    const toRemove: string[] = []
    for (const id of registry.activeIds()) {
      if (id === fgId) continue
      const bg = registry.get(id)
      if (bg && (bg.status === "completed" || bg.status === "error")) {
        const label = bg.description || id.slice(0, 8)
        showToast({
          message: bg.status === "completed" ? `Background session "${label}" completed` : `Background session "${label}" errored`,
          variant: bg.status === "completed" ? "info" : "error",
        })
        toRemove.push(id)
      }
    }
    if (toRemove.length > 0) {
      queueMicrotask(() => { for (const id of toRemove) registry.remove(id) })
    }
  }

  // ── Main subscriber: sync live state ──

  return registry.subscribe(() => {
    setRunningCount(registry.runningCount())

    const fgId = foregroundId()
    if (!fgId) return

    const entry = registry.get(fgId)
    if (!entry) return

    metrics.setActivity(entry.modelActivity)

    if (entry.status === "running") {
      setAgentState(entry.modelActivity !== "idle" ? "active" : "idle")
    }

    if (entry.outputBlocks !== prevOutputBlocks) {
      prevOutputBlocks = entry.outputBlocks
      setOutputBlocks([...entry.outputBlocks])
    }

    if (entry.kind === "workflow") {
      setSteps([...entry.steps])
    } else {
      setSteps([])
    }

    metrics.setTokens(entry.tokens)
    metrics.setCost(entry.cost)
    metrics.setContextPercent(entry.contextPercent)
    setSessionTitle(entry.description)
    setTerminalTitle(`${TERMINAL_TITLE_PREFIX}${entry.description}`)

    if (entry.status === "completed" || entry.status === "error") {
      handleTerminalState(fgId, entry)
    }

    gcBackgroundSessions(fgId)
  })
}
