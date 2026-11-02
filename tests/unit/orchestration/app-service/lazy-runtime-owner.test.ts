import { describe, expect, it } from "bun:test"
import { createLazyRuntimeOwner } from "../../../../src/orchestration/app-service/lazy-runtime-owner.js"
import { createRuntimeOwnership } from "../../../../src/orchestration/app-service/runtime-ownership.js"
import { runRuntimeShutdownBarrier } from "../../../../src/orchestration/app-service/runtime-shutdown.js"

describe("lazy runtime owner", () => {
  it("shares one demand-started initialization", async () => {
    const outer = createRuntimeOwnership(() => {})
    outer.reserve("resource")
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let attempts = 0
    const lazy = createLazyRuntimeOwner(outer, async (_signal, child) => {
      attempts++
      started.resolve()
      await finish.promise
      child.own("resource", {}, () => {})
      return { ready: true }
    }, () => {})

    const first = lazy.get()
    const second = lazy.get()
    await started.promise
    expect(attempts).toBe(1)
    finish.resolve()
    expect(await first).toBe(await second)
  })

  it("rolls a failed attempt back in reverse order and retries", async () => {
    const outer = createRuntimeOwnership(() => {})
    outer.reserve("first")
    outer.reserve("second")
    const calls: string[] = []
    let attempts = 0
    const lazy = createLazyRuntimeOwner(outer, async (_signal, child) => {
      attempts++
      child.own("first", {}, () => { calls.push("first") })
      if (attempts === 1) {
        child.own("second", {}, () => { calls.push("second") })
        throw new Error("not ready")
      }
      return "ready"
    }, () => {})

    await expect(lazy.get()).rejects.toThrow("not ready")
    expect(calls).toEqual(["second", "first"])
    expect(await lazy.get()).toBe("ready")
    expect(attempts).toBe(2)
  })

  it("closes admission, aborts, and awaits an in-flight attempt during disposal", async () => {
    const outer = createRuntimeOwnership(() => {})
    outer.reserve("resource")
    const aborted = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const lazy = createLazyRuntimeOwner(outer, async (signal, child) => {
      signal.addEventListener("abort", () => aborted.resolve(), { once: true })
      child.own("resource", {}, () => {})
      await finish.promise
      return "ready"
    }, () => {})
    const attempt = lazy.get()

    const disposal = lazy.dispose()
    await aborted.promise
    expect(await Promise.race([disposal.then(() => "disposed"), Promise.resolve("pending")])).toBe("pending")
    expect(() => lazy.get()).toThrow("disposed")
    finish.resolve()
    expect(await attempt).toBe("ready")
    await disposal
  })

  it("leaves successful resources for the outer shutdown barrier", async () => {
    const calls: string[] = []
    const outer = createRuntimeOwnership(() => {})
    const lazy = createLazyRuntimeOwner(outer, async (_signal, child) => {
      child.own("resource", {}, () => { calls.push("resource") })
      return "ready"
    }, () => {})
    outer.own("lazy-owner", lazy, (owned) => owned.dispose())
    outer.reserve("resource")
    outer.sequence("lazy-runtime", "release-state", ["lazy-owner", "resource"])
    const request = { owners: outer.complete() }

    expect(await lazy.get()).toBe("ready")
    expect(await runRuntimeShutdownBarrier(request)).toEqual({ kind: "settled" })
    expect(calls).toEqual(["resource"])
    expect(() => lazy.get()).toThrow("disposed")
  })
})
