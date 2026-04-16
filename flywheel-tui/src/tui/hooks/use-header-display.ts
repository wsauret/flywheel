import { createMemo } from "solid-js"
import type { Accessor } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { StepState } from "../../orchestration/workflow-runner.js"
import { formatElapsed, formatCost } from "../../infra/format.js"
import type { ShellSignals } from "./shell-state.js"
import type { MetricsHook } from "./use-metrics.js"

interface HeaderDisplayDeps {
  signals: ShellSignals
  metrics: MetricsHook
  dimensions: Accessor<{ width: number; height: number }>
  inChat: Accessor<boolean>
  runningCount: Accessor<number>
  theme: { error: RGBA; warning: RGBA; success: RGBA; textMuted: RGBA }
}

interface HeaderDisplay {
  displayStatus: Accessor<"running" | "idle" | "interrupted" | "completed">
  headerRight: Accessor<string>
  headerRightColor: Accessor<RGBA>
  stepDisplay: Accessor<{ collapsedCount: number; visible: readonly StepState[] }>
}

export function createHeaderDisplay(deps: HeaderDisplayDeps): HeaderDisplay {
  const { signals, metrics, dimensions, inChat, runningCount, theme } = deps

  const displayStatus = createMemo((): "running" | "idle" | "interrupted" | "completed" => {
    if (signals.agentState() === "active") return "running"
    if (signals.sessionState() === "paused") return "interrupted"
    if (signals.sessionState() === "active") return inChat() ? "idle" : "running"
    return "completed"
  })

  const headerRight = createMemo(() => {
    const state = signals.sessionState()
    const bgCount = runningCount()
    const bgSuffix = bgCount > 1 ? ` (+${bgCount - 1} bg)` : ""
    if (state === null) return bgCount > 0 ? `${bgCount} running` : (signals.errorMessage() ? "error" : "")
    if (signals.errorMessage()) return "error" + bgSuffix

    const width = dimensions().width
    const parts: string[] = []
    if (state === "completed") parts.push("done")
    parts.push(formatElapsed(metrics.elapsed()))
    if (width >= 60) parts.push(`${metrics.liveContextPercent()}% ctx`)
    const c = metrics.liveCost()
    if (c > 0 && width >= 80) parts.push(formatCost(c))
    return parts.join(" \u00b7 ") + bgSuffix
  })

  const headerRightColor = createMemo(() => {
    const state = signals.sessionState()
    if (state === null && signals.errorMessage()) return theme.error
    if (state === "paused" && signals.errorMessage()) return theme.error
    if (state === "paused") return theme.warning
    if (state === "completed") return theme.success
    const ctx = metrics.liveContextPercent()
    if (ctx >= 85) return theme.error
    if (ctx >= 70) return theme.warning
    return theme.textMuted
  })

  const stepDisplay = createMemo(() => {
    const steps = signals.steps()
    if (steps.length === 0) return { collapsedCount: 0, visible: steps }

    const available = dimensions().width - 4
    const estimateWidth = (items: typeof steps, prefixLen: number) => {
      let w = prefixLen
      for (let i = 0; i < items.length; i++) {
        if (i > 0 || prefixLen > 0) w += 3  // " > "
        if (items[i]!.status === "completed" || items[i]!.status === "failed") w += 2
        w += items[i]!.title.length
        if (items[i]!.status === "running") w += 5  // elapsed estimate
      }
      return w
    }

    if (estimateWidth(steps, 0) <= available) return { collapsedCount: 0, visible: steps }

    let count = 0
    for (const step of steps) {
      if (step.status !== "completed") break
      count++
      const remaining = steps.slice(count)
      if (estimateWidth(remaining, `${count} done`.length) <= available) {
        return { collapsedCount: count, visible: remaining }
      }
    }

    const runIdx = steps.findIndex(s => s.status === "running")
    if (runIdx > 0) return { collapsedCount: runIdx, visible: steps.slice(runIdx) }
    return { collapsedCount: 0, visible: steps }
  })

  return { displayStatus, headerRight, headerRightColor, stepDisplay }
}
