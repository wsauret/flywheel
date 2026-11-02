import { describe, expect, test } from "bun:test"

import { Database } from "bun:sqlite"
import { existsSync, readdirSync } from "node:fs"
import { dirname } from "node:path"

import { availabilityAuthorityDbFile } from "../../../../src/infra/paths.js"
import { AVAILABILITY_PROTOCOL_VERSION } from "../../../../src/infra/llm/availability-store.js"
import {
  acquireSharedProviderAvailability,
  disposeSharedProviderAvailability,
  getSharedProviderAvailability,
} from "../../../../src/orchestration/agent-runtime/llm/shared-provider-availability.js"
import { runAccountShutdownBarrier, runRuntimeShutdownBarrier } from "../../../../src/orchestration/app-service/runtime-shutdown.js"
import type { RuntimeShutdownOwner, RuntimeShutdownRequest, RuntimeShutdownResult } from "../../../../src/orchestration/app-service/runtime-shutdown.js"
import { truncateWireError } from "../../../../src/orchestration/app-service/runtime-protocol-handlers.js"
import { diagnosticTier, isRegisteredDiagnostic } from "../../../../src/infra/diagnostics-registry.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

/** An owner whose interruption request and settlement the case drives by hand,
 *  so every gate below is a deterministic step instead of a sleep. */
interface DrivenOwner extends RuntimeShutdownOwner {
  readonly requests: () => number
  readonly settle: () => void
  readonly failSettlement: (error: Error) => void
}

function drivenOwner(owner: string, journal: string[]): DrivenOwner {
  let requests = 0
  let resolveSettlement = (): void => {}
  let rejectSettlement = (_error: Error): void => {}
  const settlement = new Promise<void>((resolve, reject) => {
    resolveSettlement = resolve
    rejectSettlement = reject
  })
  return {
    owner,
    requestInterruption: () => { requests += 1; journal.push(`request:${owner}`) },
    settled: () => { journal.push(`join:${owner}`); return settlement },
    requests: () => requests,
    settle: () => { journal.push(`settled:${owner}`); resolveSettlement() },
    failSettlement: (error) => { journal.push(`unsafe:${owner}`); rejectSettlement(error) },
  }
}

/** An owner that is already settled by the time it is asked. */
function quiescentOwner(owner: string, journal: string[]): RuntimeShutdownOwner {
  return {
    owner,
    requestInterruption: () => { journal.push(`request:${owner}`) },
    settled: async () => { journal.push(`settled:${owner}`) },
  }
}

/** An owner that acknowledges the interruption and then ignores it: its work
 *  never observes the abort, so its settlement never arrives. */
function abortIgnoringOwner(owner: string, journal: string[]): RuntimeShutdownOwner & { readonly signal: AbortSignal } {
  const controller = new AbortController()
  const never = new Promise<void>(() => {})
  return {
    owner,
    signal: controller.signal,
    requestInterruption: () => { journal.push(`request:${owner}`); controller.abort() },
    settled: () => { journal.push(`join:${owner}`); return never },
  }
}

/** The diagnostic timer, captured instead of scheduled: a case fires it when it
 *  chooses, and a case that passes it and never fires it has no timer at all. */
function capturedDiagnosticTimer() {
  let pending: (() => void) | null = null
  let arms = 0
  return {
    set: (fire: () => void) => { arms += 1; pending = fire; return () => { pending = null } },
    fire: () => { const fire = pending; pending = null; fire?.() },
    arms: () => arms,
  }
}

const PENDING = "pending" as const

/** Drains the microtask queue, then reports the barrier's outcome or PENDING.
 *  A barrier that is still pending after the queue drains is blocked on an
 *  owner's settlement, which is the only thing that can resolve it. */
async function outcomeOrPending(run: Promise<RuntimeShutdownResult>): Promise<RuntimeShutdownResult | typeof PENDING> {
  for (let hop = 0; hop < 32; hop += 1) await Promise.resolve()
  return await Promise.race([run, Promise.resolve(PENDING)])
}

