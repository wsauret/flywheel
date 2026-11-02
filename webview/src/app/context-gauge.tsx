import { createEffect, createSignal, onCleanup, Show, type Accessor } from "solid-js"

import { contextGaugeCopy } from "../../../src/protocol/client/context-compaction.js"
import type { BudgetSummary } from "../../../src/protocol/client/host-contract.js"

/** Context usage toward the existing compaction ceiling. Choosing the reading
 * opens its explanation before offering compaction. */
export function ContextGauge(props: {
  readonly budget: Accessor<BudgetSummary>
  readonly compact: () => void
  readonly compacting: boolean
}) {
  const copy = () => {
    const budget = props.budget()
    return budget.totalsLoading ? undefined : contextGaugeCopy(budget)
  }
  const [explaining, setExplaining] = createSignal(false)
  let gauge: HTMLSpanElement | undefined
  createEffect(() => {
    if (!explaining()) return
    const outside = (event: PointerEvent) => { if (!(event.target instanceof Node && gauge?.contains(event.target))) setExplaining(false) }
    document.addEventListener("pointerdown", outside)
    onCleanup(() => document.removeEventListener("pointerdown", outside))
  })
  const compact = () => { setExplaining(false); props.compact() }
  const ring = 2 * Math.PI * 6
  return (
    <span class="context-gauge" ref={(el) => (gauge = el)}>
      <button
        class="context-ring"
        classList={{ warn: (copy()?.used ?? 0) >= 0.5 && (copy()?.used ?? 0) < 0.75, hot: (copy()?.used ?? 0) >= 0.75 }}
        title={explaining() ? undefined : `${copy()?.reading ?? "Context totals loading"}\nClick for context details.`}
        aria-label={copy() === undefined ? "Context totals loading" : `Context usage ${Math.round(copy()!.used * 100)}%. ${copy()!.reading}`}
        aria-expanded={explaining() ? "true" : undefined}
        aria-busy={props.compacting || undefined}
        onClick={() => setExplaining((open) => !open)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle class="ring-track" cx="8" cy="8" r="6" />
          <circle class="ring-fill" cx="8" cy="8" r="6" transform="rotate(-90 8 8)" stroke-dasharray={`${((copy()?.used ?? 0) * ring).toFixed(2)} ${ring.toFixed(2)}`} />
        </svg>
        <span>{copy() === undefined ? "…" : `${Math.round(copy()!.used * 100)}%`}</span>
      </button>
      <Show when={explaining() && copy() !== undefined}>
        <div class="context-popover" role="dialog" aria-label="Context">
          <span class="context-popover-reading">{copy()?.reading}</span>
          <span class="context-popover-detail">{copy()?.detail}</span>
          <button class="primary" onClick={compact}>Compact now</button>
        </div>
      </Show>
    </span>
  )
}
