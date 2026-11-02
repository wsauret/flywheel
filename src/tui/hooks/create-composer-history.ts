import type { Accessor } from "solid-js"
import { createSignal } from "solid-js"
import type { DebouncedWriter } from "../../infra/debounced-writer.js"
import { createDebouncedWriter } from "../../infra/debounced-writer.js"

const MAX_ENTRIES = 500

type PersistOp =
  | { kind: "append"; entries: readonly string[] }
  | { kind: "rewrite"; entries: readonly string[] }

interface PromptHistoryOpts {
  /** O(1) common case: entries added since the last successful persist. */
  append: (lines: readonly string[]) => Promise<void>
  /** Only reached when the 500-entry cap trims the head; appends remain the
   *  common persistence path until the cap forces a rewrite. */
  rewrite: (entries: readonly string[]) => Promise<void>
  debounceMs?: number
}

export interface PromptHistoryHook {
  /** All entries oldest-first; a reactive immutable snapshot. */
  entries: Accessor<readonly string[]>
  add(prompt: string): void
  flush(): Promise<void>
  dispose(): void
}

export function createPromptHistory(initialEntries: readonly string[], opts: PromptHistoryOpts): PromptHistoryHook {
  const [entries, setEntries] = createSignal<readonly string[]>([...initialEntries])
  // Entries at index < persistedCount are already durable on disk (loaded at
  // startup, or written by a prior flush); only advances after a write
  // actually succeeds, so a still-pending schedule naturally grows to cover
  // everything not yet persisted instead of racing itself.
  let persistedCount = initialEntries.length

  const writer: DebouncedWriter<PersistOp> = createDebouncedWriter(
    async (op) => {
      if (op.kind === "append") {
        const lines = op.entries.slice(persistedCount)
        if (lines.length > 0) await opts.append(lines)
      } else await opts.rewrite(op.entries)
      persistedCount = op.entries.length
    },
    { intervalMs: opts.debounceMs ?? 5_000 },
  )

  function add(prompt: string): void {
    const trimmed = prompt.trim()
    if (!trimmed) return
    const prev = entries()
    if (prev.at(-1) === trimmed) return
    const grown = [...prev, trimmed]
    if (grown.length > MAX_ENTRIES) {
      const capped = grown.slice(grown.length - MAX_ENTRIES)
      setEntries(capped)
      persistedCount = Math.min(persistedCount, capped.length)
      writer.schedule({ kind: "rewrite", entries: capped })
    } else {
      setEntries(grown)
      writer.schedule({ kind: "append", entries: grown })
    }
  }

  return {
    entries,
    add,
    flush: () => writer.flush(),
    dispose: () => writer.dispose(),
  }
}