describe("runRuntimeShutdownBarrier interruption and settlement", () => {
  test("account shutdown joins openings, flushes writers, then closes projects and shared resources", async () => {
    const journal: string[] = []
    const result = await runAccountShutdownBarrier({
      closeAdmission: () => { journal.push("close-admission") },
      joinOpenings: async () => { journal.push("join-openings") },
      flushWriters: async () => { journal.push("flush-writers") },
      projectBarriers: [async () => { journal.push("project-barrier") }],
      closeSharedResources: async () => { journal.push("shared-resources") },
    })

    expect(result).toEqual({ kind: "settled" })
    expect(journal).toEqual(["close-admission", "join-openings", "flush-writers", "project-barrier", "shared-resources"])
  })

  test("account shutdown lets every project close to its own bound before it reports the ones that failed", async () => {
    const later = Promise.withResolvers<void>()
    const journal: string[] = []
    const run = runAccountShutdownBarrier({
      closeAdmission() {},
      joinOpenings: async () => {},
      flushWriters: async () => {},
      projectBarriers: [
        async () => { throw new Error("recovery failed") },
        () => later.promise.then(() => { journal.push("sibling closed") }),
      ],
      closeSharedResources: async () => { journal.push("shared-resources") },
    })
    let reported = false
    void run.then(() => { reported = true })
    await Bun.sleep(1)
    expect(reported).toBe(false)

    later.resolve()
    const result = await run
    expect(journal).toEqual(["sibling closed"])
    expect(result.kind).toBe("blocked")
    if (result.kind !== "blocked") throw new Error("account shutdown settled")
    expect(result.stage).toBe("project-barriers")
    if (!(result.error instanceof AggregateError)) throw new Error("the failures were not reported together")
    expect(result.error.errors.map((error: Error) => error.message)).toEqual(["recovery failed"])
  })

  test("closes admission first, then joins every phase's settlement in declared order", async () => {
    const journal: string[] = []

    const result = await runRuntimeShutdownBarrier({
      closeAdmission: () => { journal.push("close-admission") },
      owners: {
        "stop-runners": [quiescentOwner("runners", journal)],
        "flush-durable-state": [quiescentOwner("writer", journal)],
        "dispose-availability": [quiescentOwner("availability", journal)],
        "drain-clients": [quiescentOwner("clients", journal)],
        "close-client-streams": [quiescentOwner("streams", journal)],
        "release-state": [quiescentOwner("state", journal)],
      },
      setDiagnosticTimer: capturedDiagnosticTimer().set,
    })

    expect(result).toEqual({ kind: "settled" })
    expect(journal).toEqual([
      "close-admission",
      "request:runners", "settled:runners",
      "request:writer", "settled:writer",
      "request:availability", "settled:availability",
      "request:clients", "settled:clients",
      "request:streams", "settled:streams",
      "request:state", "settled:state",
    ])
  })

  test("a failed interruption request still joins settlement and blocks later phases", async () => {
    const journal: string[] = []
    const unreachable: RuntimeShutdownOwner = {
      owner: "runners",
      requestInterruption: () => { throw new Error("cannot signal the runner pool") },
      settled: async () => { journal.push("join:runners") },
    }

    const result = await runRuntimeShutdownBarrier({
      owners: {
        "stop-runners": [unreachable],
        "release-state": [quiescentOwner("state", journal)],
      },
      setDiagnosticTimer: capturedDiagnosticTimer().set,
    })

    expect(result.kind).toBe("blocked")
    if (result.kind !== "blocked") return
    expect(result.phase).toBe("stop-runners")
    expect(result.failures.map((failure) => [failure.kind, failure.owner])).toEqual([["interruption-request-failed", "runners"]])
    expect(journal).toEqual(["join:runners"])
  })

  test("an owner that settles unsafely blocks the later phases", async () => {
    const journal: string[] = []
    const runners = drivenOwner("runners", journal)

    const run = runRuntimeShutdownBarrier({
      owners: {
        "stop-runners": [runners],
        "release-state": [quiescentOwner("state", journal)],
      },
      setDiagnosticTimer: capturedDiagnosticTimer().set,
    })
    runners.failSettlement(new Error("a runner Fiber died on interruption"))
    const result = await run

    expect(result.kind).toBe("blocked")
    if (result.kind !== "blocked") return
    expect(result.phase).toBe("stop-runners")
    expect(result.failures.map((failure) => [failure.kind, failure.owner])).toEqual([["settled-unsafe", "runners"]])
    expect(journal).not.toContain("request:state")
  })

  test("every sibling settlement in a phase is joined even after one sibling settles unsafely", async () => {
    const journal: string[] = []
    const first = drivenOwner("runners-a", journal)
    const second = drivenOwner("runners-b", journal)

    const run = runRuntimeShutdownBarrier({
      owners: {
        "stop-runners": [first, second],
        "release-state": [quiescentOwner("state", journal)],
      },
      setDiagnosticTimer: capturedDiagnosticTimer().set,
    })
    expect(await outcomeOrPending(run)).toBe(PENDING)
    expect(journal.slice(0, 2)).toEqual(["request:runners-a", "request:runners-b"])

    first.failSettlement(new Error("runner pool a wedged"))
    expect(await outcomeOrPending(run)).toBe(PENDING)

    second.settle()
    const result = await run

    expect(journal).toContain("settled:runners-b")
    expect(result.kind).toBe("blocked")
    expect(journal).not.toContain("request:state")
  })

  test("the diagnostic deadline repeats the interruption request and cannot resolve the join", async () => {
    const journal: string[] = []
    const runners = drivenOwner("runners", journal)
    const timer = capturedDiagnosticTimer()

    const run = runRuntimeShutdownBarrier({
      owners: {
        "stop-runners": [runners],
        "release-state": [quiescentOwner("state", journal)],
      },
      diagnosticIntervalMs: 5,
      setDiagnosticTimer: timer.set,
    })
    expect(await outcomeOrPending(run)).toBe(PENDING)
    expect(runners.requests()).toBe(1)

    timer.fire()

    expect(runners.requests()).toBe(2)
    expect(timer.arms()).toBe(2)
    expect(await outcomeOrPending(run)).toBe(PENDING)
    expect(journal).not.toContain("request:state")

    runners.settle()

    expect(await run).toEqual({ kind: "settled" })
  })

  test("an owner whose work ignores the abort never settles, so no later phase runs", async () => {
    const journal: string[] = []
    const wedged = abortIgnoringOwner("runners", journal)
    const timer = capturedDiagnosticTimer()

    const run = runRuntimeShutdownBarrier({
      owners: {
        "stop-runners": [wedged],
        "release-state": [quiescentOwner("state", journal)],
      },
      diagnosticIntervalMs: 5,
      setDiagnosticTimer: timer.set,
    })

    expect(await outcomeOrPending(run)).toBe(PENDING)
    expect(wedged.signal.aborted).toBe(true)
    expect(journal).toEqual(["request:runners", "join:runners"])

    timer.fire()

    expect(await outcomeOrPending(run)).toBe(PENDING)
    expect(journal).not.toContain("request:state")
  })

  test("the shared barrier survives a caller that gives up waiting", async () => {
    const journal: string[] = []
    const runners = drivenOwner("runners", journal)
    const request = {
      owners: { "stop-runners": [runners], "release-state": [quiescentOwner("state", journal)] },
      setDiagnosticTimer: capturedDiagnosticTimer().set,
    } satisfies RuntimeShutdownRequest

    const run = runRuntimeShutdownBarrier(request)
    expect(await Promise.race([run.then(() => "completed"), Promise.resolve("caller-gave-up")])).toBe("caller-gave-up")

    runners.settle()

    expect(await run).toEqual({ kind: "settled" })
    expect(await runRuntimeShutdownBarrier(request)).toEqual({ kind: "settled" })
    expect(runners.requests()).toBe(1)
    expect(journal).toContain("settled:state")
  })

  test("concurrent requests share one run: the owners are interrupted exactly once", async () => {
    const journal: string[] = []
    const runners = drivenOwner("runners", journal)
    const request = {
      owners: { "stop-runners": [runners] },
      setDiagnosticTimer: capturedDiagnosticTimer().set,
    } satisfies RuntimeShutdownRequest

    const runs = [runRuntimeShutdownBarrier(request), runRuntimeShutdownBarrier(request), runRuntimeShutdownBarrier(request)]
    runners.settle()
    const [first, second, third] = await Promise.all(runs)

    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(runners.requests()).toBe(1)
    expect(journal.filter((entry) => entry === "request:runners")).toEqual(["request:runners"])
    expect(journal.filter((entry) => entry === "join:runners")).toEqual(["join:runners"])
  })

  test("a synchronous reentrant request joins the run before callbacks can start another barrier", async () => {
    const journal: string[] = []
    const runners = drivenOwner("runners", journal)
    let reentered = false
    let nested: Promise<RuntimeShutdownResult> | undefined
    const request = {
      closeAdmission: () => {
        if (reentered) return
        reentered = true
        nested = runRuntimeShutdownBarrier(request)
      },
      owners: { "stop-runners": [runners] },
      setDiagnosticTimer: capturedDiagnosticTimer().set,
    } satisfies RuntimeShutdownRequest

    const first = runRuntimeShutdownBarrier(request)
    runners.settle()

    expect(nested).toBe(first)
    expect(await first).toEqual({ kind: "settled" })
    expect(runners.requests()).toBe(1)
  })
})

