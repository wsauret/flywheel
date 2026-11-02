import { afterEach, describe, expect, test } from "bun:test"
import type { ProjectStateResult } from "../../../../src/orchestration/app-service/project-state-protocol.js"
import { fixture, servedAfter, settle, STABLE_LIFETIME_MS } from "./_executor-generations-fixture.js"
import { closeFixtures, fixture as stateFixture } from "./_project-state-worker-fixture.js"
import { claimProjectServing, projectServingPids } from "../../../../src/orchestration/app-service/project-serving-lane.js"
import { createAccountProjectRegistry } from "../../../../src/orchestration/app-service/account-project-registry.js"
import { createReplacementHandoffs } from "../../../../src/orchestration/app-service/replacement-handoffs.js"
import { ContainedDirectory } from "../../../../src/infra/descriptor-directory.js"
import { acquireLockSyncIn, releaseLockIn } from "../../../../src/infra/ownership-file-lock.js"
import { executionAskerOf } from "../../../../src/orchestration/app-service/project-executor-generations.js"

afterEach(closeFixtures)

/** What became of one input: the generation that served it, or its refusal. */
interface InputOutcome {
  served?: number
  refused?: unknown
}

/** One recovery write result, what the log keeps of it, and the cause a person reads. */
interface RecoveryFailureCase {
  readonly result: ProjectStateResult
  readonly logged: string
  readonly cause: string | undefined
}

