import { describe, expect, test } from "bun:test"

import { createAccountService } from "../../../../src/orchestration/app-service/account-service.js"
import type { StartupReached } from "../../../../src/protocol/startup-steps.js"

interface Runtime {
  readonly root: string
  dispose(): Promise<void>
}

const deferred = <T>() => Promise.withResolvers<T>()

describe("AccountService", () => {
  test("an open requested before admission opens publishes no slot and claims and opens nothing until admission opens", async () => {
    const events: string[] = []
    const service = createAccountService<Runtime>({
      canonicalizeProjectRoot: (root) => root,
      claimProject: async (root) => { events.push(`claim ${root}`); return () => {} },
      openProject: async (root) => { events.push(`open ${root}`); return { root, dispose: async () => {} } },
      recordTrustedAttach: async () => {},
    })

    const opened = service.open("/project")
    // An admitted open claims and opens within a few microtask turns.
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    expect(events).toEqual([])
    // A waiting open is no slot, so it is no opening project either.
    expect(service.state("/project")).toBeUndefined()

    service.openAdmission()
    expect((await opened).root).toBe("/project")
    expect(events).toEqual(["claim /project", "open /project"])
    await service.dispose()
  })

  test("closing admission refuses every open that waits for it, and the disposal settles", async () => {
    let claims = 0
    const service = createAccountService<Runtime>({
      canonicalizeProjectRoot: (root) => root,
      claimProject: async () => { claims += 1; return () => {} },
      openProject: async (root) => ({ root, dispose: async () => {} }),
      recordTrustedAttach: async () => {},
    })

    const waiting = service.open("/project")
    service.closeAdmission()
    await expect(waiting).rejects.toThrow("Account service is closing")
    // An admission that opens after it closed admits nothing.
    service.openAdmission()
    await expect(service.open("/other")).rejects.toThrow("Account service is closing")
    await service.dispose()
    expect(claims).toBe(0)
  })

  test("joins concurrent opens for one canonical root", async () => {
    const opening = deferred<Runtime>()
    const firstPhases: StartupReached[] = []
    const secondPhases: StartupReached[] = []
    let report!: (reached: StartupReached) => void
    let opened = 0
    const service = createAccountService<Runtime>({
      canonicalizeProjectRoot: () => "/canonical/project",
      openProject: async (root, onStartupPhase) => { opened += 1; report = onStartupPhase; return opening.promise.then(() => ({ root, dispose: async () => {} })) },
      recordTrustedAttach: async () => {},
    })
    service.openAdmission()

    const first = service.open("/alias-a", "client attach", (phase) => firstPhases.push(phase))
    report({ step: "workspace-state" })
    const second = service.open("/alias-b", "client attach", (phase) => secondPhases.push(phase))
    const migration: StartupReached = { step: "stored-facts", pass: { label: "memory facts", step: 1, total: 2 } }
    report(migration)
    expect(firstPhases).toEqual([{ step: "workspace-state" }, migration])
    expect(secondPhases).toEqual(firstPhases)
    expect(opened).toBe(1)
    opening.resolve({ root: "unused", dispose: async () => {} })
    expect(await second).toBe(await first)
    report({ step: "sessions" })
    expect(firstPhases).toHaveLength(2)
    const late: StartupReached[] = []
    await service.open("/alias-c", "client attach", (phase) => late.push(phase))
    expect(late).toEqual([])
    await service.close("/alias-a")
    const reopenedPhases: StartupReached[] = []
    const reopened = service.open("/alias-a", "client attach", (phase) => reopenedPhases.push(phase))
    expect(reopenedPhases).toEqual([])
    report({ step: "event-store" })
    await reopened
    expect(reopenedPhases).toEqual([{ step: "event-store" }])
    await service.dispose()
  })

  test("reserves a closing root until disposal settles", async () => {
    const closing = deferred<void>()
    let opens = 0
    const service = createAccountService<Runtime>({
      canonicalizeProjectRoot: (root) => root,
      openProject: async (root) => ({ root, dispose: async () => { await closing.promise } }),
      recordTrustedAttach: async () => { opens += 1 },
    })
    service.openAdmission()

    await service.open("/project")
    const close = service.close("/project")
    const reopened = service.open("/project")
    await Promise.resolve()
    expect(opens).toBe(1)
    closing.resolve()
    await close
    await reopened
    expect(opens).toBe(2)
  })

  test("records only a completed trusted attach and rolls back publication failure", async () => {
    let disposed = 0
    const service = createAccountService<Runtime>({
      canonicalizeProjectRoot: (root) => root,
      openProject: async (root) => ({ root, dispose: async () => { disposed += 1 } }),
      recordTrustedAttach: async () => { throw new Error("registry unavailable") },
    })
    service.openAdmission()

    await expect(service.open("/project")).rejects.toThrow("registry unavailable")
    expect(disposed).toBe(1)
    expect(service.state("/project")).toBe("failed")
  })

  test("retains a runtime for retry when close during open reaches a failed disposal", async () => {
    const opening = deferred<Runtime>()
    let disposals = 0
    const runtime = {
      root: "/project",
      dispose: async () => {
        disposals += 1
        if (disposals === 1) throw new Error("shutdown blocked")
      },
    }
    const service = createAccountService<Runtime>({
      canonicalizeProjectRoot: (root) => root,
      openProject: async () => opening.promise,
      recordTrustedAttach: async () => {},
    })
    service.openAdmission()

    const opened = service.open("/project")
    const closed = service.close("/project")
    opening.resolve(runtime)
    await opened
    await expect(closed).rejects.toThrow("shutdown blocked")
    expect(service.state("/project")).toBe("failed")

    await service.close("/project")
    expect(disposals).toBe(2)
    expect(service.state("/project")).toBeUndefined()
  })

  test("owns the fixed hub for the account-service lifetime", async () => {
    let stopped = 0
    const service = createAccountService<Runtime>({
      canonicalizeProjectRoot: (root) => root,
      openProject: async (root) => ({ root, dispose: async () => {} }),
      recordTrustedAttach: async () => {},
      startHub: () => ({ stop: () => { stopped += 1 } }),
    })
    service.openAdmission()

    expect(stopped).toBe(0)
    await service.dispose()
    expect(stopped).toBe(1)
  })
})
