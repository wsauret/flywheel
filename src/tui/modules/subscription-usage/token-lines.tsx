/** @jsxImportSource @opentui/solid */
import { useTheme } from "../../context/theme.js"
import { USAGE_CACHE_UNAVAILABLE_REASON, usageCoverageText, usageTokenBreakdown, type UsageCoverageCounts, type UsageTokens } from "../../../protocol/modules/subscription-usage.js"

/** The same reported token buckets in session, source, model, and range views. */
export function UsageTokenLines(props: { tokens: UsageTokens; coverage: UsageCoverageCounts }) {
  const { theme } = useTheme()
  const counts = () => usageTokenBreakdown(props.tokens)
  const cached = (value: number) => props.coverage.cacheComplete ? number(value) : "Unavailable"
  const rate = () => {
    if (!props.coverage.cacheComplete) return `Unavailable (${USAGE_CACHE_UNAVAILABLE_REASON})`
    const value = counts().cacheHitRate
    return value === null ? "No usage yet" : `${(value * 100).toFixed(1)}%`
  }
  const number = (value: number) => value.toLocaleString("en-US")
  return <box flexDirection="column">
    <text fg={theme.text}>{`Reported cache hit rate  ${rate()}`}</text>
    <text fg={theme.textMuted}>{usageCoverageText(props.coverage)}</text>
    <text fg={theme.textMuted}>{`Input ${number(counts().input)} · Cached ${cached(counts().cached)} · Uncached ${cached(counts().uncached)}`}</text>
    <text fg={theme.textMuted}>{`Cache writes ${cached(counts().cacheWrite)} · Output ${number(counts().output)}`}</text>
  </box>
}