describe("executor generations", () => {
  test("repeated early deaths back off from one second, doubling to thirty, and input is delayed, never refused", async () => {
    const f = fixture()
    const waits: number[] = []
    for (let death = 0; death < 7; death++) {
      f.latest().die("stopped by signal SIGKILL")
      await settle()
      waits.push(await servedAfter(f))
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    expect(f.executors).toHaveLength(8)
  })

  test("each restart records once, when it is decided, with the backoff it waits", async () => {
    const f = fixture()
    for (let death = 0; death < 3; death++) {
      f.latest().die("stopped by signal SIGKILL")
      await settle()
      await servedAfter(f)
    }
    expect(f.records.filter(([, message]) => message.startsWith("executor restart"))).toEqual([1_000, 2_000, 4_000].map((delayMs, index) =>
      ["info", "executor restarting", { after: index + 1, cause: "stopped by signal SIGKILL", earlyDeaths: index + 1, delayMs }]))
  })

  test("a generation reads as ending from the moment it begins to end, before its closure settles", async () => {
    const f = fixture()
    await settle()
    const first = f.latest()
    first.beginEnding("stopped by signal SIGKILL")
    // Paused at once: nothing serves through a generation that is ending.
    expect(f.generations.current.recovery).toBeDefined()
    expect(f.writes).toEqual([])
    first.close({ settled: true, cause: "stopped by signal SIGKILL" })
    await settle()
    expect(f.writes).toEqual(["generation.close:1", "generation.recover:1"])
  })

  test("the notice shows only while a restart is scheduled, until its generation reports ready, and a stable generation ends the count", async () => {
    const f = fixture({ readyAtOnce: false })
    f.latest().ready()
    await settle()
    // One early death that recovers is invisible.
    f.latest().die("stopped by signal SIGKILL")
    await settle()
    const first = f.generations.serving("person")
    await f.clock.advance(1_000)
    f.latest().ready()
    await first
    await settle()
    expect(f.published).toEqual([])
    // The second early death with no input waiting is not a restart yet.
    f.latest().die("exited with code 1")
    await settle()
    expect(f.generations.state).toEqual({ kind: "serving" })
    // Input schedules the restart, and the notice names the recorded cause.
    let served = false
    const second = f.generations.serving("person").then((generation) => { served = true; return generation })
    await settle()
    // The streak began with the first early death, at the start of the clock.
    expect(f.generations.state).toEqual({ kind: "restarting", since: 0, cause: "exited with code 1" })
    await f.clock.advance(2_000)
    // The restarted generation is not ready yet, so the input waits and the notice stays.
    expect(f.executors).toHaveLength(3)
    expect(served).toBe(false)
    expect(f.generations.state.kind).toBe("restarting")
    f.latest().ready()
    expect(await second).toBe(f.generations.current)
    expect(f.generations.state).toEqual({ kind: "serving" })
    // The count is kept until a generation lives the stable lifetime, so the
    // next early death with a restart scheduled raises the notice again at once.
    f.latest().die("stopped by signal SIGKILL")
    await settle()
    const third = f.generations.serving("person")
    await settle()
    expect(f.generations.state).toEqual({ kind: "restarting", since: 0, cause: "stopped by signal SIGKILL" })
    await f.clock.advance(4_000)
    f.latest().ready()
    await third
    await f.clock.advance(STABLE_LIFETIME_MS)
    expect(f.published.at(-1)).toEqual({ kind: "serving" })
    // A generation that lived that long does not count: it comes back at once.
    f.latest().die("stopped by signal SIGKILL")
    await settle()
    const fourth = f.generations.serving("person")
    await settle()
    expect(f.executors).toHaveLength(5)
    f.latest().ready()
    expect((await fourth).generation).toBe(5)
  })

  test("the stable lifetime counts from ready, so a slow opening never clears the notice or resets the backoff", async () => {
    const f = fixture({ readyAtOnce: false })
    f.latest().ready()
    await settle()
    f.latest().die("stopped by signal SIGKILL")
    await settle()
    const input = f.generations.serving("person")
    await f.clock.advance(1_000)
    expect(f.executors).toHaveLength(2)
    // The restarted generation opens for longer than the stable lifetime and
    // dies before it reports ready: an early death all the same.
    await f.clock.advance(STABLE_LIFETIME_MS + 1_000)
    f.latest().die("could not start")
    await settle()
    expect(f.generations.state).toEqual({ kind: "restarting", since: 0, cause: "could not start" })
    await f.clock.advance(1_999)
    expect(f.executors).toHaveLength(2)
    await f.clock.advance(1)
    expect(f.executors).toHaveLength(3)
    // The next one reports ready after another slow opening and dies thirty
    // seconds later, which is still an early death.
    await f.clock.advance(STABLE_LIFETIME_MS)
    f.latest().ready()
    await input
    await f.clock.advance(30_000)
    f.latest().die("exited with code 1")
    await settle()
    const next = f.generations.serving("person")
    await settle()
    expect(f.generations.state).toEqual({ kind: "restarting", since: 0, cause: "exited with code 1" })
    await f.clock.advance(3_999)
    expect(f.executors).toHaveLength(3)
    await f.clock.advance(1)
    expect(f.executors).toHaveLength(4)
    f.latest().ready()
    await next
  })

  test("a generation that dies before it reports ready keeps the input waiting, and the next ready generation serves it", async () => {
    const f = fixture({ readyAtOnce: false })
    f.latest().ready()
    await settle()
    f.latest().die("stopped by signal SIGKILL")
    await settle()
    const input: InputOutcome = {}
    void f.generations.serving("person").then((generation) => { input.served = generation.generation }, (error: unknown) => { input.refused = error })
    await f.clock.advance(1_000)
    expect(f.executors).toHaveLength(2)
    // The restarted generation dies while it opens. The restart stays
    // scheduled: that generation is recovered, and the next one starts after
    // the next backoff step. Its startup error reaches no input.
    f.latest().die("could not start")
    await settle()
    expect(f.generations.restartScheduled).toBe(true)
    expect(f.writes).toEqual(["generation.close:1", "generation.recover:1", "generation.close:2", "generation.recover:2"])
    await f.clock.advance(1_999)
    expect(f.executors).toHaveLength(2)
    await f.clock.advance(1)
    expect(f.executors).toHaveLength(3)
    expect(input).toEqual({})
    // Other work joins the same restart instead of being refused.
    const other = f.generations.serving()
    f.latest().ready()
    expect((await other).generation).toBe(3)
    expect(input).toEqual({ served: 3 })
    expect(f.generations.restartScheduled).toBe(false)
  })

  test("a generation that dies before it reports ready publishes no cleared notice before the next one starts", async () => {
    const f = fixture({ readyAtOnce: false })
    f.latest().ready()
    await settle()
    f.latest().die("stopped by signal SIGKILL")
    await settle()
    const first = f.generations.serving("person")
    await f.clock.advance(1_000)
    f.latest().ready()
    await first
    f.latest().die("exited with code 1")
    await settle()
    const input = f.generations.serving("person")
    await f.clock.advance(2_000)
    expect(f.executors).toHaveLength(3)
    f.latest().die("could not start")
    await settle()
    await f.clock.advance(4_000)
    expect(f.executors).toHaveLength(4)
    // The notice changed its cause, and never cleared between the death and the next start.
    expect(f.published).toEqual([
      { kind: "restarting", since: 0, cause: "exited with code 1" },
      { kind: "restarting", since: 0, cause: "could not start" },
    ])
    f.latest().ready()
    await input
    expect(f.published.at(-1)).toEqual({ kind: "serving" })
    expect(f.published).toHaveLength(3)
  })

  test("a generation that reports ready proves the build, one that ends before ready counts against it, and an end during the close counts nothing", async () => {
    const f = fixture({ readyAtOnce: false })
    f.latest().die("could not start")
    await settle()
    void f.generations.serving("person").catch(() => {})
    await f.clock.advance(1_000)
    f.latest().ready()
    await settle()
    // An end after ready is the executor's crash, never a failed open.
    f.latest().die("stopped by signal SIGKILL")
    await settle()
    void f.generations.serving("person").catch(() => {})
    await f.clock.advance(2_000)
    // The close stops the generation that is opening, which the account asked for.
    await f.generations.close()

    expect(f.proofs).toEqual(["failed to open", "ready"])
  })

  test("an end before ready that the executor did not cause, such as a lost guardian, never counts against the build, and a wedge the account proved does", async () => {
    const f = fixture({ readyAtOnce: false })
    f.latest().die("lost its process guardian", false)
    await settle()
    void f.generations.serving("person").catch(() => {})
    await f.clock.advance(1_000)
    f.latest().wedge(31_000)
    await settle()

    expect(f.latest().ends()).toMatchObject([{ cause: "could not start" }])
    expect(f.proofs).toEqual(["failed to open"])
  })

  test("a crash loop never holds a planned replacement, while a recovery that runs does", async () => {
    const f = fixture({ readyAtOnce: false })
    // The first generation is still opening, below the crash-loop threshold.
    expect(f.generations.replacementHold()).toBe("opening")
    f.latest().ready()
    await settle()
    expect(f.generations.replacementHold()).toBe("live")
    f.latest().beginEnding("stopped by signal SIGKILL")
    expect(f.generations.replacementHold()).toBe("recovery")
    f.latest().close({ settled: true, cause: "stopped by signal SIGKILL" })
    await settle()
    // Recovered and paused, with no input waiting: nothing is held.
    expect(f.generations.replacementHold()).toBeUndefined()
    const first = f.generations.serving("person")
    await settle()
    // One early death: input waiting out the backoff is an opening.
    expect(f.generations.replacementHold()).toBe("opening")
    await f.clock.advance(1_000)
    expect(f.generations.replacementHold()).toBe("opening")
    f.latest().ready()
    await first
    f.latest().die("exited with code 1")
    await settle()
    const second = f.generations.serving("person")
    await settle()
    // Two early deaths: neither the scheduled restart nor the generation it
    // starts holds a replacement.
    expect(f.generations.replacementHold()).toBeUndefined()
    await f.clock.advance(2_000)
    expect(f.executors).toHaveLength(3)
    expect(f.generations.replacementHold()).toBeUndefined()
    // The replacement proceeds: the close ends the opening generation, and
    // the waiting input hears that the project is closing.
    await f.generations.close()
    await expect(second).rejects.toThrow("This project is closing.")
  })

  test("each recovery failure class states its own cause in the user's terms, and one with no known cause states none", async () => {
    const cases: readonly RecoveryFailureCase[] = [
      { result: { kind: "failed", error: new Error("SQLITE_BUSY: database is locked") }, logged: "SQLITE_BUSY", cause: "the project's saved state could not be written" },
      { result: { kind: "refused", reason: "stale-generation" }, logged: "stale-generation", cause: undefined },
    ]
    for (const { result, logged, cause } of cases) {
      let reports = 0
      const f = fixture({ reportFault: async () => ({ kind: "sent", reportId: String(++reports) }), execution: async ({ kind }) => kind === "generation.recover" ? result : { kind: "ok" } })
      f.latest().die("stopped by signal SIGKILL")
      await settle()
      const refusal = await f.generations.serving("person").then(() => undefined, (error: unknown) => error)
      if (!(refusal instanceof Error)) throw new Error(`${logged} was not refused`)
      expect(f.generations.state).toEqual({ kind: "recovery_failed", report: { kind: "sent", reportId: "1" }, ...(cause === undefined ? {} : { cause }) })
      expect(reports).toBe(1)
      expect(refusal.message).toBe(`Flywheel could not restore this project's sessions.${cause === undefined ? "" : ` Cause: ${cause}.`}`)
      // The internal error reaches the log, never the person.
      expect(refusal.message).not.toContain(logged)
      expect(f.errors.some((record) => record.includes(logged))).toBe(true)
    }
  })

  test("an unsettled closure asks for fresh proof before a retry, and the next explicit input then acquires a generation", async () => {
    const f = fixture()
    const first = f.latest()
    first.proveNext({ settled: false, reason: "container 42 did not settle within 5000ms" }, { settled: true })
    first.beginEnding("stopped by signal SIGKILL")
    first.close({ settled: false, reason: "container 42 did not settle within 5000ms", cause: "stopped by signal SIGKILL" })
    await settle()
    expect(f.generations.state).toEqual({ kind: "recovery_failed", cause: "some commands it started did not stop" })
    expect(f.writes).toEqual([])
    // The container is still there on the next proof, so input is refused in the user's terms.
    await expect(f.generations.serving("person")).rejects.toThrow("Cause: some commands it started did not stop.")
    // The container has proved empty now; the next input recovers and acquires.
    expect(await servedAfter(f)).toBe(1_000)
    expect(f.writes).toEqual(["generation.close:1", "generation.recover:1"])
    expect(f.generations.current.generation).toBe(2)
    expect(f.generations.state).toEqual({ kind: "serving" })
  })

  test("other work waits for a scheduled restart instead of being refused, and never schedules one", async () => {
    const f = fixture()
    f.latest().die("stopped by signal SIGKILL")
    await settle()
    // Nothing scheduled: other work hears the condition in plain words that ask for nothing.
    await expect(f.generations.serving(executionAskerOf({ type: "session.delete", sessionId: "unused", inactiveBefore: 1 }))).rejects.toThrow("Flywheel's process for this project is not running now.")
    expect(f.generations.restartScheduled).toBe(false)
    const input = f.generations.serving(executionAskerOf({ type: "session.delete", sessionId: "unused" }))
    const other = f.generations.serving()
    const concurrent = f.generations.serving("person")
    expect(f.generations.restartScheduled).toBe(true)
    expect(other).toBe(input)
    expect(concurrent).toBe(input)
    await f.clock.advance(1_000)
    expect(await other).toBe(f.generations.current)
    expect(f.generations.restartScheduled).toBe(false)
    expect(f.executors).toHaveLength(2)
  })

  test("a generation proven wedged while it opens ends as one that could not start, an early death whose restart waits the first backoff step", async () => {
    const f = fixture({ readyAtOnce: false })
    await settle()
    f.latest().wedge(31_000)
    await settle()
    expect(f.latest().ends()).toEqual([{ cause: "could not start", detail: { silentMs: 31_000, missedPeriods: 30, waitedBy: ["start"], interruptedSessionIds: [] } }])
    expect(f.writes).toEqual(["generation.close:1", "generation.recover:1"])
    const input = f.generations.serving("person")
    await f.clock.advance(999)
    expect(f.executors).toHaveLength(1)
    await f.clock.advance(1)
    f.latest().ready()
    expect((await input).generation).toBe(2)
  })

  test("while a replacement is requested, every ready generation proven wedged is ended, one a restart starts too; with none requested, the proof ends nothing", async () => {
    let requested = false
    const f = fixture({ replacementRequested: () => requested })
    await settle()
    f.latest().wedge(31_000)
    await settle()
    expect(f.latest().ends()).toEqual([])
    requested = true
    f.latest().wedge(32_000)
    await settle()
    expect(f.latest().ends()).toEqual([{ cause: "stopped answering, so Flywheel ended it", detail: { silentMs: 32_000, missedPeriods: 30, waitedBy: ["replacement"], interruptedSessionIds: [] } }])
    // The request covers the next generation with no registration of its own.
    expect(await servedAfter(f)).toBe(1_000)
    f.latest().wedge(31_000)
    await settle()
    expect(f.latest().ends()).toMatchObject([{ cause: "stopped answering, so Flywheel ended it", detail: { waitedBy: ["replacement"] } }])
    expect(f.writes).toEqual(["generation.close:1", "generation.recover:1", "generation.close:2", "generation.recover:2"])
  })

  test("while a replacement is requested, an open tab's or the runtime's ask after an end schedules nothing, so other work is answered at once and nothing is held until the close answers the ask", async () => {
    const f = fixture({ replacementRequested: () => true })
    await settle()
    f.latest().wedge(31_000)
    await settle()
    expect(f.latest().ends()).toMatchObject([{ cause: "stopped answering, so Flywheel ended it", detail: { waitedBy: ["replacement"] } }])
    // The successor opens the project, so the retiring service starts nothing for them.
    const reattach = f.generations.serving("surface")
    const continuation = f.generations.serving("runtime")
    void Promise.allSettled([reattach, continuation])
    // Nothing is scheduled, so a query is answered as in any paused project.
    expect(f.generations.restartScheduled).toBe(false)
    await expect(f.generations.serving()).rejects.toThrow("Flywheel's process for this project is not running now.")
    await expect(f.generations.serving(executionAskerOf({ type: "session.delete", sessionId: "unused", inactiveBefore: 1 }))).rejects.toThrow("Flywheel's process for this project is not running now.")
    await f.clock.advance(STABLE_LIFETIME_MS)
    expect(f.executors).toHaveLength(1)
    expect(f.generations.replacementHold()).toBeUndefined()
    await f.generations.close()
    await expect(reattach).rejects.toThrow("This project is closing.")
    await expect(continuation).rejects.toThrow("This project is closing.")
  })

  test("while a replacement is requested, a person's own input after an end restarts the executor, which an open tab's waiting ask joins", async () => {
    const f = fixture({ replacementRequested: () => true })
    await settle()
    f.latest().wedge(31_000)
    await settle()
    let reattached: number | undefined
    void f.generations.serving("surface").then((generation) => { reattached = generation.generation })
    await f.clock.advance(STABLE_LIFETIME_MS)
    // Nothing refuses the person's message: the replacement waits for its
    // opening, then cuts its work for the successor to continue.
    const message = f.generations.serving("person")
    expect(f.generations.replacementHold()).toBe("opening")
    expect((await message).generation).toBe(2)
    await settle()
    expect(reattached).toBe(2)
    expect(f.generations.replacementHold()).toBe("live")
  })

  test("one proof while a person's interrupt and a requested replacement wait ends the generation once, and its recovery records the interrupt", async () => {
    const f = fixture({ replacementRequested: () => true })
    await settle()
    const ended = f.generations.endIfWedged({ signal: new AbortController().signal, waiter: { kind: "interrupt", sessionId: "one" } })
    await settle()
    expect(f.writes).toEqual([])
    f.latest().wedge(31_000)
    await ended
    f.latest().wedge(32_000)
    await settle()
    expect(f.latest().ends()).toEqual([{ cause: "stopped answering, so Flywheel ended it", detail: { silentMs: 31_000, missedPeriods: 30, waitedBy: ["interrupt", "replacement"], interruptedSessionIds: ["one"] } }])
    expect(f.writes).toEqual(["generation.close:1", "generation.recover:1:one"])
  })

  test("a successor's continuation waits on every generation that serves while it lasts, and once withdrawn it holds nothing", async () => {
    const f = fixture({ readyAtOnce: false })
    await settle()
    // The duty opens the project and hands off at once, so the continuation
    // waits while the first generation still opens.
    const withdraw = new AbortController()
    let answered = 0
    void f.generations.endIfWedged({ signal: withdraw.signal, waiter: { kind: "continuation" } }).then(() => { answered += 1 })
    const serving = f.generations.serving("person")
    f.latest().wedge(31_000)
    await settle()
    expect(f.latest().ends()).toEqual([{ cause: "could not start", detail: { silentMs: 31_000, missedPeriods: 30, waitedBy: ["start", "continuation"], interruptedSessionIds: [] } }])
    expect(answered).toBe(1)
    // The call goes on to the generation the restart starts, and still waits on it.
    await f.clock.advance(1_000)
    f.latest().ready()
    expect((await serving).generation).toBe(2)
    f.latest().wedge(32_000)
    await settle()
    expect(f.latest().ends()).toEqual([{ cause: "stopped answering, so Flywheel ended it", detail: { silentMs: 32_000, missedPeriods: 30, waitedBy: ["continuation"], interruptedSessionIds: [] } }])
    withdraw.abort()
    const next = f.generations.serving("person")
    await f.clock.advance(2_000)
    f.latest().ready()
    expect((await next).generation).toBe(3)
    f.latest().wedge(33_000)
    await settle()
    expect(f.latest().ends()).toEqual([])
    expect(f.writes).toEqual(["generation.close:1", "generation.recover:1", "generation.close:2", "generation.recover:2"])
  })

  test("an interrupt sent while a restart is scheduled escalates when the generation that restart starts is wedged", async () => {
    const f = fixture()
    f.latest().die("stopped by signal SIGKILL")
    await settle()
    const input = f.generations.serving("person")
    let ended = false
    void f.generations.endIfWedged({ signal: new AbortController().signal, waiter: { kind: "interrupt", sessionId: "one" } }).then(() => { ended = true })
    await f.clock.advance(1_000)
    expect((await input).generation).toBe(2)
    // The ended generation is not what the interrupt reaches; its silence proves nothing.
    f.executors[0]!.wedge(31_000)
    await settle()
    expect(ended).toBe(false)
    f.latest().wedge(31_000)
    await settle()
    expect(ended).toBe(true)
    expect(f.latest().ends()).toMatchObject([{ cause: "stopped answering, so Flywheel ended it", detail: { waitedBy: ["interrupt"] } }])
    expect(f.writes).toEqual(["generation.close:1", "generation.recover:1", "generation.close:2", "generation.recover:2:one"])
  })

  test("one proof while two interrupts wait marks both sessions, and an interrupt that waits after the end marks nothing", async () => {
    const recovered = Promise.withResolvers<ProjectStateResult>()
    const writes: string[] = []
    const f = fixture({ execution: async (operation) => {
      writes.push(`${operation.kind}:${operation.generation}${operation.kind === "generation.recover" ? `:${operation.interruptedSessionIds.join(",")}` : ""}`)
      return operation.kind === "generation.recover" ? recovered.promise : { kind: "ok" }
    } })
    await settle()
    const signal = new AbortController().signal
    const ended = Promise.all([
      f.generations.endIfWedged({ signal, waiter: { kind: "interrupt", sessionId: "one" } }),
      f.generations.endIfWedged({ signal, waiter: { kind: "interrupt", sessionId: "two" } }),
    ])
    await settle()
    f.latest().wedge(31_000)
    await settle()
    expect(writes).toEqual(["generation.close:1", "generation.recover:1:one,two"])
    expect(f.latest().ends()).toMatchObject([{ detail: { waitedBy: ["interrupt"], interruptedSessionIds: ["one", "two"] } }])
    // The generation has ended; a later interrupt finds no generation serving,
    // so it ends nothing and names nothing; its own dispatch is answered by the end.
    let late = false
    void f.generations.endIfWedged({ signal, waiter: { kind: "interrupt", sessionId: "three" } }).then(() => { late = true })
    recovered.resolve({ kind: "ok" })
    await ended
    await settle()
    expect(late).toBe(false)
    expect(writes).toEqual(["generation.close:1", "generation.recover:1:one,two"])
    expect([...f.generations.current.interruptedSessionIds]).toEqual(["one", "two"])
  })

  test("a close waits for the stop and hands a stop that did not flush to the recovery that repairs it", async () => {
    const f = fixture({ stopResult: { settled: false, reason: "Executor did not flush gracefully: deadline exceeded" } })
    await settle()
    await f.generations.close()
    expect(f.latest().stops()).toBe(1)
    expect(f.writes).toEqual(["generation.close:1", "generation.recover:1"])
    expect(f.errors).toEqual([`executor stop did not settle; recovery repaired its generation ${JSON.stringify({ generation: 1, reason: "Executor did not flush gracefully: deadline exceeded" })}`])
  })

  test("a wedge proof that comes while the close waits for its stop ends nothing", async () => {
    // The executor beats until its stop closes its channels, so a stop that
    // stalls is counted, and a replacement waits on this generation.
    const answered = Promise.withResolvers<void>()
    const f = fixture({ stopAnswer: answered.promise, replacementRequested: () => true })
    await settle()
    const closed = f.generations.close()
    await settle()
    f.latest().wedge(31_000)
    await settle()
    expect(f.latest().ends()).toEqual([])
    answered.resolve()
    await closed
    expect(f.latest().stops()).toBe(1)
    expect(f.latest().ends()).toEqual([])
  })

  test("a close answers the successor rows its generation's stop counted, and nothing for a generation that had already ended", async () => {
    const f = fixture({ stopResult: { settled: true, successorRows: { continuations: 1, handovers: 1 } } })
    await settle()
    expect(await f.generations.close()).toEqual({ continuations: 1, handovers: 1 })

    const crashed = fixture()
    crashed.latest().die("stopped by signal SIGKILL")
    await settle()
    expect(await crashed.generations.close()).toBeUndefined()
  })

  test("only a settled close whose recorded handoff keeps the project leaves recovery to its successor, behind the write fence", async () => {
    for (const retained of [true, false]) for (const exclusive of [true, false]) {
      const rows = { continuations: 1, handovers: 0 }
      const seen: unknown[] = []
      const f = fixture({
        stopResult: { settled: true, successorRows: rows },
        handoffRecovery: async (value) => { seen.push(value); return retained },
        releaseForHandoff: async () => exclusive,
      })
      await settle()
      await f.generations.close()
      expect(f.writes).toEqual(retained ? ["generation.close:1"] : ["generation.close:1", "generation.recover:1"])
      await f.generations.finishClose()
      expect(seen).toEqual([rows])
      expect(f.writes).toEqual(retained && exclusive ? ["generation.close:1"] : ["generation.close:1", "generation.recover:1"])
      expect(f.records.filter(([, message]) => message === "executor recovery handed to replacement")).toHaveLength(retained && exclusive ? 1 : 0)
    }
  })

  test("a consumed handoff and a successor crash during flush retain outgoing recovery and its claim", async () => {
    const state = await stateFixture()
    const root = state.directory
    const registry = createAccountProjectRegistry({ userDataRoot: root })
    const outgoing = await claimProjectServing(root, "dev")
    const handoffs = createReplacementHandoffs({
      lane: "dev", registry,
      openProjects: () => new Map(),
      open: async () => { throw new Error("unused") },
      awakeForPhone: () => false,
      holdAwakeForPhone: async () => {},
    })
    try {
      await handoffs.handOff("consumed")
      await handoffs.join(root)
      const f = fixture({
        stopResult: { settled: true, successorRows: { continuations: 1, handovers: 0 } },
        handoffRecovery: (rows) => handoffs.stopped(root, rows),
        releaseForHandoff: () => outgoing.releaseForHandoff(() => handoffs.recoveryPending(root)),
      })
      await settle()
      await f.generations.close()
      expect(f.writes).toEqual(["generation.close:1"])
      const successor = await claimProjectServing(root, "dev", 0)
      expect(successor.exclusive).toBe(false)
      const directory = ContainedDirectory.openExisting(root, [".flywheel"])!
      const gate = acquireLockSyncIn(directory, "project-execution.lock")
      const finished = f.generations.finishClose()
      try {
        await registry.retireReplacementHandoff("dev", "consumed")
        successor()
      } finally {
        releaseLockIn(directory, gate)
        directory.close()
      }
      await finished
      expect(f.writes).toEqual(["generation.close:1", "generation.recover:1"])
      expect(projectServingPids(root, "dev")).toEqual([process.pid])
      expect(f.records.filter(([, message]) => message === "executor recovery handed to replacement")).toEqual([])
    } finally {
      outgoing()
      handoffs.dispose()
      await registry.dispose()
    }
  })

  test("a handoff never skips recovery after an unflushed stop, a wedge, or an executor crash inside a live serve", async () => {
    for (const end of ["unflushed", "wedge", "crash"] as const) {
      let handoffs = 0
      const f = fixture({
        stopResult: { settled: false, reason: "not flushed", successorRows: { continuations: 1, handovers: 0 } },
        replacementRequested: () => true,
        handoffRecovery: async () => { handoffs += 1; return true },
        releaseForHandoff: async () => { throw new Error("unexpected handoff release") },
      })
      await settle()
      if (end === "wedge") {
        const ended = f.generations.endIfWedged({ signal: new AbortController().signal, waiter: { kind: "interrupt", sessionId: "one" } })
        f.latest().wedge(31_000)
        await ended
      } else if (end === "crash") {
        f.latest().die("exited with code 1")
        await settle()
      }
      await f.generations.close()
      await f.generations.finishClose()
      expect(handoffs).toBe(0)
      expect(f.writes).toEqual(["generation.close:1", end === "wedge" ? "generation.recover:1:one" : "generation.recover:1"])
    }
  })

  test("a successor registered before finalization keeps the full pass on the live state owner and retries failure before disposal", async () => {
    const state = await stateFixture()
    const outgoing = await claimProjectServing(state.directory, "dev")
    const successor = await claimProjectServing(state.directory, "dev")
    try {
      const sessionId = await state.manager.createChat({ name: "outgoing live session", initialState: "active" })
      let recoveries = 0
      expect(await state.client.execution({ kind: "generation.admit", projectId: "p", generation: 1 })).toEqual({ kind: "ok" })
      const f = fixture({
        stopResult: { settled: true, successorRows: { continuations: 1, handovers: 0 } },
        handoffRecovery: async () => true,
        releaseForHandoff: () => outgoing.releaseForHandoff(() => true),
        execution: (operation) => {
          if (operation.kind === "generation.recover" && ++recoveries === 1) return Promise.resolve({ kind: "failed", error: new Error("disk full") })
          return state.client.execution({ ...operation, projectId: "p" })
        },
      })
      await settle()
      await f.generations.close()
      expect(await state.manager.read(sessionId)).toMatchObject({ lifecycleState: "active" })
      await expect(f.generations.finishClose()).rejects.toThrow()
      expect(projectServingPids(state.directory, "dev")).toHaveLength(2)
      await f.generations.finishClose()
      expect(recoveries).toBe(2)
      expect(await state.client.sessions.read(sessionId)).toMatchObject({ lifecycleState: "inactive" })
      expect(f.records.filter(([, message]) => message === "executor recovery handed to replacement")).toHaveLength(0)
      await state.client.close()
    } finally {
      successor()
      outgoing()
    }
  })

  test("a close releases input waiting out the backoff, and that input is refused as closing", async () => {
    const f = fixture()
    f.latest().die("stopped by signal SIGKILL")
    await settle()
    const waiting = f.generations.serving("person")
    await settle()
    await f.generations.close()
    await expect(waiting).rejects.toThrow("This project is closing.")
    expect(f.executors).toHaveLength(1)
  })
})
