import { providerRequestStreamKey, type ProviderRequestAuditEntry } from "../provider-request-audit-types.js"

/** Why a prefix break happened. `stale-mask-advanced` is a planned prefix
 *  mutation (ARCH-CONTEXT-011). `idle-gap` is only a possible cause: the gap
 *  reached the shortest retention that any supported route serves, so the
 *  cache may have expired. It carries the idle time and the retention that
 *  the previous request asked for, so a reader can see a gap shorter than
 *  the requested retention. */
type BreakExplanation =
  | { cause: "system-prompt-changed" | "tool-surface-changed" | "model-changed" | "reasoning-changed" | "compaction" | "stale-mask-advanced" }
  | { cause: "idle-gap"; idleMs: number; requestedRetention?: string }

/** A request that failed to read back the previous same-provider-session
 * prompt from cache. Explained breaks name the request change that legitimately
 * invalidated the prefix; unexplained breaks mean the message history itself
 * mutated and deserve a human's attention. */
type PrefixBreak =
  | ({ kind: "explained"; lostTokens: number; previousRequestId: string } & BreakExplanation)
  | { kind: "unexplained"; lostTokens: number; previousRequestId: string }

export interface TurnCacheReport {
  requestIdentity: string
  turn: number
  requestId: string
  model: string
  accessProvider: string
  promptKind: string
  messageCount: number
  /** Null when the provider did not report cache reads, so the prompt total and the hit ratio are unknown. */
  promptTokens: number | null
  cacheReadInputTokens: number | null
  cacheCreationInputTokens: number
  hitRatio: number | null
  systemPromptHash: string
  toolSurfaceHash: string
  prefixBreak?: PrefixBreak
}

// A follow-up request's hit ratio below this is worth a human's attention; a
// conversation's first request always starts near 0 (nothing to hit yet).
export const LOW_HIT_RATIO_THRESHOLD = 0.5
// A follow-up request should read back nearly the previous request's entire
// prompt from cache; the only legitimate loss is the tail past the final
// cache anchor. Reading back less than this fraction of the previous prompt
// means the shared prefix broke. A falling hit RATIO is not a signal: pure
// prompt growth shrinks the ratio while the read-back stays complete.
export const PREFIX_READBACK_THRESHOLD = 0.9
// The shortest cache retention that a supported route serves (the Anthropic
// 5-minute tier). A shorter gap cannot explain an expired prefix.
const SHORTEST_CACHE_RETENTION_MS = 300_000

type MeasuredUsage = NonNullable<ProviderRequestAuditEntry["usage"]> & { inputTokens: number; cacheCreationInputTokens: number }
type CompleteEntry = ProviderRequestAuditEntry & {
  prompt: NonNullable<ProviderRequestAuditEntry["prompt"]>
  request: NonNullable<ProviderRequestAuditEntry["request"]>
  usage: MeasuredUsage
}

/** Reports the requests whose provider reported usage; an unmeasured request has no cache evidence to report. */
export function buildTurnReport(entries: readonly ProviderRequestAuditEntry[]): TurnCacheReport[] {
  const withUsage = entries.filter((entry): entry is CompleteEntry =>
    entry.prompt !== undefined && entry.request !== undefined && entry.usage !== undefined
    && entry.usage.inputTokens !== null && entry.usage.cacheCreationInputTokens !== null)

  // Cache continuity belongs to one provider session. A durable conversation
  // can span several provider sessions after overflow or provider reset.
  const byProviderSession = new Map<string, CompleteEntry[]>()
  for (const entry of withUsage) {
    const identity = providerRequestStreamKey(entry.identity)
    const list = byProviderSession.get(identity)
    if (list) list.push(entry)
    else byProviderSession.set(identity, [entry])
  }

  const turns: TurnCacheReport[] = []
  for (const list of byProviderSession.values()) {
    // The turn counter restarts when a session resumes into the same
    // conversation, so chronology, not turn, is the pairing order.
    // `requestedAt` is recorded with `request`, which the filter guarantees.
    list.sort((a, b) => (a.requestedAt ?? 0) - (b.requestedAt ?? 0))
    let previous: CompleteEntry | undefined
    for (const entry of list) {
      turns.push(reportTurn(entry, previous))
      previous = entry
    }
  }
  return turns
}

