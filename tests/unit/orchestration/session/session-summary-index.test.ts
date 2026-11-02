import { Database } from "bun:sqlite"
import { describe, expect, spyOn, test, afterEach } from "bun:test"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import * as fs from "node:fs"
import { dbFile, readyBudget, sourceFor, removeIndexDirectories } from "./_summary-index-fixtures.js"
import { CorruptEventRowError, type AsyncEventReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { acquireSessionSummaryIndex } from "../../../../src/orchestration/session/session-summary-index.js"
import { generationStatistics, initialGenerationEvidence, reduceGenerationEvidence } from "../../../../src/orchestration/session/session-generation-statistics.js"
import type { GenerationMeasurement } from "../../../../src/orchestration/session/provider-request-audit-types.js"
import { sessionSummaryFact, usageV4Fact } from "../../../fixtures/session-summary-history.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"

afterEach(removeIndexDirectories)

const recorded = (outputTokens: number, durationMs: number): GenerationMeasurement => ({
  kind: "recorded", basis: "O200kBase", outputTokens, durationMs, measuredBlocks: 1, excludedBlocks: 0,
})

/** The stored summary of one provider stream that measured `generation`. */
function streamSummaryFact(position: number, sessionId: string, generation: GenerationMeasurement): StoredFact {
  return { ...sessionSummaryFact(position, sessionId, "model.stream.summary.recorded", 3, {
    requestId: `request-${position}`, identity: { providerSessionKey: sessionId }, turn: 1, rawEventCount: 2, countsBySource: {}, countsByKind: {},
    interDelta: { count: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 },
    watchdog: { thinkingStallCount: 0 }, recovery: { streamRetryCount: 0, reasoningDisabledRetryCount: 0 }, bigGapTransitions: [], generation,
  }), actor: "flywheel" }
}

interface SummaryIndexRef {
  current?: ReturnType<typeof acquireSessionSummaryIndex>
}

describe("session summary index", () => {
  test("finishes warm reads only after ready data and remains bounded", async () => {
    const file = dbFile()
    const source = sourceFor([usageV4Fact(1, "a", "one")]).source
    await readyBudget(file, [usageV4Fact(1, "a", "one")], "a")
    const log = spyOn(DebugLog, "record").mockImplementation(() => {})
    const index = acquireSessionSummaryIndex(file, source)
    try {
      expect((await index.readImmediate(["a"])).status).toBe("ready")
      expect(log.mock.calls.map(([record]) => record.type)).toEqual(["startup.started", "startup.finished"])
      expect(log.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "ready", stages: { open: { count: 1 }, readPage: { count: 0 } } })
      await index.readImmediate(["a"])
      await index.replay()
      expect(log).toHaveBeenCalledTimes(2)
    } finally {
      await index.dispose()
      log.mockRestore()
    }
  })

  test("does not finish at a fresh watermark when the ready read must rebuild", async () => {
    const file = dbFile()
    const facts = [usageV4Fact(1, "a", "one")]
    await readyBudget(file, facts, "a")
    const tamper = new Database(file)
    tamper.query("update session_summary_local set budget_json = '{' where session_id = 'a'").run()
    tamper.close()
    const log = spyOn(DebugLog, "record").mockImplementation(() => {})
    const index = acquireSessionSummaryIndex(file, sourceFor(facts).source)
    try {
      expect((await index.readImmediate(["a"])).status).toBe("loading")
      expect(log.mock.calls.filter(([record]) => record.type === "startup.finished")).toHaveLength(0)
      expect((await index.waitForTotals(["a"])).status).toBe("ready")
      expect(log.mock.calls.find(([record]) => record.type === "startup.finished")?.[0].payload).toMatchObject({ outcome: "ready", stages: { readyRead: { status: "failed", count: 2 } } })
    } finally {
      await index.dispose()
      log.mockRestore()
    }
  })

  test("aggregates cold replay pages and yield before the first ready read", async () => {
    const log = spyOn(DebugLog, "record").mockImplementation(() => {})
    const yielded = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const index = acquireSessionSummaryIndex(dbFile(), sourceFor([
      usageV4Fact(1, "a", "one"), usageV4Fact(2, "a", "two"),
    ], 1).source, { yieldToNextTask: () => { yielded.resolve(); return resume.promise } })
    try {
      const replay = index.replay()
      await yielded.promise
      expect(log.mock.calls.filter(([record]) => record.type === "startup.finished")).toHaveLength(0)
      resume.resolve()
      await replay
      expect(log.mock.calls.filter(([record]) => record.type === "startup.finished")).toHaveLength(0)
      await index.readImmediate(["a"])
      const startup = log.mock.calls.map(([record]) => record).filter((record) => record.type.startsWith("startup."))
      expect(startup).toHaveLength(2)
      expect(startup[1]?.payload).toMatchObject({ outcome: "ready", stages: { readPage: { count: 2, counts: { facts: 2 } }, yield: { count: 1, counts: { yields: 1 } } } })
    } finally {
      resume.resolve()
      await index.dispose()
      log.mockRestore()
    }
  })

  test("records a replay page's thread CPU time apart from the time the page spent off the CPU", async () => {
    const log = spyOn(DebugLog, "record").mockImplementation(() => {})
    let wallMs = 0
    const wallClock = spyOn(performance, "now").mockImplementation(() => wallMs)
    const cpuStart = { user: 10_000, system: 2_000 }
    const cpuClock = spyOn(process, "threadCpuUsage").mockReturnValueOnce(cpuStart).mockReturnValue({ user: 3_000, system: 2_000 })
    const history = sourceFor([usageV4Fact(1, "a", "one")])
    const offCpuMs = 20
    const source: AsyncEventReadSurface = {
      ...history.source,
      readPage: async (...args) => {
        wallMs += offCpuMs + 5
        return history.source.readPage(...args)
      },
    }
    const index = acquireSessionSummaryIndex(dbFile(), source, { shared: false })
    try {
      await index.replay()
      const pages = log.mock.calls.map(([record]) => record).filter((record) => record.type === "session.summary.page")
      expect(pages).toHaveLength(1)
      expect(cpuClock).toHaveBeenNthCalledWith(2, cpuStart)
      expect(pages[0]?.payload).toMatchObject({ taskOccupancyMs: 25, taskCpuMs: 5 })
    } finally {
      await index.dispose()
      log.mockRestore()
      wallClock.mockRestore()
      cpuClock.mockRestore()
    }
  })

  test("keeps a failed replay recoverable", async () => {
    const log = spyOn(DebugLog, "record").mockImplementation(() => {})
    const history = sourceFor([usageV4Fact(1, "a", "one")])
    let fail = true
    const index = acquireSessionSummaryIndex(dbFile(), {
      ...history.source,
      readPage: (...args) => {
        if (args[0].types?.length === 1 && args[0].types[0] === "session.representation.retired") return history.source.readPage(...args)
        if (fail) return Promise.reject(new Error("read failed"))
        return history.source.readPage(...args)
      },
    })
    try {
      await expect(index.replay()).rejects.toThrow("read failed")
      expect(log.mock.calls.filter(([record]) => record.type === "startup.finished")).toHaveLength(0)
      fail = false
      await index.waitForTotals(["a"])
      expect(log.mock.calls.find(([record]) => record.type === "startup.finished")?.[0].payload).toMatchObject({ outcome: "ready", stages: { readPage: { status: "failed", count: 2 } } })
    } finally {
      await index.dispose()
      log.mockRestore()
    }
  })

  test("tags a pre-database open failure without ending the recoverable attempt", async () => {
    const file = dbFile()
    fs.mkdirSync(file)
    const log = spyOn(DebugLog, "record").mockImplementation(() => {})
    const index = acquireSessionSummaryIndex(file, sourceFor([]).source)
    try {
      await expect(index.readImmediate([])).rejects.toThrow()
      await index.dispose()
      expect(log.mock.calls.map(([record]) => record.type)).toEqual(["startup.started", "startup.finished"])
      expect(log.mock.calls[1]?.[0].payload).toMatchObject({ outcome: "incomplete", stages: { open: { status: "failed", count: 1 } } })
    } finally {
      await index.dispose()
      log.mockRestore()
    }
  })

  test("ends a cancelled initial replay once at the real yield seam", async () => {
    const log = spyOn(DebugLog, "record").mockImplementation(() => {})
    const yielded = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const index = acquireSessionSummaryIndex(dbFile(), sourceFor([
      usageV4Fact(1, "a", "one"), usageV4Fact(2, "a", "two"),
    ], 1).source, { yieldToNextTask: () => { yielded.resolve(); return resume.promise } })
    try {
      const replay = index.replay()
      await yielded.promise
      index.cancel()
      resume.resolve()
      await replay
      await index.dispose()
      const records = log.mock.calls.map(([record]) => record).filter((record) => record.type.startsWith("startup."))
      expect(records).toHaveLength(2)
      expect(records[1]?.payload).toMatchObject({ outcome: "incomplete", stages: { readPage: { count: 1 }, yield: { count: 1 } } })
    } finally {
      resume.resolve()
      await index.dispose()
      log.mockRestore()
    }
  })
  test("independent index owners resolve watermark and write-lock contention without blocking their thread", async () => {
    const file = dbFile()
    const history = sourceFor([usageV4Fact(1, "a", "one")], 1)
    const first = acquireSessionSummaryIndex(file, history.source)
    const second = acquireSessionSummaryIndex(file, history.source, { shared: false })
    const other = new Database(file)
    try {
      await Promise.all([first.replay(), second.replay()])
      history.append(usageV4Fact(2, "a", "two"))
      // Another Worker's page holds the index's write lock (ARCH-SUBSTRATE-018).
      other.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE")
      const replay = second.replay()
      expect(await Promise.race([replay.then(() => "committed"), Bun.sleep(5).then(() => "waiting")])).toBe("waiting")
      other.exec("COMMIT")
      await replay
      for (const index of [first, second]) expect((await index.readImmediate(["a"])).summaries.get("a")?.budget?.totalCost).toBe(4)
    } finally {
      other.close()
      await Promise.all([first.dispose(), second.dispose()])
    }
  })

  test("folds from the stored rows after another owner moves the watermark between its pages", async () => {
    const file = dbFile()
    const facts = [usageV4Fact(1, "a", "one"), usageV4Fact(2, "a", "two"), usageV4Fact(3, "a", "three")]
    const history = sourceFor(facts, 1).source
    const other = acquireSessionSummaryIndex(file, sourceFor(facts.slice(0, 2), 1).source, { shared: false })
    let reads = 0
    const interleaved: AsyncEventReadSurface = {
      ...history,
      readPage: async (...args) => {
        if (args[0].types?.length === 1 && args[0].types[0] === "session.representation.retired") return history.readPage(...args)
        // The other owner commits the second fact after this replay folded
        // the first one, so this replay's own copy of "a" is out of date.
        if (++reads === 2) await other.replay()
        return history.readPage(...args)
      },
    }
    const index = acquireSessionSummaryIndex(file, interleaved, { shared: false })
    try {
      await index.replay()
      const result = await index.readImmediate(["a"])
      expect(result.throughPosition).toBe(3)
      expect(result.summaries.get("a")?.budget?.totalCost).toBe(6)
    } finally {
      await Promise.all([index.dispose(), other.dispose()])
    }
  })

  test("observes an independent relevant write on the next head probe", async () => {
    const history = sourceFor([usageV4Fact(1, "a", "one")])
    const index = acquireSessionSummaryIndex(dbFile(), history.source)
    try {
      await index.replay()
      expect((await index.readImmediate(["a"])).summaries.get("a")?.budget?.totalCost).toBe(2)
      history.append(usageV4Fact(2, "a", "two", 3))
      expect((await index.readImmediate(["a"])).status).toBe("loading")
      await index.replay()
      expect((await index.readImmediate(["a"])).summaries.get("a")?.budget?.totalCost).toBe(5)
    } finally {
      await index.dispose()
    }
  })

  test("waits through a second replay when relevant facts arrive during the first replay", async () => {
    const history = sourceFor([usageV4Fact(1, "a", "one"), usageV4Fact(2, "a", "two")], 1)
    const firstPageStarted = Promise.withResolvers<void>()
    const releaseFirstPage = Promise.withResolvers<void>()
    let reads = 0
    const controlled: AsyncEventReadSurface = {
      ...history.source,
      readPage: async (...args) => {
        if (args[0].types?.length === 1 && args[0].types[0] === "session.representation.retired") return history.source.readPage(...args)
        reads++
        if (reads === 1) {
          firstPageStarted.resolve()
          await releaseFirstPage.promise
        }
        return history.source.readPage(...args)
      },
    }
    const index = acquireSessionSummaryIndex(dbFile(), controlled, { shared: false })
    try {
      const waiting = index.waitForTotals(["a"])
      await firstPageStarted.promise
      history.append(usageV4Fact(3, "a", "three"))
      releaseFirstPage.resolve()

      const result = await waiting

      expect(result.status).toBe("ready")
      expect(result.throughPosition).toBe(3)
      expect(result.summaries.get("a")?.budget?.totalCost).toBe(6)
      expect(reads).toBe(3)
    } finally {
      await index.dispose()
    }
  })

  test("a replay asked for during a running replay covers the facts committed before it was asked for", async () => {
    const history = sourceFor([usageV4Fact(1, "a", "one")])
    const pageStarted = Promise.withResolvers<void>()
    const releasePage = Promise.withResolvers<void>()
    let reads = 0
    const controlled: AsyncEventReadSurface = {
      ...history.source,
      readPage: async (...args) => {
        if (args[0].types?.length === 1 && args[0].types[0] === "session.representation.retired") return history.source.readPage(...args)
        if (++reads === 1) {
          pageStarted.resolve()
          await releasePage.promise
        }
        return history.source.readPage(...args)
      },
    }
    const index = acquireSessionSummaryIndex(dbFile(), controlled, { shared: false })
    try {
      const running = index.replay()
      await pageStarted.promise
      history.append(usageV4Fact(2, "a", "two", 3))
      const later = index.replay()
      releasePage.resolve()
      await Promise.all([running, later])

      const result = await index.readImmediate(["a"])
      expect(result.status).toBe("ready")
      expect(result.summaries.get("a")?.budget?.totalCost).toBe(5)
    } finally {
      releasePage.resolve()
      await index.dispose()
    }
  })

  test("cancellation ends a totals wait after its accepted page commits", async () => {
    const history = sourceFor([usageV4Fact(1, "a", "one"), usageV4Fact(2, "a", "two")], 1)
    const firstPageStarted = Promise.withResolvers<void>()
    const releaseFirstPage = Promise.withResolvers<void>()
    const controlled: AsyncEventReadSurface = {
      ...history.source,
      readPage: async (...args) => {
        if (args[0].types?.length === 1 && args[0].types[0] === "session.representation.retired") return history.source.readPage(...args)
        firstPageStarted.resolve()
        await releaseFirstPage.promise
        return history.source.readPage(...args)
      },
    }
    const index = acquireSessionSummaryIndex(dbFile(), controlled, { shared: false })
    try {
      const waiting = index.waitForTotals(["a"])
      await firstPageStarted.promise
      index.cancel()
      releaseFirstPage.resolve()

      expect(await waiting).toEqual({ status: "loading", throughPosition: 1, summaries: new Map() })
    } finally {
      await index.dispose()
    }
  })

  test("yields between single-page catch-ups so cancellation can run", async () => {
    const history = sourceFor([usageV4Fact(1, "a", "one")])
    let appended = false
    let yields = 0
    const source: AsyncEventReadSurface = {
      ...history.source,
      readPage: async (...args) => {
        if (args[0].types?.length === 1 && args[0].types[0] === "session.representation.retired") return history.source.readPage(...args)
        const page = await history.source.readPage(...args)
        if (!appended) {
          appended = true
          history.append(usageV4Fact(2, "a", "two"))
        }
        return page
      },
    }
    const index = acquireSessionSummaryIndex(dbFile(), source, {
      shared: false,
      yieldToNextTask: async () => { yields++; index.cancel() },
    })
    try {
      await index.waitForTotals(["a"])
      expect(yields).toBe(1)
    } finally {
      await index.dispose()
    }
  })

  test("returns globally ready corrupt session rows without retrying", async () => {
    const corrupt = new CorruptEventRowError({
      aggregateId: "session:a",
      seq: 1,
      type: "model.usage.measured",
      version: 4,
      timestamp: 1,
      actor: "provider",
      sessionId: "a",
      eventId: "corrupt",
      position: 1,
      rawPayload: "{",
    }, "invalid JSON")
    const history = sourceFor([corrupt])
    let reads = 0
    const counted: AsyncEventReadSurface = {
      ...history.source,
      readPage: async (...args) => {
        if (args[0].types?.length === 1 && args[0].types[0] === "session.representation.retired") return history.source.readPage(...args)
        reads++
        return history.source.readPage(...args)
      },
    }
    const index = acquireSessionSummaryIndex(dbFile(), counted, { shared: false })
    try {
      const result = await index.waitForTotals(["a"])

      expect(result.status).toBe("ready")
      expect(result.summaries.get("a")?.budget).toBeUndefined()
      expect(result.summaries.get("a")?.errors.budget).toContain("invalid JSON")
      expect(reads).toBe(1)
    } finally {
      await index.dispose()
    }
  })

  test("keeps semantic identities only in the usage table", async () => {
    const file = dbFile()
    const facts = Array.from({ length: 100 }, (_, index) => usageV4Fact(index + 1, "a", `semantic-${index}`))
    const index = acquireSessionSummaryIndex(file, sourceFor(facts, 20).source)
    try {
      await index.replay()
      expect((await index.readImmediate(["a"])).summaries.get("a")?.budget?.totalCost).toBe(200)
      const db = new Database(file, { readonly: true })
      const row = db.query<{ budget_json: string }, []>("select budget_json from session_summary_local where session_id = 'a'").get()
      expect(row?.budget_json).not.toContain("semantic-")
      expect(JSON.parse(row?.budget_json ?? "{}").settledUsageEntryIds).toBeUndefined()
      db.close()
    } finally {
      await index.dispose()
    }
  })

  test("rebuilds malformed stored budget state in place", async () => {
    const file = dbFile()
    const history = sourceFor([usageV4Fact(1, "a", "one")])
    const index = acquireSessionSummaryIndex(file, history.source)
    try {
      await index.replay()
      const tamper = new Database(file)
      tamper.query("update session_summary_local set budget_json = '{' where session_id = 'a'").run()
      tamper.close()
      expect((await index.readImmediate(["a"])).status).toBe("loading")
      await index.replay()
      expect((await index.readImmediate(["a"])).summaries.get("a")?.budget?.totalCost).toBe(2)
    } finally {
      await index.dispose()
    }
  })

  test("commits an accepted page before cancellation and resumes at its watermark", async () => {
    const facts = [usageV4Fact(1, "a", "one"), usageV4Fact(2, "a", "two"), usageV4Fact(3, "a", "three")]
    const base = sourceFor(facts, 1).source
    const file = dbFile()
    const firstRef: SummaryIndexRef = {}
    let reads = 0
    const cancelling: AsyncEventReadSurface = {
      ...base,
      readPage: async (...args) => {
        if (args[0].types?.length === 1 && args[0].types[0] === "session.representation.retired") return base.readPage(...args)
        const page = await base.readPage(...args)
        reads++
        firstRef.current?.cancel()
        return page
      },
    }
    const first = acquireSessionSummaryIndex(file, cancelling)
    firstRef.current = first
    await first.replay()
    expect((await first.readImmediate(["a"])).throughPosition).toBe(1)
    await first.dispose()

    const second = acquireSessionSummaryIndex(file, base)
    try {
      await second.replay()
      expect((await second.readImmediate(["a"])).summaries.get("a")?.budget?.totalCost).toBe(6)
      expect(reads).toBe(1)
    } finally {
      await second.dispose()
    }
  })

  test("rolls back a failed page transaction and resumes after reopen", async () => {
    const file = dbFile()
    const history = sourceFor([])
    const first = acquireSessionSummaryIndex(file, history.source)
    expect((await first.readImmediate([])).status).toBe("ready")
    const sabotage = new Database(file)
    sabotage.exec("create trigger fail_summary_commit before update on session_summary_watermark begin select raise(abort, 'simulated crash'); end")
    sabotage.close()
    history.append(usageV4Fact(1, "a", "one"))
    await expect(first.replay()).rejects.toThrow("simulated crash")
    await first.dispose()

    const repair = new Database(file)
    expect(repair.query<{ position: number }, []>("select position from session_summary_watermark").get()?.position).toBe(0)
    repair.exec("drop trigger fail_summary_commit")
    repair.close()

    const second = acquireSessionSummaryIndex(file, history.source)
    try {
      await second.replay()
      expect((await second.readImmediate(["a"])).summaries.get("a")?.budget?.totalCost).toBe(2)
    } finally {
      await second.dispose()
    }
  })

  test("rebuilds missing, negative, noninteger, and source-ahead watermarks", async () => {
    for (const mutation of [
      "delete from session_summary_watermark",
      "update session_summary_watermark set position = -1",
      "update session_summary_watermark set position = 1.5",
      "update session_summary_watermark set position = 99",
    ]) {
      const file = dbFile()
      const history = sourceFor([usageV4Fact(1, "a", "one")])
      const first = acquireSessionSummaryIndex(file, history.source)
      await first.replay()
      await first.dispose()

      const tamper = new Database(file)
      tamper.exec(mutation)
      tamper.close()

      const second = acquireSessionSummaryIndex(file, history.source)
      try {
        await second.replay()
        expect((await second.readImmediate(["a"])).summaries.get("a")?.budget?.totalCost).toBe(2)
      } finally {
        await second.dispose()
      }
    }
  })

  test("rebuilds a same-generation schema mismatch", async () => {
    const file = dbFile()
    const history = sourceFor([usageV4Fact(1, "a", "one")])
    const first = acquireSessionSummaryIndex(file, history.source)
    await first.replay()
    await first.dispose()
    const tamper = new Database(file)
    tamper.exec("drop table session_summary_descendant")
    tamper.close()
    const second = acquireSessionSummaryIndex(file, history.source)
    try {
      await second.replay()
      expect((await second.readImmediate(["a"])).summaries.get("a")?.budget?.totalCost).toBe(2)
    } finally {
      await second.dispose()
    }
  })

  test("a session's speed is the pooled speed of the recorded summaries in its own aggregate", async () => {
    const facts: (StoredFact | CorruptEventRowError)[] = [
      streamSummaryFact(1, "own", recorded(100, 1000)),
      streamSummaryFact(2, "own", recorded(100, 9000)),
      streamSummaryFact(3, "own", recorded(0, 0)),
      streamSummaryFact(4, "own", { kind: "unavailable", reason: "historical" }),
      streamSummaryFact(5, "instant", recorded(40, 0)),
      streamSummaryFact(6, "unmeasured", { kind: "unavailable", reason: "tokenizer-preparation-failed" }),
      // A retired workflow representation moves its usage to the residual
      // aggregate, but its own speed stays with its own session.
      streamSummaryFact(7, "run", recorded(30, 1000)),
      { ...streamSummaryFact(8, "run", recorded(500, 1)), aggregateId: "workflow:run" },
      usageV4Fact(9, "run", "residual-request"),
      sessionSummaryFact(10, "run", "session.representation.retired", 1, { migrationId: "workflow-agent-session-ownership", aggregateId: "workflow:run", recovery: [] }),
      usageV4Fact(11, "broken", "broken-request"),
      new CorruptEventRowError({
        aggregateId: "session:broken", seq: 1, type: "model.stream.summary.recorded", version: 3, timestamp: 12,
        actor: "flywheel", sessionId: "broken", eventId: "corrupt-12", position: 12, rawPayload: "{",
      }, "invalid JSON"),
      streamSummaryFact(13, "broken", recorded(10, 1000)),
    ]
    const sessionIds = ["own", "instant", "unmeasured", "run", "broken"]
    const index = acquireSessionSummaryIndex(dbFile(), sourceFor(facts).source)
    try {
      await index.replay()
      const read = await index.readImmediate(sessionIds)
      const speeds = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, read.summaries.get(sessionId)?.averageGenerationTokensPerSecond]))
      const pooled = Object.fromEntries(sessionIds.filter((sessionId) => sessionId !== "broken").map((sessionId) => [sessionId, generationStatistics(facts
        .filter((fact): fact is StoredFact => !(fact instanceof CorruptEventRowError) && fact.aggregateId === `session:${sessionId}` && fact.type === "model.stream.summary.recorded")
        .reduce(reduceGenerationEvidence, initialGenerationEvidence())).totals.averageTokensPerSecond ?? undefined]))
      expect(speeds).toEqual({ ...pooled, broken: undefined })
      expect(speeds).toMatchObject({ own: 20, run: 30 })
      expect(read.summaries.get("broken")?.budget?.totalCost).toBe(2)
    } finally {
      await index.dispose()
    }
  })

  test("one new stream summary costs one fact read, whatever the session count and history length", async () => {
    async function costOfOneSummary(sessionCount: number) {
      const facts: StoredFact[] = []
      for (let round = 0; round < 20; round++) {
        for (let session = 0; session < sessionCount; session++) facts.push(streamSummaryFact(facts.length + 1, `s${session}`, recorded(100, 1000)))
      }
      const history = sourceFor(facts, 10_000)
      const counter = countStateRequests(history.source)
      const index = acquireSessionSummaryIndex(dbFile(), counter.reader)
      try {
        await index.replay()
        counter.take()
        history.append(streamSummaryFact(facts.length + 1, "s0", recorded(100, 3000)))
        await index.replay()
        const requests = counter.take()
        expect((await index.readImmediate(["s0"])).summaries.get("s0")?.averageGenerationTokensPerSecond).toBe(2100 * 1000 / 23_000)
        return { requests: requests.length, facts: factsRead(requests) }
      } finally {
        await index.dispose()
      }
    }
    const few = await costOfOneSummary(3)
    expect(few.facts).toBe(1)
    expect(await costOfOneSummary(100)).toEqual(few)
  })

  test("rebuilds an index of the previous generation, whose rows had no speed", async () => {
    const file = dbFile()
    const history = sourceFor([usageV4Fact(1, "a", "one"), streamSummaryFact(2, "a", recorded(50, 1000))])
    const first = acquireSessionSummaryIndex(file, history.source)
    await first.replay()
    await first.dispose()
    const previous = new Database(file)
    previous.exec("alter table session_summary_local drop column generation_output_tokens; alter table session_summary_local drop column generation_duration_ms; pragma user_version = 11")
    previous.close()
    const second = acquireSessionSummaryIndex(file, history.source)
    try {
      await second.replay()
      expect((await second.readImmediate(["a"])).summaries.get("a")).toMatchObject({ budget: { totalCost: 2 }, averageGenerationTokensPerSecond: 50 })
    } finally {
      await second.dispose()
    }
  })

})
