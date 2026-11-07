import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import { applySessionNoticeOperation, type SessionNotice, type SessionNoticeOperation } from "../../../../src/infra/session-notice.js"
import { resolveProviderNotices, runWithResilience } from "../../../../src/orchestration/agent-runtime/agent-resilience.js"
import { fromStreamError, toFailureReason } from "../../../../src/orchestration/agent-runtime/errors.js"
import { RouteUnavailableError } from "../../../../src/orchestration/agent-runtime/llm/errors.js"
import { classifyResponseFailed } from "../../../../src/orchestration/agent-runtime/llm/openai-helpers.js"
import type { AgentFailureReason, AgentRunResult } from "../../../../src/orchestration/agent-runtime/types.js"
import { createUnattendedRecovery, endingCapacityWaitOnPersonMessage, WAIT_LIMIT_MS } from "../../../../src/orchestration/agent-runtime/unattended-recovery.js"
import { WALL_CLOCK_CHECK_MS } from "../../../../src/infra/wall-clock-sleep.js"
import { capacityWaitAuthority, registerCapacityWaits, type CapacityWaitAuthority } from "../../../../src/orchestration/session/capacity-wait.js"
import { EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { createSupervisorTestContext, disposeSupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import type { DeliveryOutcome } from "../../../../src/orchestration/session/live-session-control.js"
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js"
import { chain, fakeAvailability, preparedRequest } from "./llm/_provider-chain-harness.js"

const NOW = Date.parse("2026-10-10T12:00:00.000Z")
const HOUR = 3_600_000
const PAUSES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000]
/** The timers one wait of `ms` runs: one per wall-clock check. */
const chunks = (ms: number): number[] => Array.from({ length: Math.ceil(ms / WALL_CLOCK_CHECK_MS) }, (_, index) => Math.min(WALL_CLOCK_CHECK_MS, ms - index * WALL_CLOCK_CHECK_MS))

/** A fake clock: each sleep moves it forward by the time slept, at once,
 *  unless `hold` keeps the sleep open until the test releases it. An abort
 *  ends a sleep at once. */
function fakeClock() {
  let now = NOW
  const slept: number[] = []
  let held: { readonly resolve: () => void } | null = null
  let hold = false
  return {
    slept,
    now: () => now,
    holdNextSleep: () => { hold = true },
    release: () => { held?.resolve() },
    sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
      slept.push(ms)
      const finish = () => { now += ms; held = null; resolve() }
      signal.addEventListener("abort", () => { held = null; resolve() }, { once: true })
      if (!hold) { finish(); return }
      hold = false
      held = { resolve: finish }
    }),
  }
}

type Deps = Parameters<typeof createUnattendedRecovery>[0]
function policy(clock: ReturnType<typeof fakeClock>, overrides: Partial<Deps> = {}) {
  return createUnattendedRecovery({
    sessionId: "workflow", runId: "attempt", caller: "workflow-agent", agentName: "Work",
    onNotice: () => {}, awaitAccessSettled: async () => {}, now: clock.now, sleep: clock.sleep,
    ...overrides,
  })
}

const signal = new AbortController().signal
const result = (terminal: AgentRunResult["terminal"], servedRequests = 0): AgentRunResult => ({ durationMs: 1, servedRequests, terminal })
const exhausted = (atMs: number, servedRequests = 0) => result({ kind: "api_error", message: "No access provider can run the model", recovery: { kind: "at", atMs } }, servedRequests)
const disconnect: AgentFailureReason = { kind: "transient_disconnect", message: "socket closed" }
const completed = result({ kind: "completed" })

const records: { readonly type: string; readonly payload?: unknown }[] = []
let recordSpy: ReturnType<typeof spyOn> | undefined
function captureRecords(): void {
  records.length = 0
  recordSpy = spyOn(DebugLog, "record").mockImplementation((entry) => { records.push(entry) })
}
afterEach(() => { recordSpy?.mockRestore(); recordSpy = undefined })
const recoveryRecords = () => records.filter(({ type }) => type === "agent.unattended.recovery").map(({ payload }) => payload)
/** The decision fields of one `agent.unattended.recovery` record. */
interface RecoveryDecision {
  readonly decision: "wait" | "interrupted" | "restart" | "fail"
  readonly failure: AgentFailureReason["kind"]
  readonly streak: number
  readonly delayMs?: number
  readonly served: number
}
const record = (fields: RecoveryDecision) => ({ caller: "workflow-agent", runId: "attempt", ...fields })

