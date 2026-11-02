import { afterEach, describe, expect, spyOn, test } from "bun:test"

import type { CapacityWake, CapacityWakeStore } from "../../../../src/orchestration/app-service/account-project-registry.js"
import { createCapacityWakes } from "../../../../src/orchestration/app-service/capacity-wakes.js"
import { DebugLog } from "../../../../src/infra/debug-log.js"

const NOW = Date.parse("2026-10-28T02:00:00.000Z")
/** A wake that continued every due wait and left none for later. */
const DONE = { owed: false, next: null } as const

/** A wall clock that a test moves by hand: a sleep resolves once the clock
 *  passes its end, or at once when its signal aborts. */
function manualClock() {
  let now = NOW
  const sleepers = new Set<{ readonly until: number; readonly resolve: () => void }>()
  const wakeDue = () => { for (const sleeper of sleepers) if (sleeper.until <= now) { sleepers.delete(sleeper); sleeper.resolve() } }
  return {
    now: () => now,
    sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
      const sleeper = { until: now + ms, resolve }
      sleepers.add(sleeper)
      signal.addEventListener("abort", () => { sleepers.delete(sleeper); resolve() }, { once: true })
    }),
    advance: async (ms: number) => {
      now += ms
      wakeDue()
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    },
  }
}

let recordSpy: ReturnType<typeof spyOn> | undefined
afterEach(() => { recordSpy?.mockRestore(); recordSpy = undefined })
/** Counts the "fired" records of capacity waits. */
function captureFired(): () => number {
  let count = 0
  recordSpy = spyOn(DebugLog, "record").mockImplementation((entry) => { if (entry.type === "agent.capacity_wait" && Object.entries(entry.payload ?? {}).some(([key, value]) => key === "event" && value === "fired")) count += 1 })
  return () => count
}

function memoryStore(initial: readonly CapacityWake[] = []): CapacityWakeStore & { readonly rows: Map<string, number> } {
  const rows = new Map(initial.map(({ projectRoot, at }) => [projectRoot, at]))
  return {
    rows,
    capacityWakes: () => [...rows].map(([projectRoot, at]) => ({ projectRoot, at })),
    recordCapacityWake: async (_lane, projectRoot, at) => { if (at === null) rows.delete(projectRoot); else rows.set(projectRoot, at) },
  }
}

describe("the account's capacity wakes", () => {
  test("wake a project an earlier service left at once when it is due, and the others at their time", async () => {
    const clock = manualClock()
    const woken: string[] = []
    const wakes = createCapacityWakes({ lane: "installed", store: memoryStore([{ projectRoot: "/overdue", at: NOW - 1 }, { projectRoot: "/later", at: NOW + 60_000 }]), wake: async (root) => { woken.push(root); return DONE }, clock })
    wakes.start()
    await clock.advance(0)
    expect(woken).toEqual(["/overdue"])
    await clock.advance(60_000)
    expect(woken).toEqual(["/overdue", "/later"])
    wakes.dispose()
  })

  test("hold each reported time in the store before the report resolves, refuse a time the store refused, retire a project that reports none, and wake again at once after the executor that held the waits ended", async () => {
    const clock = manualClock()
    const store = memoryStore()
    const woken: string[] = []
    const wakes = createCapacityWakes({ lane: "installed", store, wake: async (root) => { woken.push(root); return DONE }, clock })
    await wakes.report("/project", NOW + 60_000)
    expect([...store.rows]).toEqual([["/project", NOW + 60_000]])
    await wakes.report("/gone", NOW + 60_000)
    await wakes.report("/gone", null)
    expect([...store.rows]).toEqual([["/project", NOW + 60_000]])
    const refusing = createCapacityWakes({ lane: "installed", clock, wake: async (root) => { woken.push(root); return DONE }, store: { ...store, recordCapacityWake: async () => { throw new Error("the account store is full") } } })
    await expect(refusing.report("/refused", NOW)).rejects.toThrow("the account store is full")
    await clock.advance(60_000)
    expect(woken).toEqual(["/project"])
    wakes.rearm("/project")
    await clock.advance(0)
    expect(woken).toEqual(["/project", "/project"])
    wakes.dispose()
    refusing.dispose()
  })

  test("wake the project again at the time of a wait the last wake left for later, and keep the earliest owed time in the store", async () => {
    const clock = manualClock()
    const store = memoryStore([{ projectRoot: "/project", at: NOW }])
    const woken: number[] = []
    const wakes = createCapacityWakes({
      lane: "installed", store, clock,
      wake: async () => {
        woken.push(clock.now())
        return { owed: false, next: woken.length === 1 ? NOW + 60_000 : null }
      },
    })
    wakes.start()
    await clock.advance(0)
    expect(woken).toEqual([NOW])
    await clock.advance(59_999)
    expect(woken).toEqual([NOW])
    await clock.advance(1)
    expect(woken).toEqual([NOW, NOW + 60_000])
    expect([...store.rows]).toEqual([["/project", NOW]])
    wakes.dispose()
  })

  test("try a wake again on the backoff while it fails or leaves a wait owed, and record it fired once", async () => {
    const clock = manualClock()
    const fired = captureFired()
    let attempts = 0
    const wakes = createCapacityWakes({
      lane: "installed", store: memoryStore([{ projectRoot: "/project", at: NOW }]), clock, retryDelayMs: () => 1_000,
      wake: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("the project could not open")
        return { owed: attempts <= 2, next: null }
      },
    })
    wakes.start()
    await clock.advance(0)
    expect(attempts).toBe(1)
    await clock.advance(1_000)
    expect(attempts).toBe(2)
    await clock.advance(1_000)
    expect(attempts).toBe(3)
    await clock.advance(1_000)
    expect(attempts).toBe(3)
    expect(fired()).toBe(1)
    wakes.dispose()
  })
})
