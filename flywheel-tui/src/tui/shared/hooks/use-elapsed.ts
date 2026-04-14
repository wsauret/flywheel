import { createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"

export function useElapsed(startMs: () => number | undefined): Accessor<number> {
  const [elapsed, setElapsed] = createSignal(0)

  const id = setInterval(() => {
    const start = startMs()
    if (start) setElapsed(Date.now() - start)
  }, 1000)
  onCleanup(() => clearInterval(id))

  return elapsed
}