describe("truncateWireError", () => {
  test("truncates a 10KB error message to at most 1024 chars plus a marker", () => {
    const huge = "x".repeat(10_000)
    const truncated = truncateWireError(huge)
    expect(truncated.length).toBeLessThanOrEqual(1024 + 32)
    expect(truncated.startsWith("x".repeat(1024))).toBe(true)
    expect(truncated).toContain("truncated")
  })

  test("passes a short message through unchanged", () => {
    expect(truncateWireError("short error")).toBe("short error")
  })

})

describe("shared availability authority lifecycle", () => {
  const temporaryDirectory = temporaryDirectories()

  /** An isolated account data root, so a case never touches the user's own
   *  authority file, and leaves no owner behind for the next one. */
  async function withOwnAccount(run: (account: { userDataRoot: string; dbFile: string }) => Promise<void>): Promise<void> {
    const userDataRoot = temporaryDirectory("flywheel-availability-lifecycle-")
    try {
      await disposeSharedProviderAvailability()
      await run({ userDataRoot, dbFile: availabilityAuthorityDbFile(userDataRoot, AVAILABILITY_PROTOCOL_VERSION) })
    } finally {
      await disposeSharedProviderAvailability()
    }
  }

  test("a client build opens no authority: it reads whatever the composition acquired", async () => {
    await withOwnAccount(async ({ dbFile }) => {
      // What building a client and selecting a provider does, with no
      // composition to have acquired anything.
      getSharedProviderAvailability().forCandidates("default", [{ kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }]).refreshProjection()

      expect(existsSync(dbFile)).toBe(false)
    })
  })

  test("acquisition opens the file and creates the schema, and a later selection adds nothing", async () => {
    await withOwnAccount(async ({ userDataRoot, dbFile }) => {
      const owner = acquireSharedProviderAvailability(userDataRoot, ["openai_api"])

      expect(acquireSharedProviderAvailability(userDataRoot, ["openai_api"])).toBe(owner)
      const db = new Database(dbFile)
      expect(db.query<{ name: string }, []>(`select name from sqlite_master where type = 'table' order by name`).all().map((row) => row.name))
        .toEqual(["availability_authority", "availability_state"])
      db.close()

      // The first selection finds the authority already there: it reads the
      // accounts it is bound to and creates no file of its own.
      const entries = readdirSync(dirname(dbFile)).sort()
      owner.forCandidates("default", [{ kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }]).refreshProjection()

      expect(readdirSync(dirname(dbFile)).sort()).toEqual(entries)
    })
  })

})

describe("maintenance diagnostics", () => {
  test("registers job lifecycle diagnostics at debug volume", () => {
    for (const type of [
      "runtime.maintenance.queued",
      "runtime.maintenance.withdrawn",
    ]) {
      expect(isRegisteredDiagnostic(type)).toBe(true)
      expect(diagnosticTier(type)).toBe("debug")
    }
  })
})
