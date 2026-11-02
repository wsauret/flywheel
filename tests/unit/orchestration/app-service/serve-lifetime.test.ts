import { describe, expect, test } from "bun:test"

import { ServeLifetime } from "../../../../src/orchestration/app-service/serve-lifetime.js"

/** A manual clock: timers fire in order as time advances, as a fake timer would. */
function manualClock() {
  let now = 0
  let nextId = 0
  const timers = new Map<number, { readonly at: number; readonly fire: () => void }>()
  return {
    setTimer: (fire: () => void, ms: number): (() => void) => {
      const id = nextId++
      timers.set(id, { at: now + ms, fire })
      return () => { timers.delete(id) }
    },
    advance(ms: number): void {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fire()
      }
      now = until
    },
  }
}

describe("serve lifetime", () => {
  test("holds a resident serve until explicit shutdown", () => {
    const clock = manualClock()
    let retired = 0
    const lifetime = new ServeLifetime({ resident: true, setTimer: clock.setTimer })
    lifetime.start(() => { retired += 1 })
    clock.advance(60_000)
    expect(retired).toBe(0)
    lifetime.stop()
  })

  test("holds a serve whose residency is still being decided", async () => {
    const clock = manualClock()
    let retired = 0
    const decided = Promise.withResolvers<boolean>()
    const lifetime = new ServeLifetime({ resident: decided.promise, setTimer: clock.setTimer })
    lifetime.start(() => { retired += 1 })
    clock.advance(60_000)
    expect(retired).toBe(0)
    decided.resolve(true)
    await decided.promise
    clock.advance(60_000)
    expect(retired).toBe(0)
    lifetime.stop()
  })

  test("a serve decided not resident retires once unheld, after its startup grace", async () => {
    const clock = manualClock()
    let retired = 0
    const decided = Promise.withResolvers<boolean>()
    const lifetime = new ServeLifetime({ resident: decided.promise, setTimer: clock.setTimer })
    lifetime.start(() => { retired += 1 })
    clock.advance(20_000)
    expect(retired).toBe(0)
    decided.resolve(false)
    await decided.promise
    clock.advance(999)
    expect(retired).toBe(0)
    clock.advance(1)
    expect(retired).toBe(1)
    lifetime.stop()
  })

  test("a resident serve whose residency ends retires after the idle grace once unheld, one made resident again during that grace stays, and each call answers whether the residency changed", () => {
    const clock = manualClock()
    let retired = 0
    const lifetime = new ServeLifetime({ resident: true, setTimer: clock.setTimer })
    lifetime.start(() => { retired += 1 })
    expect(lifetime.setResident(false)).toBe(true)
    clock.advance(500)
    // The same residency again changes nothing and keeps the grace running.
    expect(lifetime.setResident(false)).toBe(false)
    expect(lifetime.setResident(true)).toBe(true)
    clock.advance(60_000)
    expect(retired).toBe(0)

    expect(lifetime.setResident(false)).toBe(true)
    clock.advance(999)
    expect(retired).toBe(0)
    clock.advance(1)
    expect(retired).toBe(1)
    lifetime.stop()
  })

  test("retires a dev serve if no first client arrives", () => {
    const clock = manualClock()
    let retired = 0
    const lifetime = new ServeLifetime({ resident: false, setTimer: clock.setTimer })
    lifetime.start(() => { retired += 1 })
    clock.advance(10_999)
    expect(retired).toBe(0)
    clock.advance(1)
    expect(retired).toBe(1)
    lifetime.stop()
  })

  test("requires both client and project demand to disappear", () => {
    const clock = manualClock()
    let retired = 0
    const lifetime = new ServeLifetime({ resident: false, setTimer: clock.setTimer })
    lifetime.start(() => { retired += 1 })
    lifetime.setConnectionCount(1)
    lifetime.setProjectCount(1)
    lifetime.setConnectionCount(0)
    clock.advance(10_000)
    expect(retired).toBe(0)

    lifetime.setProjectCount(0)
    clock.advance(999)
    expect(retired).toBe(0)
    clock.advance(1)
    expect(retired).toBe(1)
    lifetime.stop()
  })

  test("a hold that returns during the idle grace cancels the retirement", () => {
    const clock = manualClock()
    let retired = 0
    const lifetime = new ServeLifetime({ resident: false, setTimer: clock.setTimer })
    lifetime.start(() => { retired += 1 })
    lifetime.setConnectionCount(1)
    lifetime.setConnectionCount(0)
    clock.advance(500)
    lifetime.setConnectionCount(1)
    clock.advance(5_000)
    expect(retired).toBe(0)
    lifetime.stop()
  })
})
