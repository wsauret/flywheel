import { createMemo } from "solid-js"
import type { Accessor } from "solid-js"
import { StyledText, fg as stFg, bold as stBold, dim as stDim, type TextChunk } from "@opentui/core"
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
  now: Accessor<number>
  engineName?: string
  modelName?: string
  theme: {
    primary: RGBA; text: RGBA; textMuted: RGBA; textSubtle: RGBA
    borderSubtle: RGBA; error: RGBA; warning: RGBA; success: RGBA
  }
}

export interface HeaderDisplay {
  displayStatus: Accessor<"running" | "idle" | "interrupted" | "completed">
  headerLeftContent: Accessor<StyledText>
  headerRightContent: Accessor<StyledText>
  stepBarContent: Accessor<StyledText | null>
}

export function createHeaderDisplay(deps: HeaderDisplayDeps): HeaderDisplay {
  const { signals, metrics, dimensions, inChat, runningCount, now, engineName, modelName, theme } = deps

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

  const headerLeftContent = createMemo(() => {
    const chunks: TextChunk[] = [stBold(stFg(theme.primary)("\u2699 flywheel"))]
    const title = signals.sessionTitle()
    if (title) {
      chunks.push(stFg(theme.textMuted)(" \u00b7 "), stFg(theme.text)(title))
    }
    return new StyledText(chunks)
  })

  const headerRightContent = createMemo(() => {
    const chunks: TextChunk[] = []
    let hasPrev = false
    const sep = () => { if (hasPrev) chunks.push(stFg(theme.textSubtle)(" \u00b7 ")); hasPrev = true }
    if (engineName) { sep(); chunks.push(stFg(theme.textSubtle)(engineName)) }
    if (modelName) { sep(); chunks.push(stFg(theme.textSubtle)(modelName)) }
    const fgId = signals.foregroundId()
    if (fgId) { sep(); chunks.push(stFg(theme.textSubtle)("ID: " + fgId)) }
    const hr = headerRight()
    if (hr) { sep(); chunks.push(stFg(headerRightColor())(hr)) }
    return new StyledText(chunks)
  })

  const stepBarContent = createMemo((): StyledText | null => {
    const display = stepDisplay()
    if (display.visible.length === 0) return null
    const chunks: TextChunk[] = []
    if (display.collapsedCount > 0) {
      chunks.push(stDim(stFg(theme.success)(`${display.collapsedCount} done`)))
    }
    for (let i = 0; i < display.visible.length; i++) {
      const step = display.visible[i]!
      if (i > 0 || display.collapsedCount > 0) chunks.push(stFg(theme.borderSubtle)(" \u203a "))
      const color = step.status === "completed" ? theme.success : step.status === "running" ? theme.primary : step.status === "failed" ? theme.error : theme.textMuted
      const prefix = step.status === "completed" ? "\u2713 " : step.status === "failed" ? "\u2717 " : ""
      const elapsed = step.status === "running" && step.startedAt ? ` ${formatElapsed(now() - step.startedAt)}` : ""
      let chunk: TextChunk = stFg(color)(`${prefix}${step.title}${elapsed}`)
      if (step.status === "running") chunk = stBold(chunk)
      else if (step.status !== "completed" && step.status !== "failed") chunk = stDim(chunk)
      chunks.push(chunk)
    }
    return new StyledText(chunks)
  })

  return { displayStatus, headerLeftContent, headerRightContent, stepBarContent }
}
