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

import { TERMINAL_TITLE_PREFIX } from "./use-workflow-lifecycle.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"

export interface RegistrySyncDeps {
  signals: ShellSignals
  services: ShellServices
}

/**
 * Subscribe to the session registry and sync foreground entry changes to
 * display signals. Returns the unsubscribe function for cleanup.
 */
export function useRegistrySync(deps: RegistrySyncDeps): () => void {
  const { signals, services } = deps
  const { registry, metrics } = services

  // Track previous outputBlocks reference for identity-check optimization
  let prevOutputBlocks: readonly import("../../infra/output-blocks.js").AnyBlock[] | null = null

  // ── Main subscriber: sync live state ──

  return registry.subscribe(() => {
    // Bump registryVersion so the sessionState memo re-evaluates
    services.bumpRegistryVersion()

    signals.setRunningCount(registry.runningCount())

    const fgId = signals.foregroundId()
    if (!fgId) return

    const entry = registry.get(fgId)
    if (!entry) return

    metrics.setActivity(entry.modelActivity)

    // Entry exists = active. Derive agent state from model activity.
    signals.setAgentState(entry.modelActivity !== "idle" ? "active" : "idle")

    if (entry.outputBlocks !== prevOutputBlocks) {
      prevOutputBlocks = entry.outputBlocks
      signals.setOutputBlocks([...entry.outputBlocks])
    }

    if (entry.kind === "workflow") {
      signals.setSteps([...entry.steps])
    } else {
      signals.setSteps([])
    }

    metrics.setTokens(entry.tokens)
    metrics.setCost(entry.cost)
    metrics.setContextPercent(entry.contextPercent)
    signals.setSessionTitle(entry.description)
    services.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}${entry.description}`)
  })
}
