import { describe, expect, it } from "bun:test"
import { createStartupTimeline, type StartupTimelineRecord } from "../../../src/infra/startup-timeline.js"

function timeline(stages: readonly string[] = ["connect", "hydrate"]) {
  let time = 100
  const records: StartupTimelineRecord[] = []
  const clock = () => time
  return {
    records,
    advance: (milliseconds: number) => { time += milliseconds },
    trace: createStartupTimeline({ owner: "client", stages, context: { build: "test", projectId: "p1" }, now: clock, emit: (record) => records.push(record) }),
  }
}

describe("startup timeline", () => {
  it("includes preparation measured before the diagnostic sink opened", () => {
    const records: StartupTimelineRecord[] = []
    const trace = createStartupTimeline({
      owner: "client", stages: ["directories", "logging"], context: {},
      originMs: 10, now: () => 30, emit: (record) => records.push(record),
    })
    trace.recordCompleted("directories", 10, 15)
    trace.recordCompleted("logging", 20, 30)
    trace.finish()
    expect(records.at(-1)).toMatchObject({
      elapsedMs: 20,
      stages: {
        directories: { startOffsetMs: 0, endOffsetMs: 5, durationMs: 5 },
        logging: { startOffsetMs: 10, endOffsetMs: 20, durationMs: 10 },
      },
    })
  })

  it("retains a failure when a later overlapping invocation succeeds", () => {
    const { trace, records, advance } = timeline(["connect"])
    const first = trace.begin("connect")
    const second = trace.begin("connect")
    advance(2)
    first("failed")
    advance(3)
    second("ready")
    trace.finish()
    expect(records.at(-1)).toMatchObject({
      stages: { connect: { status: "failed", count: 2, durationMs: 7 } },
    })
  })

  it("records why startup failed", () => {
    const { trace, records } = timeline(["services"])
    trace.begin("services")("failed")
    trace.finish("failed", new Error("Runtime resources have no shutdown owner: example"))
    expect(records.at(-1)).toMatchObject({ outcome: "failed", error: "Runtime resources have no shutdown owner: example" })
  })

  it("records overlapping stage offsets and wall time without adding overlapping durations", () => {
    const { trace, records, advance } = timeline()
    expect(records).toEqual([{ type: "startup.started", owner: "client", context: { build: "test", projectId: "p1" }, elapsedMs: 0 }])
    const connect = trace.begin("connect")
    advance(5)
    const hydrate = trace.begin("hydrate")
    advance(10)
    connect("ready", { connections: 2 })
    advance(5)
    trace.foregroundReady()
    expect(records).toHaveLength(1)
    advance(10)
    hydrate("ready")
    trace.finish()
    expect(records[1]).toMatchObject({ type: "startup.finished", outcome: "ready", elapsedMs: 30, foregroundReadyMs: 20, stages: {
      connect: { status: "ready", count: 1, durationMs: 15, maxMs: 15, startOffsetMs: 0, endOffsetMs: 15, counts: { connections: 2 } },
      hydrate: { status: "ready", durationMs: 25, startOffsetMs: 5, endOffsetMs: 30 },
    } })
    expect(records).toHaveLength(2)
  })

  it("rounds offsets and durations to a tenth of a millisecond", () => {
    const { trace, records, advance } = timeline(["connect"])
    const connect = trace.begin("connect")
    advance(1.23456789)
    connect("ready")
    trace.foregroundReady()
    trace.finish()
    expect(records[1]).toMatchObject({ elapsedMs: 1.2, foregroundReadyMs: 1.2, stages: { connect: { durationMs: 1.2, maxMs: 1.2, endOffsetMs: 1.2 } } })
  })

  it("aggregates repeated measurements and numeric counts without emitting per-stage records", () => {
    const { trace, records, advance } = timeline(["hydrate"])
    const first = trace.begin("hydrate")
    advance(4)
    first("ready", { rows: 2 })
    advance(3)
    const second = trace.begin("hydrate")
    advance(9)
    second("ready", { rows: 5 })
    trace.foregroundReady()
    trace.finish()
    expect(records[1]?.type === "startup.finished" && records[1].stages.hydrate).toEqual({ status: "ready", count: 2, durationMs: 13, maxMs: 9, startOffsetMs: 0, endOffsetMs: 16, counts: { rows: 7 } })
    expect(records[1]?.elapsedMs).toBe(16)
    expect(records).toHaveLength(2)
  })

  it("preserves failed stages, pending work, and unfinished work at a failed finish", () => {
    const { trace, records, advance } = timeline(["connect", "hydrate", "index"])
    const connect = trace.begin("connect")
    advance(2)
    connect("failed")
    const hydrate = trace.begin("hydrate")
    advance(3)
    trace.finish("failed")
    expect(records[1]).toMatchObject({ type: "startup.finished", outcome: "failed", elapsedMs: 5, stages: {
      connect: { status: "failed", count: 1, durationMs: 2 },
      hydrate: { status: "incomplete", count: 0, startOffsetMs: 2 },
      index: { status: "pending", count: 0 },
    } })
    hydrate("ready")
    trace.foregroundReady()
    trace.finish()
    expect(records).toHaveLength(2)
    expect(records[1]?.type === "startup.finished" && records[1].stages.hydrate?.status).toBe("incomplete")
  })

  it("reports explicitly incomplete completion and keeps the first foreground checkpoint", () => {
    const { trace, records, advance } = timeline()
    advance(1)
    trace.foregroundReady()
    advance(1)
    trace.foregroundReady()
    trace.finish("incomplete")
    expect(records.map((record) => record.type)).toEqual(["startup.started", "startup.finished"])
    expect(records[1]).toMatchObject({ outcome: "incomplete", foregroundReadyMs: 1, stages: {
      connect: { status: "pending" }, hydrate: { status: "pending" },
    } })
  })

  it("rejects names outside the fixed stage inventory", () => {
    const { trace, records } = timeline(["connect"])
    expect(() => trace.begin("arbitrary-session-id")).toThrow()
    trace.finish()
    expect(records[1]?.type === "startup.finished" && Object.keys(records[1].stages)).toEqual(["connect"])
  })

  it("keeps record count and serialized size bounded after thousands of repetitions", () => {
    const { trace, records, advance } = timeline(["hydrate"])
    for (let index = 0; index < 10_000; index += 1) {
      const end = trace.begin("hydrate")
      advance(1)
      end("ready", { rows: 1 })
    }
    trace.foregroundReady()
    trace.finish()
    expect(records).toHaveLength(2)
    expect(records[1]?.type === "startup.finished" && records[1].stages.hydrate).toMatchObject({ count: 10_000, durationMs: 10_000, maxMs: 1, counts: { rows: 10_000 } })
    expect(JSON.stringify(records[1]).length).toBeLessThan(600)
  })
})
