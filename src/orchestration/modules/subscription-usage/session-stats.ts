import { parseProjectionFact } from "../../../infra/event-projection.js"
import { CorruptEventRowError, type AsyncEventReadSurface, type StoredFact } from "../../../infra/event-store-types.js"
import { createOrderedLane } from "../../../infra/ordered-lane.js"
import { heldProjection } from "../../../infra/projection-registry.js"
import { yieldToNextTask } from "../../../infra/task-scheduling.js"
import type { GenerationStatistics } from "../../../protocol/generation-statistics.js"
import { sumUsageTokens, type UsageModelSummary, type UsageSessionStats, type UsageStatsSummary, type UsageToolStats, type UsageTokens } from "../../../protocol/modules/subscription-usage.js"
import { BUDGET_FACT_TYPES, initialBudgetProjectionState, reduceBudgetEvent } from "../../session/budget-projection.js"
import { heldSessionLineage, sessionSubtree, type SessionLineage } from "../../session/session-subtree.js"
import { parseSessionRuntimeFact } from "../../session/session-runtime-event-types.js"
import { currentUsageMeasurement } from "../../../infra/runtime-fact-types.js"
import { recordToolCallOutcome, TOOL_EXECUTION_FACT_TYPES, type ToolCallOutcome } from "../../session/tool-execution-projection.js"
import { GENERATION_EVIDENCE_FACT_TYPES, generationStatistics, initialGenerationEvidence, mergeGenerationStatistics, reduceGenerationEvidence, type GenerationEvidence } from "../../session/session-generation-statistics.js"

const zeroTokens = (): UsageTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 })
const zeroSummary = (): UsageStatsSummary => ({ attempts: 0, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: zeroTokens(), estimatedBilledUsd: 0, includedValueUsd: 0, priceUnavailable: false })
const zeroTool = (name: string): UsageToolStats => ({ name, calls: 0, errors: 0, blocked: 0, cancelled: 0, interrupted: 0, stopped: 0 })

function addSummary(left: UsageStatsSummary, right: UsageStatsSummary): UsageStatsSummary {
  return {
    attempts: left.attempts + right.attempts,
    unmeasuredAttempts: left.unmeasuredAttempts + right.unmeasuredAttempts,
    partialAttempts: left.partialAttempts + right.partialAttempts,
    cacheComplete: left.cacheComplete && right.cacheComplete,
    tokens: sumUsageTokens([left.tokens, right.tokens]),
    estimatedBilledUsd: left.estimatedBilledUsd + right.estimatedBilledUsd,
    includedValueUsd: left.includedValueUsd + right.includedValueUsd,
    priceUnavailable: left.priceUnavailable || right.priceUnavailable,
  }
}

type Leaf = {
  summary: UsageStatsSummary
  models: { [model: string]: UsageStatsSummary }
  attemptIds: { [attemptId: string]: true }
  partial: boolean
  budget: ReturnType<typeof initialBudgetProjectionState>
}

function reduceLeaf(initial: Leaf, event: StoredFact): Leaf {
  const fact = parseProjectionFact(event, parseSessionRuntimeFact)
  const previous = initial.budget
  const budget = reduceBudgetEvent(previous, event)
  const state = { ...initial, budget }
  if (fact.type === "model.usage.measured") {
    if (fact.version === 5 || fact.version === 6) {
      const entry = currentUsageMeasurement(fact)
      if (state.attemptIds[entry.attemptId]) return state
      const contribution: UsageStatsSummary = entry.coverage === "unmeasured"
        ? { ...zeroSummary(), unmeasuredAttempts: 1 }
        : {
            attempts: 1, unmeasuredAttempts: 0, partialAttempts: entry.coverage === "partial" ? 1 : 0, cacheComplete: entry.tokens.cacheRead !== null,
            tokens: { ...entry.tokens, cacheRead: entry.tokens.cacheRead ?? 0, total: entry.tokens.input + entry.tokens.output },
            estimatedBilledUsd: entry.classification === "real_spend" && entry.price.kind === "priced" ? entry.price.estimatedUsd : 0,
            includedValueUsd: entry.classification === "subscription_equivalent" && entry.price.kind === "priced" ? entry.price.estimatedUsd : 0,
            priceUnavailable: entry.price.kind === "unavailable",
          }
      return {
        ...state, summary: addSummary(state.summary, contribution),
        models: { ...state.models, [entry.model]: addSummary(state.models[entry.model] ?? zeroSummary(), contribution) },
        attemptIds: { ...state.attemptIds, [entry.attemptId]: true },
      }
    }
    if (fact.version === 4) {
      const entry = fact.payload
      if (state.attemptIds[entry.usageEntryId]) return state
      const tokens = { input: entry.inputTokensDelta, output: entry.outputTokensDelta, cacheRead: entry.cacheReadTokensDelta, cacheWrite: entry.cacheCreateTokensDelta, reasoning: entry.reasoningTokensDelta, total: entry.inputTokensDelta + entry.outputTokensDelta }
      return {
        ...state, partial: true,
        summary: addSummary(state.summary, {
          attempts: 1, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens, estimatedBilledUsd: entry.billedCostUsdDelta ?? 0,
          includedValueUsd: entry.costUsdDelta === null ? 0 : entry.costUsdDelta - (entry.billedCostUsdDelta ?? 0),
          priceUnavailable: entry.costUsdDelta === null,
        }),
        attemptIds: { ...state.attemptIds, [entry.usageEntryId]: true },
      }
    }
  }
  if (fact.type !== "model.usage.measured" && fact.type !== "model.turn.completed") return state
  const tokens = {
    input: budget.totalInputTokens - previous.totalInputTokens,
    output: budget.totalOutputTokens - previous.totalOutputTokens,
    cacheRead: 0, cacheWrite: 0, reasoning: 0,
    total: budget.totalInputTokens - previous.totalInputTokens + budget.totalOutputTokens - previous.totalOutputTokens,
  }
  const billed = budget.totalBilledCost - previous.totalBilledCost
  const included = budget.totalCost - previous.totalCost - billed
  if (fact.type === "model.turn.completed" && tokens.input === 0 && tokens.output === 0 && billed === 0 && included === 0) return state
  return {
    ...state, partial: true,
    summary: addSummary(state.summary, {
      // A cumulative reading has no cache breakdown.
      attempts: 0, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: false, tokens, estimatedBilledUsd: billed, includedValueUsd: included, priceUnavailable: false,
    }),
  }
}

