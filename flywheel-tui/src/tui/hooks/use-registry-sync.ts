/**
 * Registry Sync Hook — syncs foreground session registry entry to display signals.
 *
 * Subscribes to the session registry and propagates runtime data changes to
 * the shell's display signals (output blocks, steps, tokens, cost, etc).
 *
 * Terminal state handling (completed/error) is NOT done here — it is handled
 * by `onRunnerDone`/`onRunnerError` callbacks wired by the caller of
 * `registry.start()` / `registry.startChat()`.
 *
 * Uses `kind` guards to safely handle both workflow and chat entries:
 * - `steps` only exist on workflow entries
 * - Chat entries never transition to "paused"
 */

import type { Accessor, Setter } from "solid-js"
import type { SessionRegistry } from "../../orchestration/session-registry.js"
import type { MetricsHook } from "./use-metrics.js"
import type { AnyBlock } from "../types.js"
import type { StepState } from "../../orchestration/workflow-runner.js"
import type { AgentState } from "./use-workflow-lifecycle.js"
import { TERMINAL_TITLE_PREFIX } from "./use-workflow-lifecycle.js"

export interface RegistrySyncDeps {
  registry: SessionRegistry
  foregroundId: Accessor<string | undefined>
  setAgentState: Setter<AgentState>
  setOutputBlocks: Setter<AnyBlock[]>
  setSteps: Setter<StepState[]>
  setRunningCount: Setter<number>
  setSessionTitle: Setter<string>
  setTerminalTitle: (title: string) => void
  metrics: MetricsHook
}

/**
 * Subscribe to the session registry and sync foreground entry changes to
 * display signals. Returns the unsubscribe function for cleanup.
 */
export function useRegistrySync(deps: RegistrySyncDeps): () => void {
  const {
    registry,
    foregroundId,
    setAgentState,
    setOutputBlocks,
    setSteps,
    setRunningCount,
    setSessionTitle,
    setTerminalTitle,
    metrics,
  } = deps

  // Track previous outputBlocks reference for identity-check optimization
  let prevOutputBlocks: readonly import("../../infra/output-blocks.js").AnyBlock[] | null = null

  // ── Main subscriber: sync live state ──

  return registry.subscribe(() => {
    setRunningCount(registry.runningCount())

    const fgId = foregroundId()
    if (!fgId) return

    const entry = registry.get(fgId)
    if (!entry) return

    metrics.setActivity(entry.modelActivity)

    // Entry exists = active. Derive agent state from model activity.
    setAgentState(entry.modelActivity !== "idle" ? "active" : "idle")

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
  })
}
