import { createEventProjection } from "../../../../infra/event-projection.js"
import type { AsyncEventReadSurface, CorruptEventRowError, StoredFact } from "../../../../infra/event-store-types.js"
import { InvariantViolation } from "../../../../infra/invariant.js"
import { emptyPrefixView, prefixAppend, prefixGet, type PrefixView } from "../../../../infra/prefix-view.js"
import { heldProjection, pinHeldProjection } from "../../../../infra/projection-registry.js"
import { fromCorruptRow, type CorruptRowSchema } from "../../../app-service/project-state-errors.js"
import { BUDGET_FACT_TYPES, initialBudgetProjectionState, reduceBudgetEvent, type BudgetProjectionState } from "../../../session/budget-projection.js"
import { countToolCall, initialToolCallCount, TOOL_EXECUTION_FACT_TYPES, type ToolCallCount } from "../../../session/tool-execution-projection.js"

/** What a child session's history measures before one point: the calls that
 *  no other call dispatched, and the tokens that its usage facts record. A
 *  figure is absent when the history holds no fact for it. A tool count is
 *  `unreadable` when a tool fact before that point cannot be read. */
export interface ChildMeasure {
  readonly toolCount?: number | "unreadable"
  readonly tokens?: number
}

export interface ChildMeasureReader {
  /** The measure of `childSessionId` before the fact `completionEventId`, or
   *  through its newest committed fact when its history holds no such fact.
   *  Reads of different children catch up concurrently. Rejects with the
   *  row's error when the child's history holds a row this build cannot decode. */
  read(childSessionId: string, completionEventId: string | undefined): Promise<ChildMeasure>
  /** Lets the registry drop the folds this reader measured. Idempotent. A
   *  read after it measures without holding the fold. */
  dispose(): void
}

/** One child's measured history, folded. Plain (objects, arrays, Maps, and
 *  primitives only), so a persisted fold can hold it. A draft is a shallow
 *  copy, and its prefix views keep each published state's figures while the
 *  fold folds on. */
interface ChildFold {
  budget: BudgetProjectionState
  usage: boolean
  toolFacts: boolean
  toolFailure: boolean
  tools: ToolCallCount
  /** The measure before each completion fact, by the completion's event id. */
  completions: PrefixView<ChildMeasure>
  /** The first row this build cannot decode. The fold stops there. */
  corrupt?: typeof CorruptRowSchema.Type
}

/** The fold of one child's measured facts, for a projection of the child's
 *  session aggregate. */
export const CHILD_MEASURE_FOLD = {
  factTypes: [...BUDGET_FACT_TYPES, ...TOOL_EXECUTION_FACT_TYPES, "subagent.completed"],
  initialState(): ChildFold {
    return {
      budget: initialBudgetProjectionState(), usage: false, toolFacts: false, toolFailure: false,
      tools: initialToolCallCount({ identityParity: true }), completions: emptyPrefixView(),
    }
  },
  draft: (fold: ChildFold): ChildFold => ({ ...fold, tools: { ...fold.tools } }),
  reduce: foldFact,
  reduceCorruptRow(fold: ChildFold, corrupt: CorruptEventRowError): ChildFold {
    fold.corrupt ??= { row: corrupt.row, message: corrupt.message }
    return fold
  },
}

const BUDGET_FACT_TYPE_NAMES: readonly string[] = BUDGET_FACT_TYPES

/** The measures of the child sessions a parent's cards ask about. Each child
 *  is one held fold of its own measured facts: the first ask reads its history
 *  once, and each later ask, from this reader or any other over the same
 *  store, reads only the facts that child committed since. A change costs what
 *  it committed whatever the child count or history length.
 *
 *  The reader pins each child it measures until it is disposed, so a parent
 *  with more children than the registry holds per family never has its first
 *  children's folds dropped and rebuilt from their start. A released fold
 *  stays held until the family's bound drops it: the next reader of the same
 *  parent, such as its reopened transcript, then advances it rather than
 *  folding it again. */
export function createChildMeasureReader(reader: AsyncEventReadSurface): ChildMeasureReader {
  const releases = new Map<string, () => void>()
  let disposed = false
  return {
    async read(childSessionId, completionEventId) {
      const key = `subagent-measure:${childSessionId}`
      if (!disposed && !releases.has(key)) releases.set(key, pinHeldProjection(reader, key))
      const projection = heldProjection(reader, key, () => createEventProjection(reader, { name: key, aggregateId: `session:${childSessionId}`, ...CHILD_MEASURE_FOLD }))
      return measureBefore(await projection.replay(), completionEventId)
    },
    dispose() {
      disposed = true
      for (const release of releases.values()) release()
      releases.clear()
    },
  }
}

/** The measure that `fold` states before the completion `completionEventId`,
 *  or through its last folded fact when it holds no such completion. Throws
 *  the row's error when the fold stopped at a row this build cannot decode. */
export function measureBefore(fold: ChildFold, completionEventId: string | undefined): ChildMeasure {
  if (fold.corrupt) throw fromCorruptRow(fold.corrupt)
  return (completionEventId === undefined ? undefined : prefixGet(fold.completions, completionEventId)) ?? measureOf(fold)
}

function foldFact(fold: ChildFold, fact: StoredFact): ChildFold {
  if (fold.corrupt) return fold
  if (fact.type === "subagent.completed") {
    fold.completions = prefixAppend(fold.completions, fact.id, measureOf(fold))
    return fold
  }
  if (BUDGET_FACT_TYPE_NAMES.includes(fact.type)) {
    fold.budget = reduceBudgetEvent(fold.budget, fact)
    fold.usage = true
    return fold
  }
  fold.toolFacts = true
  if (fold.toolFailure) return fold
  try {
    countToolCall(fold.tools, fact)
  } catch (error) {
    if (!(error instanceof InvariantViolation)) throw error
    fold.toolFailure = true
  }
  return fold
}

function measureOf(fold: ChildFold): ChildMeasure {
  const toolCount = !fold.toolFacts ? undefined : fold.toolFailure ? "unreadable" : fold.tools.topLevel
  return {
    ...(toolCount !== undefined ? { toolCount } : {}),
    ...(fold.usage ? { tokens: fold.budget.totalInputTokens + fold.budget.totalOutputTokens } : {}),
  }
}