const BUDGET_TYPES: ReadonlySet<string> = new Set(BUDGET_FACT_TYPES)
const GENERATION_TYPES: ReadonlySet<string> = new Set(GENERATION_EVIDENCE_FACT_TYPES)
const TOOL_TYPES: ReadonlySet<string> = new Set(TOOL_EXECUTION_FACT_TYPES)
const MEMBER_FACT_TYPES = [...new Set([...BUDGET_FACT_TYPES, ...GENERATION_EVIDENCE_FACT_TYPES, ...TOOL_EXECUTION_FACT_TYPES])]

/** One session of a subtree: its folded facts, and the statistics they give,
 *  which are derived again only after a fact of that session folds. */
interface Member {
  usage: Leaf
  readonly generation: GenerationEvidence
  readonly tools: Map<string, ToolCallOutcome>
  view?: MemberView
}

interface MemberView {
  readonly tools: ReadonlyMap<string, UsageToolStats>
  readonly inputUnrecorded: boolean
  readonly generation: GenerationStatistics
}

const emptyLeaf = (): Leaf => ({ summary: zeroSummary(), models: {}, attemptIds: {}, partial: false, budget: initialBudgetProjectionState() })
const emptyMember = (): Member => ({ usage: emptyLeaf(), generation: initialGenerationEvidence(), tools: new Map() })

/** Folds one fact into its member. Each reducer reads the fact before it
 *  changes anything, so a fact that cannot be read leaves the member as it was. */
function foldMember(member: Member, fact: StoredFact): void {
  const usage = BUDGET_TYPES.has(fact.type) ? reduceLeaf(member.usage, fact) : member.usage
  if (GENERATION_TYPES.has(fact.type)) reduceGenerationEvidence(member.generation, fact)
  if (TOOL_TYPES.has(fact.type)) recordToolCallOutcome(member.tools, fact)
  member.usage = usage
  member.view = undefined
}

function memberView(member: Member): MemberView {
  if (member.view) return member.view
  const tools = new Map<string, UsageToolStats>()
  let inputUnrecorded = false
  for (const call of member.tools.values()) {
    inputUnrecorded ||= call.inputUnrecorded === true
    const previous = tools.get(call.toolName) ?? zeroTool(call.toolName)
    tools.set(call.toolName, { ...previous, calls: previous.calls + 1,
      errors: previous.errors + (call.outcome === "error" || call.validationFailed ? 1 : 0),
      blocked: previous.blocked + (call.outcome === "blocked" ? 1 : 0),
      cancelled: previous.cancelled + (call.outcome === "cancelled" ? 1 : 0),
      interrupted: previous.interrupted + (call.outcome === "interrupted" ? 1 : 0),
      stopped: previous.stopped + (call.outcome === "stopped" ? 1 : 0),
    })
  }
  member.view = { tools, inputUnrecorded, generation: generationStatistics(member.generation) }
  return member.view
}

/** Sums members in subtree order, the session first, so every total adds
 *  its values in one stable order. */
