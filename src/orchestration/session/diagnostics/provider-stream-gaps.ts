import { searchEvents, type EventSearchQuery } from "../../../infra/event-search.js"
import type { StoredFact } from "../../../infra/event-store-types.js"
import { formatDuration } from "../../../protocol/client/format.js"
import { canonicalProviderStreamSummary, readProviderRequestAuditFact, type ProviderRequestAuditFact } from "../provider-request-audit-facts.js"
import type { ProviderStreamSummary } from "../provider-request-audit-types.js"

// Analyzes durable stream telemetry summaries. Historical stores can also hold
// raw stream facts, which remain valid inputs until retired maintenance removes
// them. Debug-log rows never enter this functional projection.

type Provider = "anthropic" | "openai" | "unknown"

interface GapStats {
  count: number
  mean: number
  p50: number
  p90: number
  p99: number
  max: number
  ge1s: number
  ge2s: number
  ge5s: number
  ge10s: number
}

// The stored summary fact's inter-delta block is the canonical per-millisecond
// gap distribution; the accumulator folds many of these into one combined view.
type SummaryGapStats = ProviderStreamSummary["interDelta"]

interface StatsAccumulator {
  values: number[]
  summaries: { count: number; p50: number; p90: number; p99: number }[]
  count: number
  sum: number
  max: number
  ge1s: number
  ge2s: number
  ge5s: number
  ge10s: number
}

function createStatsAccumulator(): StatsAccumulator {
  return { values: [], summaries: [], count: 0, sum: 0, max: 0, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 }
}

function addValue(acc: StatsAccumulator, value: number): void {
  acc.values.push(value)
  acc.count += 1
  acc.sum += value
  acc.max = Math.max(acc.max, value)
  if (value >= 1000) acc.ge1s += 1
  if (value >= 2000) acc.ge2s += 1
  if (value >= 5000) acc.ge5s += 1
  if (value >= 10000) acc.ge10s += 1
}

function addSummary(acc: StatsAccumulator, stats: SummaryGapStats): void {
  if (stats.count === 0) return
  acc.count += stats.count
  acc.sum += stats.meanMs * stats.count
  acc.max = Math.max(acc.max, stats.maxMs)
  acc.ge1s += stats.ge1s
  acc.ge2s += stats.ge2s
  acc.ge5s += stats.ge5s
  acc.ge10s += stats.ge10s
  acc.summaries.push({ count: stats.count, p50: stats.p50Ms, p90: stats.p90Ms, p99: stats.p99Ms })
}

function addMaxOnlySummary(acc: StatsAccumulator, count: number, max: number): void {
  addSummary(acc, {
    count,
    meanMs: max,
    p50Ms: max,
    p90Ms: max,
    p99Ms: max,
    maxMs: max,
    ge1s: max >= 1000 ? count : 0,
    ge2s: max >= 2000 ? count : 0,
    ge5s: max >= 5000 ? count : 0,
    ge10s: max >= 10000 ? count : 0,
  })
}

function finishStats(acc: StatsAccumulator): GapStats {
  if (acc.count === 0) return computeStats([])
  const rawStats = computeStats(acc.values)
  return {
    count: acc.count,
    mean: acc.sum / acc.count,
    p50: approximatePercentile(acc, rawStats, "p50"),
    p90: approximatePercentile(acc, rawStats, "p90"),
    p99: approximatePercentile(acc, rawStats, "p99"),
    max: acc.max,
    ge1s: acc.ge1s,
    ge2s: acc.ge2s,
    ge5s: acc.ge5s,
    ge10s: acc.ge10s,
  }
}

function computeStats(values: number[]): GapStats {
  if (values.length === 0) {
    return { count: 0, mean: 0, p50: 0, p90: 0, p99: 0, max: 0, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, value) => acc + value, 0)
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
    ge1s: sorted.filter((value) => value >= 1000).length,
    ge2s: sorted.filter((value) => value >= 2000).length,
    ge5s: sorted.filter((value) => value >= 5000).length,
    ge10s: sorted.filter((value) => value >= 10000).length,
  }
}

function approximatePercentile(acc: StatsAccumulator, rawStats: GapStats, key: "p50" | "p90" | "p99"): number {
  let weighted = rawStats[key] * acc.values.length
  for (const summary of acc.summaries) weighted += summary[key] * summary.count
  return Math.round(weighted / acc.count)
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  return sorted[index] ?? 0
}

