import { describe, expect, it } from "bun:test"
import { createRuntimeOwnership } from "../../../../src/orchestration/app-service/runtime-ownership.js"
import { runRuntimeShutdownBarrier } from "../../../../src/orchestration/app-service/runtime-shutdown.js"

describe("runtime ownership", () => {
  it("refuses to publish a shutdown graph with an unassigned resource", () => {
    const ownership = createRuntimeOwnership(() => {})
    ownership.own("module-projection", {}, () => {})

    expect(() => ownership.complete()).toThrow("module-projection")
  })

  it("uses one stable disposer for rollback or normal shutdown", async () => {
    let disposals = 0
    const ownership = createRuntimeOwnership(() => {})
    ownership.own("module-projection", {}, () => { disposals++ })
    ownership.shutdown("module-projection", "close-client-streams")
    const request = { owners: ownership.complete() }

    expect(await runRuntimeShutdownBarrier(request)).toEqual({ kind: "settled" })
    expect(await runRuntimeShutdownBarrier(request)).toEqual({ kind: "settled" })
    expect(disposals).toBe(1)
  })

  it("settles a grouped lifecycle unit through the acquired disposers", async () => {
    const calls: string[] = []
    const ownership = createRuntimeOwnership(() => {})
    ownership.own("session-store", {}, () => { calls.push("sessions") })
    ownership.own("mcp-connections", {}, () => { calls.push("mcp") })
    ownership.sequence("session-runtime", "stop-runners", ["session-store", "mcp-connections"])

    const request = { owners: ownership.complete() }
    expect(await runRuntimeShutdownBarrier(request)).toEqual({ kind: "settled" })
    expect(await runRuntimeShutdownBarrier(request)).toEqual({ kind: "settled" })
    expect(calls).toEqual(["sessions", "mcp"])
  })

  it("does not dispose account-owned background resources after a writer drain failure", async () => {
    const calls: string[] = []
    const ownership = createRuntimeOwnership(() => {})
    ownership.own("writer", {}, () => { calls.push("writer"); throw new Error("drain failed") })
    ownership.own("background-process-client", {}, () => { calls.push("client") })
    ownership.own("background-lane", {}, () => { calls.push("lane") })
    ownership.shutdown("writer", "flush-durable-state")
    ownership.sequence("background-runtime", "close-client-streams", ["background-lane", "background-process-client"])

    expect(await runRuntimeShutdownBarrier({ owners: ownership.complete() })).toMatchObject({
      kind: "blocked",
      phase: "flush-durable-state",
    })
    expect(calls).toEqual(["writer"])
  })

  it("joins child settlements started by their lifecycle owner", async () => {
    const calls: string[] = []
    const ownership = createRuntimeOwnership(() => {})
    ownership.own("session-store", {}, () => { calls.push("store") })
    ownership.own("runtime-supervisor", {}, async () => { await ownership.settle("session-store"); calls.push("supervisor") })
    ownership.sequence("session-runtime", "stop-runners", ["runtime-supervisor", "session-store"])

    expect(await runRuntimeShutdownBarrier({ owners: ownership.complete() })).toEqual({ kind: "settled" })
    expect(calls).toEqual(["store", "supervisor"])
  })

  it("does not release project state before auth teardown settles", async () => {
    const authStarted = Promise.withResolvers<void>()
    const authGate = Promise.withResolvers<void>()
    const calls: string[] = []
    const ownership = createRuntimeOwnership(() => {})
    ownership.own("auth-runtime", {}, async () => { authStarted.resolve(); await authGate.promise; calls.push("auth") })
    ownership.own("event-store-runtime", {}, () => { calls.push("event-store") })
    ownership.own("workspace-generation", {}, () => { calls.push("generation") })
    ownership.sequence("project-state", "release-state", ["auth-runtime", "event-store-runtime", "workspace-generation"])

    const shutdown = runRuntimeShutdownBarrier({ owners: ownership.complete() })
    await authStarted.promise
    expect(calls).toEqual([])

    authGate.resolve()
    expect(await shutdown).toEqual({ kind: "settled" })
    expect(calls).toEqual(["auth", "event-store", "generation"])
  })

  it("rolls construction back in reverse order and continues after a failure", async () => {
    const calls: string[] = []
    const ownership = createRuntimeOwnership(() => { calls.push("reported") })
    ownership.own("first", {}, () => { calls.push("first") })
    ownership.own("second", {}, () => { calls.push("second"); throw new Error("failed") })

    await ownership.releaseAcquired()

    expect(calls).toEqual(["second", "reported", "first"])
  })

  it("rejects an adoption atomically when any child lacks a reserved position", async () => {
    const calls: string[] = []
    const outer = createRuntimeOwnership(() => {})
    outer.reserve("first")
    outer.shutdown("first", "release-state")
    const child = createRuntimeOwnership(() => {})
    child.own("first", {}, () => { calls.push("first") })
    child.own("missing", {}, () => { calls.push("missing") })

    expect(() => outer.adopt(child)).toThrow("missing")
    await child.releaseAcquired()
    expect(await runRuntimeShutdownBarrier({ owners: outer.complete() })).toEqual({ kind: "settled" })
    expect(calls).toEqual(["missing", "first"])
  })

})