describe("unattended recovery", () => {
  it("waits for the provider capacity to return, uncounted, shows the wait without an action, and runs again", async () => {
    captureRecords()
    const clock = fakeClock()
    const notices: SessionNoticeOperation[] = []
    const recovery = policy(clock, { onNotice: (operation) => { notices.push(operation) } })
    const results = [exhausted(NOW + 90 * 60_000), completed]
    let runs = 0
    const settled = await runWithResilience(async () => results[runs++]!, { recover: recovery.recover })

    expect(settled.terminal.kind).toBe("completed")
    expect(runs).toBe(2)
    expect(clock.slept).toEqual(chunks(90 * 60_000))
    expect(notices[0]).toMatchObject({
      type: "upsert",
      notice: { presentation: "provider.reconnect_progress", title: "Waiting for model capacity", wait: { agentName: "Work", continuesAt: NOW + 90 * 60_000 } },
    })
    expect(notices[0]?.type === "upsert" ? notices[0].notice.retry : "absent").toBeUndefined()
    expect(notices[0]?.type === "upsert" ? notices[0].notice.action : "absent").toBeUndefined()
    expect(notices).toContainEqual({ type: "resolve", id: "capacity-wait:workflow" })
    expect(recoveryRecords()).toEqual([record({ decision: "wait", failure: "api_error", streak: 0, delayMs: 90 * 60_000, served: 0 })])
  })

  it("keeps an agent's wait notice while the other agents of the run stream, settle, and end their own waits", async () => {
    let notices: readonly SessionNotice[] = []
    const fold = (operation: SessionNoticeOperation) => { notices = applySessionNoticeOperation(notices, operation, NOW) }
    const waiting = fakeClock()
    const first = policy(waiting, { onNotice: fold })
    const second = policy(fakeClock(), { sessionId: "sibling", runId: "sibling", agentName: "Review", onNotice: fold })
    waiting.holdNextSleep()
    const wait = first.recover({ kind: "api_error", message: "usage limit", recovery: { kind: "at", atMs: NOW + HOUR } }, 0, signal)
    // A sibling agent's stream event and its settled run resolve the provider
    // scope, and its own wait starts and ends.
    fold(resolveProviderNotices())
    await second.recover({ kind: "api_error", message: "usage limit", recovery: { kind: "at", atMs: NOW + 60_000 } }, 0, signal)
    expect(notices.map(({ id, message }) => [id, message])).toEqual([["capacity-wait:workflow", expect.stringContaining('"Work"')]])
    waiting.release()
    await wait
    expect(notices).toEqual([])
  })

  it("waits until the stated time however far it is, judged by the wall clock, and runs once again", async () => {
    const clock = fakeClock()
    const recovery = policy(clock)
    const far = NOW + 20 * HOUR
    let runs = 0
    const settled = await runWithResilience(async () => {
      runs += 1
      return clock.now() < far ? exhausted(far) : completed
    }, { recover: recovery.recover })

    expect(settled.terminal.kind).toBe("completed")
    expect(clock.slept).toEqual(chunks(20 * HOUR))
    expect(runs).toBe(2)
  })

  it("continues at the first check after a machine that slept through the stated time wakes", async () => {
    let now = NOW
    const slept: number[] = []
    // The machine sleeps for three hours during the first timer.
    const recovery = policy(fakeClock(), { now: () => now, sleep: async (ms) => { slept.push(ms); now += 3 * HOUR } })
    await recovery.recover({ kind: "api_error", message: "usage limit", recovery: { kind: "at", atMs: NOW + HOUR } }, 0, signal)
    expect(slept).toEqual([WALL_CLOCK_CHECK_MS])
  })

  it("arms the durable wait before it waits, keeps it armed through the run that continues until that run ends, and withdraws it at once for a message, an interrupt, or a cancellation", async () => {
    const steps: string[] = []
    const capacity: CapacityWaitAuthority = {
      arm: async (atMs) => { steps.push(`arm ${atMs - NOW}`) },
      withdraw: async (reason) => { steps.push(`withdraw ${reason}`) },
      settle: async (reason) => { steps.push(`settle ${reason}`) },
    }
    const usageLimit = { kind: "api_error", message: "usage limit", recovery: { kind: "at", atMs: NOW + 60_000 } } satisfies AgentFailureReason
    const clock = fakeClock()
    const recovery = policy(clock, { capacity, sleep: async (ms, sleepSignal) => { steps.push("sleep"); await clock.sleep(ms, sleepSignal) } })
    const runs = [result(usageLimit), completed]
    await runWithResilience(async () => { steps.push("run"); return runs.shift()! }, { recover: recovery.recover, settle: recovery.settle })
    expect(steps).toEqual(["run", "arm 60000", "sleep", "run", "settle continued"])

    for (const [end, reason] of [["cut", "interrupted"], ["message", "message"], ["cancel", "cancelled"]] as const) {
      steps.length = 0
      const held = fakeClock()
      held.holdNextSleep()
      const controller = new AbortController()
      const waiting = policy(held, { capacity, now: held.now, sleep: held.sleep })
      const pending = waiting.recover(usageLimit, 0, controller.signal)
      await Bun.sleep(0)
      if (end === "cut") expect(waiting.cutWait("person")).toBe(true)
      else if (end === "message") expect(waiting.continueNow()).toBe(true)
      else controller.abort()
      await pending
      expect(steps).toEqual(["arm 60000", `withdraw ${reason}`])
    }

    // An arm whose answer from the account never comes, such as one a lost
    // transport carried, delays neither the wait's time nor any other end.
    const unanswered: CapacityWaitAuthority = { arm: () => new Promise(() => {}), withdraw: async () => {}, settle: async () => {} }
    for (const end of ["time", "cut", "message", "cancel"] as const) {
      const controller = new AbortController()
      const waitClock = fakeClock()
      if (end !== "time") waitClock.holdNextSleep()
      const waiting = policy(waitClock, { capacity: unanswered })
      const pending = waiting.recover(usageLimit, 0, controller.signal)
      await Bun.sleep(0)
      if (end === "cut") expect(waiting.cutWait("person")).toBe(true)
      else if (end === "message") expect(waiting.continueNow()).toBe(true)
      else if (end === "cancel") controller.abort()
      expect(await pending).toEqual({})
      if (end === "time") expect(waitClock.now()).toBe(NOW + 60_000)
    }

    // Nor does it delay the end of the run that continued: the ledger
    // applies the run's withdrawal after the arm, and the run does not wait for it.
    const ctx = createSupervisorTestContext()
    const reader = asAsyncEventReadSurface(ctx.store)
    const ledger = registerCapacityWaits(reader, { reader, writer: ctx.runtime.runSync(EventStoreWriterService), recordWake: () => new Promise(() => {}) })
    try {
      const continuing = policy(fakeClock(), { capacity: capacityWaitAuthority(reader, { target: { kind: "workflow-agent", sessionId: "workflow" } }) })
      const continuedRuns = [result(usageLimit), completed]
      const settled = await runWithResilience(async () => continuedRuns.shift()!, { recover: continuing.recover, settle: continuing.settle })
      expect(settled.terminal.kind).toBe("completed")
    } finally {
      ledger.dispose()
      await disposeSupervisorTestContext(ctx)
    }
  })

  it("ends a capacity wait at once when a delivery accepts a person's message, and leaves it waiting for a message of another session", async () => {
    const withdrawn: string[] = []
    const clock = fakeClock()
    clock.holdNextSleep()
    const recovery = policy(clock, { capacity: { arm: async () => {}, withdraw: async (reason) => { withdrawn.push(reason) }, settle: async () => {} } })
    const held: DeliveryOutcome = { status: "held", reason: "no_reader" }
    const deliver = endingCapacityWaitOnPersonMessage(recovery, async (_message: { readonly producer?: { readonly kind: string } }, _decide: undefined) => held)
    const waiting = recovery.recover({ kind: "api_error", message: "usage limit", recovery: { kind: "at", atMs: NOW + HOUR } }, 0, signal)
    await Bun.sleep(0)
    expect(await deliver({ producer: { kind: "session" } }, undefined)).toEqual(held)
    expect(withdrawn).toEqual([])
    expect(await deliver({}, undefined)).toEqual({ status: "delivered", startsTurn: true })
    await waiting
    expect(withdrawn).toEqual(["message"])
  })

  it("lets a chat's failures other than spent capacity stand at once and unrecorded, and waits for capacity", async () => {
    captureRecords()
    const clock = fakeClock()
    const chat = createUnattendedRecovery({ sessionId: "chat", runId: "conversation", caller: "chat", agentName: "Chat", onNotice: () => {}, now: clock.now, sleep: clock.sleep })
    for (const failure of [
      disconnect,
      { kind: "api_overloaded", message: "overloaded" },
      { kind: "api_error", message: "connection lost", recovery: { kind: "retry" } },
      { kind: "model_unavailable", message: "access pending", missing: "access" },
    ] satisfies AgentFailureReason[]) {
      expect(await chat.recover(failure, 0, signal)).toBeNull()
    }
    expect(clock.slept).toEqual([])
    expect(recoveryRecords()).toEqual([])
    expect(await chat.recover({ kind: "api_error", message: "usage limit", recovery: { kind: "at", atMs: NOW + 60_000 } }, 0, signal)).toEqual({})
    expect(clock.slept).toEqual([60_000])
  })

  it("runs again after pauses of 5, 10, 20, 40, 80, and 160 seconds while no request is served, then lets the seventh failure stand", async () => {
    captureRecords()
    const clock = fakeClock()
    const recovery = policy(clock)
    let runs = 0
    const settled = await runWithResilience(async () => {
      runs += 1
      return result(disconnect)
    }, { recover: recovery.recover, originalProviderSessionKey: "conversation" })

    expect(settled.terminal.kind).toBe("transient_disconnect")
    expect(runs).toBe(7)
    expect(clock.slept).toEqual(PAUSES)
    expect(recoveryRecords()).toEqual([
      ...PAUSES.map((delayMs, index) => record({ decision: "restart", failure: "transient_disconnect", streak: index + 1, delayMs, served: 0 })),
      record({ decision: "fail", failure: "transient_disconnect", streak: 7, served: 0 }),
    ])
  })

  it("starts the count over after a run that served a request", async () => {
    const clock = fakeClock()
    const recovery = policy(clock)
    for (let failures = 0; failures < 5; failures += 1) await recovery.recover(disconnect, 0, signal)
    clock.slept.length = 0
    expect(await recovery.recover(disconnect, 3, signal)).toEqual({})
    expect(clock.slept).toEqual([5_000])
  })

  it("starts the count over before a capacity wait of a run that served a request", async () => {
    const clock = fakeClock()
    const recovery = policy(clock)
    for (let failures = 0; failures < 5; failures += 1) await recovery.recover(disconnect, 0, signal)
    await recovery.recover({ kind: "api_error", message: "usage limit", recovery: { kind: "at", atMs: clock.now() + 60_000 } }, 2, signal)
    clock.slept.length = 0
    await recovery.recover(disconnect, 0, signal)
    expect(clock.slept).toEqual([5_000])
  })

  it("ends a pause, a capacity wait, and an access wait at once when the run's signal aborts, and the run settles aborted", async () => {
    const awaitAccessSettled = (accessSignal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      accessSignal.addEventListener("abort", () => { reject(accessSignal.reason) }, { once: true })
    })
    for (const failure of [
      disconnect,
      { kind: "api_error", message: "usage limit", recovery: { kind: "at", atMs: NOW + HOUR } },
      { kind: "model_unavailable", message: "access pending", missing: "access" },
    ] satisfies AgentFailureReason[]) {
      const clock = fakeClock()
      const recovery = policy(clock, { awaitAccessSettled })
      const controller = new AbortController()
      clock.holdNextSleep()
      let runs = 0
      const turn = runWithResilience(async () => {
        runs += 1
        return result(failure)
      }, { recover: recovery.recover, signal: controller.signal })
      await Bun.sleep(0)
      controller.abort()
      expect((await turn).terminal.kind).toBe("aborted")
      expect(runs).toBe(1)
    }
  })

  it("waits for the access audit to settle, uncounted, then takes the counted rule, also when the settlement fails", async () => {
    for (const outcome of ["settles", "fails"] as const) {
      const clock = fakeClock()
      const settlement = Promise.withResolvers<void>()
      const recovery = policy(clock, {
        awaitAccessSettled: () => settlement.promise,
        // The wait's time never ends it here: only the settlement does.
        sleep: (ms, sleepSignal) => ms === WAIT_LIMIT_MS
          ? new Promise((resolve) => { sleepSignal.addEventListener("abort", () => { resolve() }, { once: true }) })
          : clock.sleep(ms, sleepSignal),
      })
      const pending = recovery.recover({ kind: "model_unavailable", message: "access pending", missing: "access" }, 0, signal)
      await Bun.sleep(0)
      expect(clock.slept).toEqual([])
      if (outcome === "settles") settlement.resolve()
      else settlement.reject(new Error("audit failed"))
      expect(await pending).toEqual({})
      expect(clock.slept).toEqual([5_000])
    }
  })

  it("restarts after a stall with its continuation, a disconnect, an overload, or a walk with no time to wait for, and lets a failure that needs a person or that a limit ended stand", async () => {
    for (const failure of [
      { kind: "transient_disconnect", message: "socket closed" },
      { kind: "api_overloaded", message: "overloaded" },
      { kind: "api_error", message: "connection lost on every provider", recovery: { kind: "retry" } },
    ] satisfies AgentFailureReason[]) {
      expect(await policy(fakeClock()).recover(failure, 0, signal)).toEqual({})
    }
    const stalled = await policy(fakeClock()).recover({ kind: "stream_stalled", message: "no progress for 300 s", attribution: { kind: "unattributed" } }, 0, signal)
    expect(stalled?.requestContext).toStartWith("Your previous response stalled")
    for (const failure of [
      { kind: "api_error", message: "the account does not grant the model", recovery: { kind: "none" } },
      toFailureReason(fromStreamError(classifyResponseFailed({ code: "cyber_policy", message: "This content was flagged for possible cybersecurity risk." }, undefined))),
      { kind: "context_overflow" },
      { kind: "output_overflow" },
      { kind: "model_unavailable", message: "unknown model", missing: "offering" },
      { kind: "model_unavailable", message: "no provider", missing: "provider" },
    ] satisfies AgentFailureReason[]) {
      const clock = fakeClock()
      expect(await policy(clock).recover(failure, 0, signal)).toBeNull()
      expect(clock.slept).toEqual([])
    }
  })

  it("shows a pause as a recovery from a provider fault, and an interrupt ends the pause so that the next run opens interrupted", async () => {
    captureRecords()
    const clock = fakeClock()
    const notices: SessionNoticeOperation[] = []
    const recovery = policy(clock, { onNotice: (operation) => { notices.push(operation) } })
    clock.holdNextSleep()
    const waiting = recovery.recover(disconnect, 0, signal)
    await Promise.resolve()
    expect(notices[0]).toMatchObject({ type: "upsert", notice: { id: "unattended:wait:attempt", severity: "warning", title: "Recovering from a provider fault", retry: { count: 1, delayMs: 5_000, nextAttemptAt: NOW + 5_000 } } })
    expect(notices[0]?.type === "upsert" ? notices[0].notice.action : "absent").toBeUndefined()
    expect(recovery.cutWait("person")).toBe(true)
    expect(await waiting).toEqual({})
    expect(notices.at(-1)).toEqual({ type: "resolve", id: "unattended:wait:attempt" })
    expect(recovery.takeCutInterrupt()).toBe("person")
    expect(recovery.takeCutInterrupt()).toBeUndefined()
    expect(recovery.cutWait("person")).toBe(false)
    expect(recoveryRecords().at(-1)).toEqual(record({ decision: "interrupted", failure: "transient_disconnect", streak: 1, served: 0 }))
  })

  it("holds the caller's liveness for the length of every wait", async () => {
    const holds: string[] = []
    const clock = fakeClock()
    const recovery = policy(clock, {
      holdAlive: () => { holds.push("held"); return () => { holds.push("released") } },
      awaitAccessSettled: async () => { holds.push("access") },
      sleep: async (ms, sleepSignal) => { holds.push("sleep"); await clock.sleep(ms, sleepSignal) },
    })
    await recovery.recover(disconnect, 0, signal)
    await recovery.recover({ kind: "api_error", message: "usage limit", recovery: { kind: "at", atMs: clock.now() + 60_000 } }, 0, signal)
    await recovery.recover({ kind: "model_unavailable", message: "access pending", missing: "access" }, 0, signal)
    // Every timer of a wait runs inside its hold.
    expect(holds.filter((step) => step !== "sleep")).toEqual([
      "held", "released",
      "held", "released",
      "held", "access", "released", "held", "released",
    ])
    expect(holds.slice(0, 2)).toEqual(["held", "sleep"])
  })

  it("lets a walk whose only route cannot start fail at once, since only a person can repair its program", async () => {
    const clock = fakeClock()
    const recovery = policy(clock)
    const client = chain({ candidates: ["openai_api"], availability: fakeAvailability({}).availability })
    const cannotStart = normalizeProviderAttemptFailure(new RouteUnavailableError("The Claude engine cannot start.")).failure
    if (cannotStart._tag !== "RouteUnavailableFailure") throw new Error("expected a route that cannot run")
    let runs = 0
    const settled = await runWithResilience(async () => {
      runs += 1
      const failure = await (await client.admitRequest()).run({ prepare: preparedRequest, execute: async () => ({ kind: "provider_failure", failure: cannotStart }) }).then(
        () => { throw new Error("the route must not serve") },
        (error: unknown) => toFailureReason(fromStreamError(error)),
      )
      return result(failure)
    }, { recover: recovery.recover })

    expect(settled.terminal).toMatchObject({ kind: "api_error", recovery: { kind: "none" } })
    expect(runs).toBe(1)
    expect(clock.slept).toEqual([])
  })
})
