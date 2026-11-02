import { describe, expect, it } from "bun:test"

import { createSessionFairAdmission } from "../../../src/infra/session-fair-admission.js"

function tracked(admission: ReturnType<typeof createSessionFairAdmission>, sessionId: string, signal?: AbortSignal) {
  const state = { admitted: false }
  const release = admission.acquire(sessionId, signal).then((granted) => { state.admitted = true; return granted })
  return { state, release }
}

describe("session-fair admission", () => {
  it("admits up to capacity and keeps the next request queued until a release", async () => {
    const admission = createSessionFairAdmission(2)
    const held = await Promise.all([admission.acquire("a"), admission.acquire("b")])
    const next = tracked(admission, "c")
    await Promise.resolve()
    expect(next.state.admitted).toBe(false)
    held[0]?.()
    const releaseNext = await next.release
    expect(next.state.admitted).toBe(true)
    held[1]?.()
    releaseNext()
  })

  it("admits queued A1, A2, B1 as A1, B1, A2 and keeps FIFO order within each session", async () => {
    const admission = createSessionFairAdmission(1)
    const releaseHeld = await admission.acquire("holding")
    const admitted: string[] = []
    const queue = (session: string, name: string) => admission.acquire(session).then((release) => { admitted.push(name); return release })
    const a1 = queue("a", "a1")
    const a2 = queue("a", "a2")
    const b1 = queue("b", "b1")
    const a3 = queue("a", "a3")
    const c1 = queue("c", "c1")
    releaseHeld()
    for (const next of [a1, b1, c1, a2, a3]) (await next)()
    expect(admitted).toEqual(["a1", "b1", "c1", "a2", "a3"])
  })

  it("leaves no waiter for a cancelled queued request and rejects a request that is already aborted", async () => {
    const admission = createSessionFairAdmission(1)
    const releaseHeld = await admission.acquire("holding")
    const first = new AbortController()
    const only = new AbortController()
    const cancelledFirst = admission.acquire("a", first.signal)
    const cancelledOnly = admission.acquire("b", only.signal)
    const a = admission.acquire("a")
    const c = admission.acquire("c")
    first.abort()
    only.abort()
    await expect(cancelledFirst).rejects.toMatchObject({ name: "AbortError" })
    await expect(cancelledOnly).rejects.toMatchObject({ name: "AbortError" })
    releaseHeld()
    // A leftover waiter would hold the only permit, so these never resolve.
    ;(await a)()
    ;(await c)()
    await expect(admission.acquire("pre-aborted", first.signal)).rejects.toMatchObject({ name: "AbortError" })
    ;(await admission.acquire("after"))()
  })

  it("takes a permit at once even at capacity, and a queued request waits until it is released", async () => {
    const admission = createSessionFairAdmission(1)
    const releaseHeld = await admission.acquire("holding")
    const releaseTaken = admission.take()
    const queued = tracked(admission, "queued")
    releaseHeld()
    await Promise.resolve()
    expect(queued.state.admitted).toBe(false)
    releaseTaken()
    ;(await queued.release)()
    expect(queued.state.admitted).toBe(true)
  })

  it("creates no capacity when a release runs twice", async () => {
    const admission = createSessionFairAdmission(1)
    const releaseFirst = await admission.acquire("first")
    const second = admission.acquire("second")
    const third = tracked(admission, "third")
    releaseFirst()
    const releaseSecond = await second
    releaseFirst()
    await Promise.resolve()
    expect(third.state.admitted).toBe(false)
    releaseSecond()
    ;(await third.release)()
  })

  it("keeps a separate allowance for each instance", async () => {
    const left = createSessionFairAdmission(1)
    const right = createSessionFairAdmission(1)
    const releaseLeft = await left.acquire("session")
    const queuedLeft = tracked(left, "session")
    const releaseRight = await right.acquire("session")
    const queuedRight = tracked(right, "session")
    releaseRight()
    ;(await queuedRight.release)()
    expect(queuedLeft.state.admitted).toBe(false)
    releaseLeft()
    ;(await queuedLeft.release)()
  })
})
