import type { Accessor } from "solid-js"
import { createMemo } from "solid-js"
import { useTickPool } from "../context/tick-pool-context.js"

export function useElapsed(startMs: () => number | undefined): Accessor<number> {
  const tick = useTickPool().createSharedTick(1000, () => startMs() !== undefined)
  const elapsed = createMemo(() => {
    tick()
    const start = startMs()
    return start === undefined ? 0 : Date.now() - start
  })
  return elapsed
}