const STREAM_EVENT_TYPE = "model.stream.event_observed"
const STREAM_SUMMARY_TYPE = "model.stream.summary.recorded"
const VISIBLE_DELTA_KINDS = new Set(["thinking_delta", "text_delta", "tool_input_delta"])
const BIG_GAP_MS = 5000
const BUCKET_MS = 2000

interface StreamFact {
  requestId: string
  sequence: number
  source: string
  kind: string
  elapsedMs: number
}

interface HistogramBucket {
  startMs: number
  count: number
}

interface TransitionCount {
  transition: string
  count: number
}

export interface StreamGapReport {
  storeFound: boolean
  dbPath: string
  requests: number
  rawRequests: number
  summarizedRequests: number
  // Time-to-first-visible-token per turn (request sent -> first visible delta).
  warmup: GapStats
  warmupByProvider: { provider: Provider; stats: GapStats }[]
  warmupHistogram: HistogramBucket[]
  timeoutCluster: { startMs: number; count: number; share: number } | null
  // Gaps between consecutive visible deltas within a single stream.
  interDelta: GapStats
  bigGapTransitions: TransitionCount[]
  watchdogStalls: GapStats
}

export function analyzeStreamGaps(scope: Pick<EventSearchQuery, "baseDir" | "sessionId" | "requestId" | "sinceTimestamp" | "untilTimestamp">): StreamGapReport {
  const result = searchEvents({
    ...scope,
    typePatterns: [STREAM_EVENT_TYPE, STREAM_SUMMARY_TYPE],
    limit: 0,
  })
  if (!result.storeFound) return emptyReport(result.dbPath)

  const mergedFacts: StoredFact[] = result.matches.flatMap((row) => row.source === "store" ? [row.fact] : [])
  const rawEvents = mergedFacts.filter((event) => event.type === STREAM_EVENT_TYPE)
  const summaryEvents = mergedFacts.filter((event) => event.type === STREAM_SUMMARY_TYPE)
  const byRequest = groupByRequest(rawEvents)
  const summaries = summaryEvents.map(parseSummaryFact)
  const summaryOnly = summaries.filter((summary) => !byRequest.has(summary.requestId))
  const warmups: number[] = []
  const warmupBuckets = new Map<Provider, number[]>()
  const interDelta = createStatsAccumulator()
  const watchdog = createStatsAccumulator()
  const bigTransitions = new Map<string, number>()

  for (const facts of byRequest.values()) {
    addRawRequestGaps(facts, warmups, warmupBuckets, interDelta, bigTransitions)
  }

  addRawWatchdogGaps(rawEvents, watchdog)

  for (const summary of summaryOnly) {
    addSummaryGaps(summary, warmups, warmupBuckets, interDelta, watchdog, bigTransitions)
  }

  const warmupHistogram = histogram(warmups)
  return {
    storeFound: true,
    dbPath: result.dbPath,
    requests: byRequest.size + summaryOnly.length,
    rawRequests: byRequest.size,
    summarizedRequests: summaryOnly.length,
    warmup: computeStats(warmups),
    warmupByProvider: [...warmupBuckets.entries()]
      .map(([provider, values]) => ({ provider, stats: computeStats(values) }))
      .sort((a, b) => b.stats.count - a.stats.count),
    warmupHistogram,
    timeoutCluster: detectTimeoutCluster(warmupHistogram, warmups.length),
    interDelta: finishStats(interDelta),
    bigGapTransitions: [...bigTransitions.entries()]
      .map(([transition, count]) => ({ transition, count }))
      .sort((a, b) => b.count - a.count),
    watchdogStalls: finishStats(watchdog),
  }
}

function addRawRequestGaps(
  facts: StreamFact[],
  warmups: number[],
  warmupBuckets: Map<Provider, number[]>,
  interDelta: ReturnType<typeof createStatsAccumulator>,
  bigTransitions: Map<string, number>,
): void {
  facts.sort((a, b) => a.sequence - b.sequence)
  const firstVisibleElapsed = addVisibleDeltaGaps(facts, interDelta, bigTransitions)
  if (firstVisibleElapsed !== null) addWarmup(warmups, warmupBuckets, detectProvider(facts), firstVisibleElapsed)
}

