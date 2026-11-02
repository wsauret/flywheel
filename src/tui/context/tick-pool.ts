import type { Accessor } from "solid-js"
import { createSignal, onCleanup } from "solid-js"
import { probe } from "../../infra/render-probe.js"

interface TickEntry {
  readonly tick: Accessor<number>
  timer: ReturnType<typeof setInterval>
  listeners: number
}

export function createTickPool() {
  const pools = new Map<number, TickEntry>()

  function subscribe(intervalMs: number): Accessor<number> {
    let entry = pools.get(intervalMs)
    if (!entry) {
      const [tick, setTick] = createSignal(0)
      entry = {
        tick,
        timer: setInterval(() => {
          probe(`tick.${intervalMs}`)
          setTick((n) => n + 1)
        }, intervalMs),
        listeners: 0,
      }
      pools.set(intervalMs, entry)
    }
    entry.listeners++
    const capturedEntry = entry

    onCleanup(() => {
      if (!pools.has(intervalMs)) return
      capturedEntry.listeners--
      if (capturedEntry.listeners === 0) {
        clearInterval(capturedEntry.timer)
        pools.delete(intervalMs)
      }
    })

    return capturedEntry.tick
  }

  function disposeAll(): void {
    for (const entry of pools.values()) clearInterval(entry.timer)
    pools.clear()
  }

  function createSharedTick(intervalMs: number, isActive: Accessor<boolean>): Accessor<number> {
    const tick = subscribe(intervalMs)
    return () => isActive() ? tick() : 0
  }

  onCleanup(disposeAll)

  return { createSharedTick }
}
