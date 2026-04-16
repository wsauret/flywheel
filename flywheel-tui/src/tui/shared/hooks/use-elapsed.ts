import { createSignal, createEffect, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"

export function useElapsed(startMs: () => number | undefined): Accessor<number> {
  const [elapsed, setElapsed] = createSignal(0)

  let intervalId: ReturnType<typeof setInterval> | null = null

  createEffect(() => {
    const start = startMs()
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
    if (start !== undefined) {
      setElapsed(Date.now() - start)
      intervalId = setInterval(() => setElapsed(Date.now() - start), 1000)
    }
  })

  onCleanup(() => {
    if (intervalId) clearInterval(intervalId)
  })

  return elapsed
}
