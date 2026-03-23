import { describe, it, expect } from "bun:test"
import { PrioritySemaphore } from "../src/utils/semaphore"

describe("PrioritySemaphore", () => {
  it("allows up to maxConcurrent acquires immediately", async () => {
    const sem = new PrioritySemaphore(3)

    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    const r3 = await sem.acquire()

    expect(sem.activeCount).toBe(3)
    expect(sem.waitingCount).toBe(0)
    expect(typeof r1).toBe("function")
    expect(typeof r2).toBe("function")
    expect(typeof r3).toBe("function")

    r1(); r2(); r3()
  })

  it("queues the next waiter when at max concurrent", async () => {
    const sem = new PrioritySemaphore(2)

    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    expect(sem.activeCount).toBe(2)

    // This should queue
    let resolved = false
    const p3 = sem.acquire().then((release) => {
      resolved = true
      return release
    })

    // Give microtasks a chance to run
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(sem.waitingCount).toBe(1)

    // Release one slot — queued waiter should get in
    r1()
    const r3 = await p3
    expect(resolved).toBe(true)
    expect(sem.activeCount).toBe(2)

    r2(); r3()
  })

  it("drains priority 0 before priority 1", async () => {
    const sem = new PrioritySemaphore(1)

    // Fill the single slot
    const r1 = await sem.acquire()
    expect(sem.activeCount).toBe(1)

    // Queue two waiters: priority 1 first, then priority 0
    const order: number[] = []

    const p1 = sem.acquire(1).then((release) => {
      order.push(1)
      return release
    })
    const p0 = sem.acquire(0).then((release) => {
      order.push(0)
      return release
    })

    expect(sem.waitingCount).toBe(2)

    // Release the slot — priority 0 should drain first
    r1()

    const r0 = await p0
    expect(order).toEqual([0])

    // Release priority 0's slot — priority 1 should drain next
    r0()
    const r1b = await p1
    expect(order).toEqual([0, 1])

    r1b()
  })

  it("drains multiple priority 0 before any priority 1", async () => {
    const sem = new PrioritySemaphore(1)
    const r = await sem.acquire()

    const order: string[] = []

    const pBg1 = sem.acquire(1).then((release) => { order.push("bg1"); release() })
    const pFg1 = sem.acquire(0).then((release) => { order.push("fg1"); release() })
    const pFg2 = sem.acquire(0).then((release) => { order.push("fg2"); release() })
    const pBg2 = sem.acquire(1).then((release) => { order.push("bg2"); release() })

    expect(sem.waitingCount).toBe(4)

    // Release — should drain fg1, fg2, bg1, bg2 in order
    r()
    await Promise.all([pBg1, pFg1, pFg2, pBg2])

    expect(order).toEqual(["fg1", "fg2", "bg1", "bg2"])
  })

  it("reset() rejects all pending waiters", async () => {
    const sem = new PrioritySemaphore(1)
    await sem.acquire()

    const errors: Error[] = []

    const p1 = sem.acquire().catch((err) => { errors.push(err); return null })
    const p2 = sem.acquire().catch((err) => { errors.push(err); return null })

    expect(sem.waitingCount).toBe(2)

    sem.reset()

    await Promise.all([p1, p2])
    expect(errors).toHaveLength(2)
    expect(errors[0]!.message).toBe("Semaphore reset")
    expect(errors[1]!.message).toBe("Semaphore reset")
    expect(sem.waitingCount).toBe(0)
    expect(sem.activeCount).toBe(0)
  })

  it("release function decrements and drains queue", async () => {
    const sem = new PrioritySemaphore(2)

    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    expect(sem.activeCount).toBe(2)

    let resolved = false
    const p3 = sem.acquire().then((release) => {
      resolved = true
      return release
    })

    await Promise.resolve()
    expect(resolved).toBe(false)

    // Release one — should drain p3
    r1()
    const r3 = await p3
    expect(resolved).toBe(true)
    expect(sem.activeCount).toBe(2) // r2 + r3

    r2(); r3()
    expect(sem.activeCount).toBe(0)
  })

  it("release is idempotent — calling twice does not double-decrement", async () => {
    const sem = new PrioritySemaphore(1)
    const release = await sem.acquire()
    expect(sem.activeCount).toBe(1)

    release()
    expect(sem.activeCount).toBe(0)

    release() // second call should be no-op
    expect(sem.activeCount).toBe(0)
  })

  it("defaults to maxConcurrent of 3", async () => {
    const sem = new PrioritySemaphore()

    const r1 = await sem.acquire()
    const r2 = await sem.acquire()
    const r3 = await sem.acquire()
    expect(sem.activeCount).toBe(3)

    let queued = false
    sem.acquire().then(() => { queued = true })
    await Promise.resolve()
    expect(queued).toBe(false)
    expect(sem.waitingCount).toBe(1)

    r1(); r2(); r3()
  })
})