function addVisibleDeltaGaps(
  facts: readonly StreamFact[],
  interDelta: ReturnType<typeof createStatsAccumulator>,
  bigTransitions: Map<string, number>,
): number | null {
  let firstVisibleElapsed: number | null = null
  let prevDelta: StreamFact | null = null
  for (const fact of facts) {
    if (fact.source === "watchdog") continue
    if (fact.source !== "normalized" || !VISIBLE_DELTA_KINDS.has(fact.kind)) continue
    if (firstVisibleElapsed === null) firstVisibleElapsed = fact.elapsedMs
    if (prevDelta) recordInterDeltaGap(interDelta, bigTransitions, prevDelta, fact)
    prevDelta = fact
  }
  return firstVisibleElapsed
}

function recordInterDeltaGap(
  interDelta: ReturnType<typeof createStatsAccumulator>,
  bigTransitions: Map<string, number>,
  previous: StreamFact,
  current: StreamFact,
): void {
  const gap = current.elapsedMs - previous.elapsedMs
  addValue(interDelta, gap)
  if (gap >= BIG_GAP_MS) {
    const key = `${previous.kind}->${current.kind}`
    bigTransitions.set(key, (bigTransitions.get(key) ?? 0) + 1)
  }
}

function addRawWatchdogGaps(rawEvents: readonly StoredFact[], watchdog: ReturnType<typeof createStatsAccumulator>): void {
  for (const event of rawEvents) {
    const fact = parseStreamEventFact(event)
    if (fact.source === "watchdog") addValue(watchdog, fact.sincePreviousMs)
  }
}

function addSummaryGaps(
  summary: ProviderStreamSummary,
  warmups: number[],
  warmupBuckets: Map<Provider, number[]>,
  interDelta: ReturnType<typeof createStatsAccumulator>,
  watchdog: ReturnType<typeof createStatsAccumulator>,
  bigTransitions: Map<string, number>,
): void {
  const provider = detectSummaryProvider(summary.countsByKind)
  if (summary.firstVisibleDeltaMs !== undefined) addWarmup(warmups, warmupBuckets, provider, summary.firstVisibleDeltaMs)
  addSummary(interDelta, summary.interDelta)
  if (summary.watchdog.thinkingStallCount > 0 && summary.watchdog.maxStallMs !== undefined) {
    addMaxOnlySummary(watchdog, summary.watchdog.thinkingStallCount, summary.watchdog.maxStallMs)
  }
  for (const transition of summary.bigGapTransitions) {
    bigTransitions.set(transition.transition, (bigTransitions.get(transition.transition) ?? 0) + transition.count)
  }
}

function addWarmup(
  warmups: number[],
  warmupBuckets: Map<Provider, number[]>,
  provider: Provider,
  elapsedMs: number,
): void {
  warmups.push(elapsedMs)
  const bucket = warmupBuckets.get(provider) ?? []
  bucket.push(elapsedMs)
  warmupBuckets.set(provider, bucket)
}

// Decode one stored row through the family's historical reader. A shape that
// neither the strict decode nor a reviewed salvage rule reads is a writer bug,
// so the reader surfaces it as an InvariantViolation rather than letting the
// analyzer silently drop the row (ARCH-BOUNDARIES-004, ARCH-SUBSTRATE-012).
function parseStreamEventFact(event: StoredFact): Extract<
  ProviderRequestAuditFact,
  { type: typeof STREAM_EVENT_TYPE }
>["payload"] {
  const fact = readProviderRequestAuditFact(event)
  if (fact.type !== STREAM_EVENT_TYPE) {
    throw new Error(`expected ${STREAM_EVENT_TYPE} fact, got ${fact.type}`)
  }
  return fact.payload
}

function parseSummaryFact(event: StoredFact): ProviderStreamSummary {
  const fact = readProviderRequestAuditFact(event)
  if (fact.type !== STREAM_SUMMARY_TYPE) {
    throw new Error(`expected ${STREAM_SUMMARY_TYPE} fact, got ${fact.type}`)
  }
  return canonicalProviderStreamSummary(fact)
}

function groupByRequest(events: readonly StoredFact[]): Map<string, StreamFact[]> {
  const byRequest = new Map<string, StreamFact[]>()
  for (const event of events) {
    const { requestId, sequence, source, kind, elapsedMs } = parseStreamEventFact(event)
    const facts = byRequest.get(requestId) ?? []
    facts.push({ requestId, sequence, source, kind, elapsedMs })
    byRequest.set(requestId, facts)
  }
  return byRequest
}

function detectProvider(facts: readonly StreamFact[]): Provider {
  for (const fact of facts) {
    if (fact.kind.startsWith("content_block") || fact.kind === "message_start") return "anthropic"
    if (fact.kind.startsWith("response.")) return "openai"
  }
  return "unknown"
}

