import { describe, expect, test } from "bun:test"
import { createProfileRefreshCoordinator } from "../../../../src/orchestration/app-service/profile-refresh-coordinator.js"

function deferred(): PromiseWithResolvers<void> {
  return Promise.withResolvers<void>()
}

describe("profile refresh coordinator", () => {
  test("an explicit refresh follows an observation and remains in the barrier", async () => {
    const observation = deferred()
    const discovery = deferred()
    const enteredDiscovery = deferred()
    const calls: string[] = []
    const coordinator = createProfileRefreshCoordinator(async (_profileId, _signal, mode) => {
      calls.push(mode)
      if (mode === "observe") await observation.promise
      else { enteredDiscovery.resolve(); await discovery.promise }
    })
    const first = coordinator.refresh("work", undefined, "observe")
    const explicit = coordinator.refresh("work")
    const barrier = coordinator.barrier()
    let settled = false
    void barrier.then(() => { settled = true })
    expect(calls).toEqual(["observe"])
    observation.resolve()
    await first
    await enteredDiscovery.promise
    expect(settled).toBe(false)
    expect(calls).toEqual(["observe", "refresh"])
    discovery.resolve()
    await Promise.all([explicit, barrier])
    await coordinator.dispose()
  })

  test("foreground refresh work joins by profile and participates in the barrier", async () => {
    const work = deferred()
    const calls: string[] = []
    const coordinator = createProfileRefreshCoordinator(async (profileId) => {
      calls.push(profileId ?? "defaults")
      await work.promise
    })

    const originalBarrier = coordinator.barrier()
    const foreground = coordinator.refresh("work")
    const joined = coordinator.refresh("work")
    const joinedBarrier = coordinator.barrier()
    expect(joinedBarrier).not.toBe(originalBarrier)
    expect(joined).toBe(foreground)
    expect(calls).toEqual(["work"])

    work.resolve()
    await Promise.all([foreground, joined, joinedBarrier])
    await coordinator.dispose()
  })

  test("caller cancellation does not cancel joined refresh work or release its barrier", async () => {
    const work = deferred()
    const calls: string[] = []
    let ownerSignal: AbortSignal | undefined
    const coordinator = createProfileRefreshCoordinator(async (profileId, signal) => {
      calls.push(profileId ?? "defaults")
      ownerSignal = signal
      await work.promise
    })
    const settlementAbort = new AbortController()

    const settlement = coordinator.refresh("work", settlementAbort.signal)
    const settlementBarrier = coordinator.barrier()
    const watcher = coordinator.refresh("work")
    const barrier = coordinator.barrier()
    let barrierSettled = false
    void barrier.then(() => { barrierSettled = true })
    settlementAbort.abort(new DOMException("Modal closed", "AbortError"))

    await expect(settlement).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toEqual(["work"])
    expect(ownerSignal?.aborted).toBe(false)
    expect(barrier).not.toBe(settlementBarrier)
    expect(barrierSettled).toBe(false)
    work.resolve()
    await watcher
    await barrier
    expect(barrierSettled).toBe(true)
    await coordinator.dispose()
  })

  test("joins the same profile while distinct profiles refresh independently", async () => {
    const work = deferred()
    const personal = deferred()
    const calls: string[] = []
    const coordinator = createProfileRefreshCoordinator(async (profileId) => {
      calls.push(profileId ?? "defaults")
      await (profileId === "work" ? work.promise : personal.promise)
    })

    const firstWork = coordinator.refresh("work")
    const secondWork = coordinator.refresh("work")
    const personalRefresh = coordinator.refresh("personal")

    expect(secondWork).toBe(firstWork)
    expect(calls).toEqual(["work", "personal"])
    personal.resolve()
    await personalRefresh
    expect(await Promise.race([firstWork.then(() => "settled"), Promise.resolve("pending")])).toBe("pending")
    work.resolve()
    await firstWork
    await coordinator.dispose()
  })

  test("cleans up failed refreshes so the profile can retry", async () => {
    let attempts = 0
    const coordinator = createProfileRefreshCoordinator(async () => {
      attempts += 1
      if (attempts === 1) throw new Error("refresh failed")
    })

    await expect(coordinator.refresh("work")).rejects.toThrow("refresh failed")
    await coordinator.refresh("work")

    expect(attempts).toBe(2)
    await coordinator.dispose()
  })

  test("aborts owned refreshes and awaits their settlement during disposal", async () => {
    const settled = deferred()
    let signal: AbortSignal | undefined
    const coordinator = createProfileRefreshCoordinator(async (_profileId, ownerSignal) => {
      signal = ownerSignal
      await new Promise<void>((resolve) => ownerSignal.addEventListener("abort", () => resolve(), { once: true }))
      await settled.promise
      ownerSignal.throwIfAborted()
    })
    const refresh = coordinator.refresh("work")

    let disposed = false
    const disposal = coordinator.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(signal?.aborted).toBe(true)
    expect(disposed).toBe(false)
    settled.resolve()
    await expect(refresh).rejects.toMatchObject({ name: "AbortError" })
    await disposal
    await expect(coordinator.refresh("work")).rejects.toThrow("profile refresh coordinator is disposed")
  })
})