function reportTurn(entry: CompleteEntry, previous: CompleteEntry | undefined): TurnCacheReport {
  const report: TurnCacheReport = {
    requestIdentity: providerRequestStreamKey(entry.identity),
    turn: entry.turn,
    requestId: entry.requestId,
    model: entry.request.model,
    accessProvider: entry.request.accessProvider,
    promptKind: entry.prompt.promptKind,
    messageCount: entry.prompt.messageCount,
    promptTokens: entry.usage.promptTokens,
    cacheReadInputTokens: entry.usage.cacheReadInputTokens,
    cacheCreationInputTokens: entry.usage.cacheCreationInputTokens,
    hitRatio: entry.usage.promptTokens === null || entry.usage.cacheReadInputTokens === null ? null
      : entry.usage.promptTokens > 0 ? entry.usage.cacheReadInputTokens / entry.usage.promptTokens : 0,
    systemPromptHash: entry.prompt.systemPromptHash,
    toolSurfaceHash: entry.prompt.toolSurfaceHash,
  }
  const prefixBreak = previous ? detectPrefixBreak(entry, previous) : undefined
  if (prefixBreak) report.prefixBreak = prefixBreak
  return report
}

function detectPrefixBreak(entry: CompleteEntry, previous: CompleteEntry): PrefixBreak | undefined {
  const readBack = entry.usage.cacheReadInputTokens
  const previousPrompt = previous.usage.promptTokens
  // Without reported cache reads on both sides, a break cannot be told from a hit.
  if (readBack === null || previousPrompt === null || readBack >= previousPrompt * PREFIX_READBACK_THRESHOLD) return undefined
  const lostTokens = Math.max(0, previousPrompt - readBack)
  const explanation = explainBreak(entry, previous)
  return explanation
    ? { kind: "explained", ...explanation, lostTokens, previousRequestId: previous.requestId }
    : { kind: "unexplained", lostTokens, previousRequestId: previous.requestId }
}

function explainBreak(entry: CompleteEntry, previous: CompleteEntry): BreakExplanation | undefined {
  if (previous.prompt.systemPromptHash !== entry.prompt.systemPromptHash) return { cause: "system-prompt-changed" }
  if (previous.prompt.toolSurfaceHash !== entry.prompt.toolSurfaceHash) return { cause: "tool-surface-changed" }
  if (previous.request.model !== entry.request.model
    || previous.request.accessProvider !== entry.request.accessProvider) return { cause: "model-changed" }
  // Providers key the cache on the thinking configuration; toggling effort
  // invalidates the whole prefix even when every byte is identical.
  if (previous.request.reasoningEffort !== entry.request.reasoningEffort) return { cause: "reasoning-changed" }
  if (entry.prompt.messageCount < previous.prompt.messageCount) return { cause: "compaction" }
  // A mask advance is a certain mutation and idle expiry only a possible
  // one, so the mask is checked first.
  const mask = entry.prompt.staleMasking
  const previousMask = previous.prompt.staleMasking
  if (mask?.cutoffIndex !== previousMask?.cutoffIndex || mask?.zone !== previousMask?.zone) return { cause: "stale-mask-advanced" }
  const idleMs = (entry.requestedAt ?? 0) - (previous.respondedAt ?? previous.requestedAt ?? 0)
  if (idleMs >= SHORTEST_CACHE_RETENTION_MS) {
    const requestedRetention = previous.request.cacheRetention
    return { cause: "idle-gap", idleMs, ...(requestedRetention === undefined ? {} : { requestedRetention }) }
  }
  return undefined
}