function detectSummaryProvider(countsByKind: StringMap<number>): Provider {
  return detectProvider(Object.keys(countsByKind).map((kind, index) => ({ requestId: "summary", sequence: index, source: "provider", kind, elapsedMs: 0 })))
}

function histogram(values: number[]): HistogramBucket[] {
  const counts = new Map<number, number>()
  for (const value of values) {
    const start = Math.floor(value / BUCKET_MS) * BUCKET_MS
    counts.set(start, (counts.get(start) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([startMs, count]) => ({ startMs, count }))
    .sort((a, b) => a.startMs - b.startMs)
}

// A fixed timeout/retry shows up as a pile-up in a single high bucket rather
// than the smooth decay of natural latency. Flag the largest bucket at or above
// 10s when it holds a disproportionate share of turns.
function detectTimeoutCluster(
  buckets: readonly HistogramBucket[],
  total: number,
): { startMs: number; count: number; share: number } | null {
  if (total === 0) return null
  let candidate: HistogramBucket | null = null
  for (const bucket of buckets) {
    if (bucket.startMs < 10000) continue
    if (!candidate || bucket.count > candidate.count) candidate = bucket
  }
  if (!candidate) return null
  const clusterShare = candidate.count / total
  return clusterShare >= 0.1 ? { startMs: candidate.startMs, count: candidate.count, share: clusterShare } : null
}

function emptyReport(dbPath: string): StreamGapReport {
  const empty = computeStats([])
  return {
    storeFound: false,
    dbPath,
    requests: 0,
    rawRequests: 0,
    summarizedRequests: 0,
    warmup: empty,
    warmupByProvider: [],
    warmupHistogram: [],
    timeoutCluster: null,
    interDelta: empty,
    bigGapTransitions: [],
    watchdogStalls: empty,
  }
}

export function formatStreamGapReport(report: StreamGapReport, options: { json: boolean }): string {
  if (options.json) return JSON.stringify(report)

  const lines: string[] = []
  lines.push(`stream gap analysis over ${report.requests} request(s) (${report.rawRequests} raw, ${report.summarizedRequests} summarized) in ${report.dbPath}`)
  lines.push("")
  lines.push("warmup (request sent -> first visible token):")
  lines.push(`  ${formatStatsLine(report.warmup)}`)
  for (const { provider, stats } of report.warmupByProvider) {
    lines.push(`    ${provider.padEnd(9)} ${formatStatsLine(stats)}`)
  }
  if (report.timeoutCluster) {
    const { startMs, count, share: clusterShare } = report.timeoutCluster
    lines.push(
      `  ⚠ pile-up at ${formatDuration(startMs)}-${formatDuration(startMs + BUCKET_MS)}: ` +
        `${count} turns (${(clusterShare * 100).toFixed(1)}%), likely a fixed timeout/retry, not server latency`,
    )
  }
  lines.push("")
  lines.push("inter-delta gaps (visible delta -> next visible delta, same stream):")
  lines.push(`  ${formatStatsLine(report.interDelta)}`)
  if (report.bigGapTransitions.length > 0) {
    lines.push(`  transitions straddled by gaps >= ${formatDuration(BIG_GAP_MS)}:`)
    for (const { transition, count } of report.bigGapTransitions) lines.push(`    ${count}× ${transition}`)
  }
  lines.push("")
  lines.push("watchdog stalls (silence the watchdog flagged):")
  lines.push(`  ${formatStatsLine(report.watchdogStalls)}`)
  return lines.join("\n")
}

function formatStatsLine(stats: GapStats): string {
  if (stats.count === 0) return "no samples"
  return (
    `n=${stats.count} mean=${formatDuration(Math.round(stats.mean))} ` +
    `p50=${formatDuration(stats.p50)} p90=${formatDuration(stats.p90)} ` +
    `p99=${formatDuration(stats.p99)} max=${formatDuration(stats.max)} | ` +
    `≥1s ${share(stats.ge1s, stats.count)} ≥2s ${share(stats.ge2s, stats.count)} ` +
    `≥5s ${share(stats.ge5s, stats.count)} ≥10s ${share(stats.ge10s, stats.count)}`
  )
}

function share(part: number, total: number): string {
  if (total === 0) return "0 (0%)"
  return `${part} (${((part / total) * 100).toFixed(1)}%)`
}
interface StringMap<T> { [key: string]: T }