function summarize(sessionId: string, members: readonly Member[]): Omit<UsageSessionStats, "asOf"> {
  const models = new Map<string, UsageStatsSummary>()
  const tools = new Map<string, UsageToolStats>()
  let totals = zeroSummary()
  let direct = zeroSummary()
  let descendantTotals = zeroSummary()
  let partial = false
  for (const [index, member] of members.entries()) {
    const { usage } = member
    const view = memberView(member)
    partial ||= usage.partial || view.inputUnrecorded
    totals = addSummary(totals, usage.summary)
    if (index === 0) direct = usage.summary
    else descendantTotals = addSummary(descendantTotals, usage.summary)
    for (const [model, summary] of Object.entries(usage.models)) models.set(model, addSummary(models.get(model) ?? zeroSummary(), summary))
    for (const tool of view.tools.values()) {
      const previous = tools.get(tool.name) ?? zeroTool(tool.name)
      tools.set(tool.name, { name: tool.name, calls: previous.calls + tool.calls, errors: previous.errors + tool.errors,
        blocked: previous.blocked + tool.blocked, cancelled: previous.cancelled + tool.cancelled,
        interrupted: previous.interrupted + tool.interrupted, stopped: previous.stopped + tool.stopped })
    }
  }
  return {
    sessionId, partial,
    descendantCount: members.length - 1, direct, descendants: descendantTotals, totals,
    models: [...models].sort(([a], [b]) => a.localeCompare(b)).map(([model, summary]): UsageModelSummary => ({ model, ...summary })),
    tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
    generation: mergeGenerationStatistics(members.map((member) => memberView(member).generation)),
  }
}

/** Reads committed session facts only when queried. Historical usage without
 *  a model or exact attempt identity marks the result partial.
 *
 *  The stats surfaces poll every few seconds, and a chat can have hundreds of
 *  descendants, so a poll may not cost a read per descendant: holding one
 *  projection per descendant and family evicted and refolded every history on
 *  each poll once a subtree outgrew the registry. One held fold per queried
 *  session folds its whole subtree once, then reads only the facts committed
 *  after its position, in one query for every member, and loads no tool
 *  content. A session that joins the subtree folds its history once, through
 *  the same position. */
export function createSessionStatsReader(reader: AsyncEventReadSurface): (sessionId: string) => Promise<UsageSessionStats> {
  const subtree = (sessionId: string) => heldProjection(reader, `usage-stats-subtree:${sessionId}`, () => {
    let members = new Map<string, Member>()
    let order: readonly string[] = []
    let ancestry: SessionLineage | undefined
    let position = 0
    let published: Omit<UsageSessionStats, "asOf"> | undefined
    /** Folds the facts of `folding` in (after, upper] and reports the
     *  position of each fact it folded, so a failure keeps the facts before it. */
    async function fold(folding: ReadonlyMap<string, Member>, after: number, upper: number, folded: (through: number) => void): Promise<void> {
      const byAggregate = new Map([...folding].map(([id, member]) => [`session:${id}`, member]))
      let cursor = after
      while (cursor < upper) {
        const page = await reader.readPage({ aggregateIds: [...byAggregate.keys()], types: MEMBER_FACT_TYPES }, upper, cursor, false, "deferred")
        for (const fact of page.facts) {
          // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the narrowed durable-row Error and its identity
          if (fact instanceof CorruptEventRowError) throw fact
          // SAFETY: the query reads only these members' aggregates.
          foldMember(byAggregate.get(fact.aggregateId)!, fact)
          folded(fact.position)
        }
        if (page.continuationPosition === null) return
        cursor = page.continuationPosition
        await yieldToNextTask()
      }
    }
    async function advance(): Promise<void> {
      const upper = await reader.capturePosition()
      if (published && upper <= position) return
      const current = await heldSessionLineage(reader).replay()
      if (current !== ancestry) {
        const next = sessionSubtree(current, sessionId)
        // A joining session folds its history through the subtree's position,
        // and the read below folds every member after it.
        const kept = new Map(next.map((id) => [id, members.get(id) ?? emptyMember()]))
        const joining = new Map([...kept].filter(([id]) => !members.has(id)))
        if (joining.size > 0) await fold(joining, 0, position, () => {})
        members = kept
        order = next
        ancestry = current
        published = undefined
      }
      await fold(members, position, upper, (through) => {
        position = through
        published = undefined
      })
      position = upper
    }
    const lane = createOrderedLane()
    return {
      read: () => lane.run(async (): Promise<UsageSessionStats> => {
        await advance()
        // SAFETY: the subtree's members hold every id of its order.
        published ??= summarize(sessionId, order.map((id) => members.get(id)!))
        return { ...published, asOf: Date.now() }
      }),
    }
  })
  return (sessionId) => subtree(sessionId).read()
}
