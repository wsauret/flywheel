import { describe, expect, it } from "bun:test"
import { composeModules } from "../../../../src/infra/module-descriptor"
import { moduleRuntimeHandle } from "../../../../src/infra/module-runtime"
import type { FirstPartyModule } from "../../../../src/orchestration/modules"
import { flushMicrotasks, makeLifecycle } from "./_chat-runner-lifecycle-fixtures"

describe("chat module host session lifetime", () => {
  it("owns a module host before any model turn and retains it across agent generations", async () => {
    const handle = moduleRuntimeHandle<{ dispose(): Promise<void>; noteUserTurn(): void }>("synthetic-host")
    let created = 0
    let userTurns = 0
    let disposed = 0
    const instance = { async dispose() { disposed += 1 }, noteUserTurn() { userTurns += 1 } }
    const module = {
      id: "synthetic-host", dependencies: [], availability: { kind: "available" },
      contributions: [{ domain: "chatHosts", id: "synthetic-host", value: { handle, create: () => { created += 1; return instance } } }],
      observers: [], transformers: [], gates: [],
    } as const satisfies FirstPartyModule
    const { lifecycle, resolvers, runnerOptions } = makeLifecycle({ moduleSelection: () => composeModules([module]) })
    expect(lifecycle.chatModuleHosts.get(handle)).toBe(instance)
    expect(runnerOptions).toHaveLength(0)
    lifecycle.enqueueInput("first")
    await flushMicrotasks()
    lifecycle.enqueueInput("queued")
    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: "failed", recovery: { kind: "none" } } })
    await flushMicrotasks()
    expect(runnerOptions).toHaveLength(2)
    expect(lifecycle.chatModuleHosts.get(handle)).toBe(instance)
    expect(created).toBe(1)
    expect(userTurns).toBe(2)
    lifecycle.abortGeneration()
    resolvers[1]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await lifecycle.settle()
    await lifecycle.terminateBackgroundWorks()
    expect(disposed).toBe(1)
  })

  it("retires a selected-off module host once and joins its disposal at session close", async () => {
    const handle = moduleRuntimeHandle<{ dispose(): Promise<void> }>("synthetic-host")
    const released = Promise.withResolvers<void>()
    let disposals = 0
    const instance = { dispose() { disposals += 1; return released.promise } }
    const module = {
      id: "synthetic-host", dependencies: [], availability: { kind: "available" },
      contributions: [{ domain: "chatHosts", id: "synthetic-host", value: { handle, create: () => instance } }],
      observers: [], transformers: [], gates: [],
    } as const satisfies FirstPartyModule
    let enabled = true
    const { lifecycle } = makeLifecycle({ moduleSelection: () => composeModules([module], { disabledModuleIds: enabled ? [] : ["synthetic-host"] }) })
    expect(lifecycle.chatModuleHosts.get(handle)).toBe(instance)
    enabled = false
    expect(lifecycle.chatModuleHosts.get(handle)).toBeUndefined()
    expect(lifecycle.chatModuleHosts.get(handle)).toBeUndefined()
    let closed = false
    const close = lifecycle.terminateBackgroundWorks().then(() => { closed = true })
    await flushMicrotasks()
    expect(disposals).toBe(1)
    expect(closed).toBe(false)
    released.resolve()
    await close
    expect(closed).toBe(true)
  })
})
