import { describe, expect, test } from "bun:test"
import { Redacted } from "effect"

import { createAccountService } from "../../../../src/orchestration/app-service/account-service.js"
import { createAccountSocketRouter } from "../../../../src/orchestration/app-service/account-socket-router.js"
import { createProjectRuntime } from "../../../../src/orchestration/app-service/project-runtime.js"
import { createRuntimeOwnership } from "../../../../src/orchestration/app-service/runtime-ownership.js"
import { runRuntimeShutdownBarrier } from "../../../../src/orchestration/app-service/runtime-shutdown.js"
import { encodeAccountAttach, newAccountAttachCredential } from "../../../../src/protocol/account-attach.js"

const deferred = <T>() => Promise.withResolvers<T>()

describe("AccountService monotonic lifecycle", () => {
  test("failed transport and rollback retain both errors and the claim until retry succeeds", async () => {
    const transport = new Error("transport startup failed")
    const rollback = new Error("rollback failed")
    const events: string[] = []
    let opens = 0
    let disposals = 0
    const service = createAccountService({
      canonicalizeProjectRoot: (root) => root,
      claimProject: async () => { events.push("claim"); return () => { events.push("release") } },
      recordTrustedAttach: async () => {},
      openProject: async (_root, _phase, _exclusive, ownership) => {
        opens++
        const runtime = { dispose: async () => { events.push("dispose"); if (++disposals === 1) throw rollback } }
        ownership.own(runtime)
        if (opens === 1) throw transport
        return runtime
      },
    })
    service.openAdmission()
    const failure = await service.open("/project").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error("expected both open and rollback errors")
    expect(failure.errors).toEqual([transport, rollback])
    expect(events).toEqual(["claim", "dispose"])
    expect(service.state("/project")).toBe("failed")
    await service.open("/project")
    expect(events).toEqual(["claim", "dispose", "dispose", "release", "claim"])
    await service.dispose()
    expect(events).toEqual(["claim", "dispose", "dispose", "release", "claim", "dispose", "release"])
  })

  test("an idle close during failed transport startup retains failed rollback ownership until disposal succeeds", async () => {
    const transport = new Error("slow transport startup failed")
    const rollback = new Error("rollback failed")
    const startup = deferred<void>()
    const idle = deferred<void>()
    const closed = deferred<unknown>()
    const events: string[] = []
    let disposals = 0
    const service = createAccountService({
      canonicalizeProjectRoot: (root) => root,
      claimProject: async () => { events.push("claim"); return () => { events.push("release") } },
      recordTrustedAttach: async () => {},
      openProject: async (root, _phase, _exclusive, ownership) => {
        const runtime = createProjectRuntime({
          projectRoot: root,
          idleGraceMs: 1,
          blockers: async () => [],
          onIdle: () => {
            const closing = service.close(root, "idle")
            void closing.then(() => closed.resolve(undefined), closed.resolve)
            idle.resolve()
            return closing
          },
          closeEndpoint: async () => {},
          closeTransports: async () => {},
          runShutdownBarrier: async () => {
            events.push("dispose")
            if (++disposals === 1) throw rollback
          },
        })
        ownership.own(runtime)
        await startup.promise
        return runtime
      },
    })
    service.openAdmission()
    const opened = service.open("/project").catch((error: unknown) => error)
    try {
      await idle.promise
      expect(service.state("/project")).toBe("closing")
      startup.reject(transport)
      const failure = await opened
      expect(failure).toBeInstanceOf(AggregateError)
      if (!(failure instanceof AggregateError)) throw new Error("expected startup and rollback errors")
      expect(failure.errors).toEqual([transport, rollback])
      expect(await closed.promise).toBe(failure)
      expect(service.state("/project")).toBe("failed")
      expect(events).toEqual(["claim", "dispose"])
      await service.close("/project")
      expect(events).toEqual(["claim", "dispose", "dispose", "release"])
      expect(service.state("/project")).toBeUndefined()
    } finally {
      await service.dispose()
    }
  })

  test.each([true, false])("a project claim is held through close and passes exclusive=%s to open", async (exclusive) => {
    const events: string[] = []
    const service = createAccountService({
      canonicalizeProjectRoot: (root) => root,
      claimProject: async (root) => { events.push(`claim ${root}`); return Object.assign(() => { events.push(`release ${root}`) }, { exclusive }) },
      openProject: async (root, _phase, exclusiveClaim) => { events.push(`open ${root} ${exclusiveClaim}`); return { dispose: async () => { events.push(`dispose ${root}`) } } },
      recordTrustedAttach: async () => {},
    })
    service.openAdmission()
    await service.open("/project")
    expect(events).toEqual(["claim /project", `open /project ${exclusive}`])
    await service.close("/project")
    expect(events).toEqual(["claim /project", `open /project ${exclusive}`, "dispose /project", "release /project"])
  })

  test("a refused claim rejects the open without opening anything, and a failed open releases its claim", async () => {
    const events: string[] = []
    let refuse = true
    const service = createAccountService({
      canonicalizeProjectRoot: (root) => root,
      claimProject: async (root) => {
        if (refuse) throw new Error(`${root} is open in the dev lane (pid 4242)`)
        events.push("claim")
        return () => { events.push("release") }
      },
      openProject: async () => { events.push("open"); throw new Error("no runtime today") },
      recordTrustedAttach: async () => {},
    })
    service.openAdmission()
    await expect(service.open("/project")).rejects.toThrow("is open in the dev lane (pid 4242)")
    expect(events).toEqual([])
    expect(service.state("/project")).toBe("failed")

    refuse = false
    await expect(service.open("/project")).rejects.toThrow("no runtime today")
    expect(events).toEqual(["claim", "open", "release"])
  })

  test("a close during trusted-attach recording cannot be overwritten by the delayed open", async () => {
    const recording = deferred<void>()
    const disposing = deferred<void>()
    let opens = 0
    const service = createAccountService({
      canonicalizeProjectRoot: (root) => root,
      openProject: async () => ({ dispose: async () => { await disposing.promise } }),
      recordTrustedAttach: async () => { opens += 1; await recording.promise },
    })
    service.openAdmission()

    const opening = service.open("/project")
    await Promise.resolve()
    const closing = service.close("/project")
    recording.resolve()
    await opening
    expect(service.state("/project")).toBe("closing")
    disposing.resolve()
    await closing
    expect(service.state("/project")).toBeUndefined()
    expect(opens).toBe(1)
  })

  test("closing admission stops the hub and refuses opens before the drain settles", async () => {
    const disposing = deferred<void>()
    let stops = 0
    const service = createAccountService({
      canonicalizeProjectRoot: (root) => root,
      openProject: async () => ({ dispose: async () => { await disposing.promise } }),
      recordTrustedAttach: async () => {},
      startHub: () => ({ stop: () => { stops += 1 } }),
    })
    service.openAdmission()

    await service.open("/project")
    service.closeAdmission()
    expect(stops).toBe(1)
    await expect(service.open("/other")).rejects.toThrow("Account service is closing")

    const disposal = service.dispose()
    disposing.resolve()
    await disposal
    expect(service.state("/project")).toBeUndefined()
    expect(stops).toBe(1)
  })

  test("retains a failed release for retry before reopening", async () => {
    let disposals = 0
    let opens = 0
    let releases = 0
    const service = createAccountService({
      canonicalizeProjectRoot: (root) => root,
      claimProject: async () => () => { releases++ },
      openProject: async () => {
        opens += 1
        return { dispose: async () => { disposals += 1; if (disposals === 1) throw new Error("release failed") } }
      },
      recordTrustedAttach: async () => {},
    })
    service.openAdmission()

    await service.open("/project")
    await expect(service.close("/project")).rejects.toThrow("release failed")
    expect(service.state("/project")).toBe("failed")
    expect(releases).toBe(0)
    await service.close("/project")
    expect(releases).toBe(1)
    await service.open("/project")
    expect({ opens, disposals }).toEqual({ opens: 2, disposals: 2 })
  })

  test("production owners compose 0 to 1 to 2 to 1 to 0 and reopen", async () => {
    const clients: number[] = [0]
    let held = 0
    let generations = 0
    const service = createAccountService({
      canonicalizeProjectRoot: (root) => root,
      openProject: async () => {
        generations += 1
        const runtime = createProjectRuntime({
          projectRoot: "/project",
          idleGraceMs: 0,
          blockers: async () => [],
          onIdle: async () => {},
          closeEndpoint: async () => {},
          closeTransports: async () => {},
          runShutdownBarrier: async () => {},
        })
        return {
          holdClient() {
            const release = runtime.holdClient()
            held += 1
            clients.push(held)
            return () => {
              release()
              held -= 1
              clients.push(held)
            }
          },
          dispose: () => runtime.dispose(),
        }
      },
      recordTrustedAttach: async () => {},
    })
    service.openAdmission()
    const credential = newAccountAttachCredential()
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: async () => "busy",
      answerRestart: async () => "busy",
      moduleRequest: async () => { throw new Error("no module service in this test") },
      client: async () => ({ kind: "failed", error: "no client in this test" }),
      canonicalizeProjectRoot: (root) => root,
      openProject: async (root) => {
        const runtime = await service.open(root)
        return { receive: async () => {}, release: runtime.holdClient() }
      },
    })
    const attach = new TextEncoder().encode(encodeAccountAttach({ projectRoot: "/project", credential, intent: "runtime" }))

    await router.receive("first", attach)
    await router.receive("second", attach)
    router.close("first")
    router.close("second")
    await service.close("/project")
    await router.receive("reopen", attach)

    expect(clients).toEqual([0, 1, 2, 1, 0, 1])
    expect(generations).toBe(2)
    router.close("reopen")
    await service.dispose()
  })

  test("idle expiration closes only its owning project through the account service", async () => {
    const disposed: string[] = []
    const service = createAccountService({
      canonicalizeProjectRoot: (root) => root,
      openProject: async (root) => {
        const runtime = createProjectRuntime({
          projectRoot: "/project",
          idleGraceMs: 1,
          blockers: async () => [],
          onIdle: () => service.close(root),
          closeEndpoint: async () => {},
          closeTransports: async () => {},
          runShutdownBarrier: async () => { disposed.push(root) },
        })
        return { holdClient: () => runtime.holdClient(), dispose: () => runtime.dispose() }
      },
      recordTrustedAttach: async () => {},
    })
    service.openAdmission()

    const a = await service.open("/a")
    const b = await service.open("/b")
    const releaseA = a.holdClient()
    const releaseB = b.holdClient()
    releaseA()
    await Bun.sleep(5)

    expect(disposed).toEqual(["/a"])
    expect(service.state("/a")).toBeUndefined()
    expect(service.state("/b")).toBe("open")
    releaseB()
    await service.dispose()
  })

  test("an idle close that fails leaves the project failed and never ends the account service", async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => { unhandled.push(reason) }
    process.on("unhandledRejection", record)
    let barriers = 0
    try {
      const service = createAccountService({
        canonicalizeProjectRoot: (root) => root,
        openProject: async (root) => {
          const runtime = createProjectRuntime({
            projectRoot: "/project",
            idleGraceMs: 1,
            blockers: async () => [],
            onIdle: () => service.close(root),
            closeEndpoint: async () => {},
            closeTransports: async () => {},
            // The first close fails, as a failed recovery rerun fails it.
            runShutdownBarrier: async () => { if (++barriers === 1) throw new Error("recovery failed") },
          })
          return { holdClient: () => runtime.holdClient(), dispose: () => runtime.dispose() }
        },
        recordTrustedAttach: async () => {},
      })
      service.openAdmission()

      const project = await service.open("/a")
      project.holdClient()()
      await Bun.sleep(10)

      expect(unhandled).toEqual([])
      expect(service.state("/a")).toBe("failed")
      await service.dispose()
      expect(barriers).toBe(2)
    } finally {
      process.off("unhandledRejection", record)
    }
  })

  test("a project whose idle close failed reopens once its recovery can succeed", async () => {
    // The project's own shutdown graph, as its control runtime composes it:
    // the executor's close fails while its recovery cannot finish, and the
    // next open asks that owner again instead of repeating the failure.
    let recoveryFails = true
    let executorCloses = 0
    let opens = 0
    const service = createAccountService({
      canonicalizeProjectRoot: (root) => root,
      openProject: async (root) => {
        opens += 1
        const scope = createRuntimeOwnership(() => {})
        scope.own("executor", {}, async () => {
          executorCloses += 1
          if (recoveryFails) throw new Error("Flywheel could not restore this project's sessions.")
        })
        scope.own("state", {}, async () => {})
        scope.sequence("executor", "stop-runners", ["executor"])
        scope.sequence("state-worker", "release-state", ["state"])
        const shutdown = { owners: scope.complete() }
        const runtime = createProjectRuntime({
          projectRoot: "/project",
          idleGraceMs: 1,
          blockers: async () => [],
          onIdle: () => service.close(root),
          closeEndpoint: async () => {},
          closeTransports: async () => {},
          async runShutdownBarrier() {
            const result = await runRuntimeShutdownBarrier(shutdown)
            if (result.kind === "blocked") throw new Error(`project shutdown blocked at ${result.phase}`)
          },
        })
        return { holdClient: () => runtime.holdClient(), dispose: () => runtime.dispose() }
      },
      recordTrustedAttach: async () => {},
    })
    service.openAdmission()

    await service.open("/a")
    await Bun.sleep(10)
    expect(service.state("/a")).toBe("failed")
    expect(executorCloses).toBe(1)

    recoveryFails = false
    const reopened = await service.open("/a")
    const release = reopened.holdClient()
    expect(service.state("/a")).toBe("open")
    expect(executorCloses).toBe(2)
    expect(opens).toBe(2)
    release()
    await service.dispose()
  })
})
