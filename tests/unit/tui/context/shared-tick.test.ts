import { describe, it, expect, afterEach } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createTickPool } from "../../../../src/tui/context/tick-pool.js"

describe("tick pool", () => {
  let dispose: (() => void) | undefined

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  // Poll for the tick to arrive instead of asserting a count after a fixed
  // sleep: a loaded runner delivers 5ms timers late, so wall-clock counts
  // flake. The deadline only binds when the interval is broken.
  const waitForTick = async (tick: () => number, target: number): Promise<void> => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (tick() >= target) return
      await Bun.sleep(5)
    }
  }

  it("consumers at the same interval share one tick source", async () => {
    const [first, second] = createRoot((d) => {
      dispose = d
      const pool = createTickPool()
      return [pool.createSharedTick(5, () => true), pool.createSharedTick(5, () => true)]
    })
    await waitForTick(first, 1)
    expect(first()).toBe(second())
    expect(first()).toBeGreaterThanOrEqual(1)
  })

  it("disposing the last listener stops the shared interval", async () => {
    await new Promise<void>((resolve) => {
      createRoot((d) => {
        dispose = d
        const pool = createTickPool()

        let tick!: () => number
        let innerDispose: (() => void) | undefined
        createRoot((d2) => {
          innerDispose = d2
          tick = pool.createSharedTick(5, () => true)
        })

        innerDispose!()
        const frozen = tick()
        setTimeout(() => {
          expect(tick()).toBe(frozen)
          resolve()
        }, 15)
      })
    })
  })

  it("setting isActive to false returns 0", async () => {
    const result = await new Promise<number>((resolve) => {
      createRoot((d) => {
        dispose = d
        const pool = createTickPool()
        const [active, setActive] = createSignal(true)
        const tick = pool.createSharedTick(5, active)

        setTimeout(() => {
          setActive(false)
          resolve(tick())
        }, 15)
      })
    })
    expect(result).toBe(0)
  })

  it("disposing the owning root stops all remaining intervals", async () => {
    let tick!: () => number
    createRoot((d) => {
      const pool = createTickPool()
      tick = pool.createSharedTick(5, () => true)
      pool.createSharedTick(10, () => true)
      d()
    })
    const frozen = tick()
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(tick()).toBe(frozen)
  })
})
