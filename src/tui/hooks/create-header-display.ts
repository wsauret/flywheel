import { StyledText, fg as stFg, type RGBA } from "@opentui/core"
import { createMemo, type Accessor } from "solid-js"
import { formatCostSplit, formatElapsed } from "../../protocol/client/format.js"
import { compactionTrigger, contextGaugeCopy, type ContextGaugeCopy } from "../../protocol/client/context-compaction.js"
import { sessionHeaderElapsedMs } from "../../protocol/client/session-time.js"
import { displayWidth } from "../utils/text.js"
import { isEmptyNewChat } from "../session-empty-state.js"
import type { ShellSignals } from "./shell-state.js"
import type { SessionSurface } from "./create-session-surface.js"

type HeaderTarget = Pick<SessionSurface, "budget" | "summary" | "elapsed">

/** The context reading of a session and the trigger it measures against, or null while either is unknown. */
function sessionContext(target: HeaderTarget, threshold: number | undefined): { readonly copy: ContextGaugeCopy; readonly trigger: number; readonly tokens: number } | null {
  const budget = target.budget()
  const summary = target.summary()
  if (budget?.totalsLoading || summary?.totalsLoading) return null
  const tokens = budget?.contextPromptTokens ?? summary?.contextPromptTokens
  if (tokens === undefined || threshold === undefined) return null
  const reading = { contextPromptTokens: tokens, contextPercent: budget?.contextPercent ?? summary?.contextPercent ?? 0, compactionThreshold: threshold, compactionTriggerTokens: budget?.compactionTriggerTokens ?? summary?.compactionTriggerTokens }
  return { copy: contextGaugeCopy(reading), trigger: compactionTrigger(reading), tokens }
}

function headerElapsedMs(target: HeaderTarget): number {
  return sessionHeaderElapsedMs(target.summary() ?? undefined, target.elapsed())
}

function headerCostText(target: HeaderTarget): string {
  const budget = target.budget()
  const summary = target.summary()
  const cost = budget?.cost ?? summary?.totalCost ?? 0
  const costPart = formatCostSplit(cost, budget?.billedCost ?? summary?.totalBilledCost ?? cost)
  const priceUnavailable = budget?.priceUnavailable ?? summary?.priceUnavailable ?? false
  return costPart && priceUnavailable ? `${costPart} · price unavailable` : costPart
}

/** Derives the ordinary header for any session, without reading foreground state. */
export function sessionHeaderParts(target: HeaderTarget, width: number, threshold: number | undefined) {
  const summary = target.summary()
  const budget = target.budget()
  const totalsLoading = budget?.totalsLoading === true || summary?.totalsLoading === true
  const parts: string[] = []
  const elapsedMs = headerElapsedMs(target)
  if (elapsedMs >= 1000) parts.push(formatElapsed(elapsedMs))
  const reading = sessionContext(target, threshold)
  const context = width < 60 ? "" : totalsLoading && width < 80 ? "totals loading" : reading === null ? "… ctx" : reading.trigger === 0 && threshold === 0
    ? `${(reading.tokens / 1000).toFixed(1)}k ctx`
    : `${Math.round(reading.copy.used * 100)}% ctx`
  const before = parts.join(" · ") + (parts.length > 0 && context ? " · " : "")
  const average = budget?.averageGenerationTokensPerSecond
  const speed = width >= 80 && average !== undefined ? `${Math.round(average)} tok/s` : ""
  if (totalsLoading) return { before, context, after: width >= 80 ? `${before || context ? " · " : ""}${["totals loading", speed].filter(Boolean).join(" · ")}` : "" }
  const costText = width >= 80 ? headerCostText(target) : ""
  const after = [costText, speed].filter(Boolean).join(" · ")
  return { before, context, after: after ? `${before || context ? " · " : ""}${after}` : "" }
}

type HeaderDisplaySignals = Pick<
  ShellSignals,
  "budgetView" | "elapsed" | "foregroundId" | "foregroundSummary" | "outputView" | "sessionState"
>

interface HeaderDisplayDeps {
  signals: HeaderDisplaySignals
  dimensions: Accessor<{ width: number; height: number }>
  compactionThreshold: Accessor<number | undefined>
  theme: { text: RGBA }
}

interface HeaderDisplay {
  headerStats: Accessor<{
    content: StyledText
    width: number
    context: { label: string; left: number; color: RGBA } | null
  }>
  contextCopy: Accessor<ContextGaugeCopy | null>
}

/** The foreground chat's header: its statistics and its context gauge. A
 *  workflow's phases belong to its viewer. */
export function createHeaderDisplay(deps: HeaderDisplayDeps): HeaderDisplay {
  const { signals, dimensions, theme } = deps

  const foregroundBudget = () => {
    const sessionId = signals.foregroundId()
    return sessionId ? signals.budgetView(sessionId) : undefined
  }

  const target = { budget: foregroundBudget, summary: signals.foregroundSummary, elapsed: signals.elapsed }
  const contextCopy = createMemo(() => sessionContext(target, deps.compactionThreshold())?.copy ?? null)

  const headerParts = createMemo(() => {
    const state = signals.sessionState()
    if (state === null) return { before: "", context: "", after: "" }
    const sessionId = signals.foregroundId()
    // A side question adds usage but no transcript block, so a chat stays an
    // empty new chat with known statistics; those stay visible (PI-INTERACTION-006).
    const budget = foregroundBudget()
    const recordedUsage = budget !== undefined && !budget.totalsLoading && (budget.tokens > 0 || budget.cost > 0)
    if (!recordedUsage && isEmptyNewChat(signals.foregroundSummary(), sessionId ? signals.outputView(sessionId) : undefined)) {
      return { before: "", context: "", after: "" }
    }

    return sessionHeaderParts(target, dimensions().width, deps.compactionThreshold())
  })

  const headerStats = createMemo(() => {
    const parts = headerParts()
    const before = parts.context ? parts.before.trimEnd() : parts.before
    const text = parts.context
      ? `${before} ${parts.context} ${parts.after.trimStart()}`
      : before + parts.after
    return {
      content: new StyledText(text ? [stFg(theme.text)(text)] : []),
      width: displayWidth(text),
      context: parts.context
        ? { label: parts.context, left: displayWidth(before), color: theme.text }
        : null,
    }
  })

  return { headerStats, contextCopy }
}
