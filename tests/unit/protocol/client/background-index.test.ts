import { describe, expect, jest, test } from "bun:test"
import { Schema } from "effect"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { backgroundCursor, SessionBackgroundWorkResultSchema, type BackgroundPatchPayload, type BackgroundWorkRow } from "../../../../src/protocol/background-index-protocol-types.js"
import {
  backgroundIndexEntries,
  backgroundIndexState,
  backgroundRowDetail,
  canStopBackgroundRow,
  createBackgroundIndexReadings,
  stopBackgroundRow,
  type HeldBackgroundIndex,
} from "../../../../src/protocol/client/background-index.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { countStateRequests } from "../../../helpers/state-requests.js"

const row = (fields: Partial<BackgroundWorkRow> & Pick<BackgroundWorkRow, "id" | "status">): BackgroundWorkRow => ({
  kind: "command", title: fields.id, startedAtMs: 0, cardToolUseId: fields.id, ...fields,
})

/** A finished workflow whose subagent waits on it, a running command, and a
 *  finished command, in the index's order. */
const ROWS: readonly BackgroundWorkRow[] = [
  row({ id: "workflow", kind: "workflow", status: "completed", startedAtMs: 100, target: { kind: "workflow", workflowId: "workflow" }, cardToolUseId: "toolu_workflow" }),
  row({ id: "reviewer", kind: "subagent", status: "waiting_on_parent", startedAtMs: 400, target: { kind: "session", sessionId: "reviewer" }, parentRowId: "workflow", cardToolUseId: "toolu_workflow", stop: { sessionId: "workflow", toolUseId: "toolu_reviewer" } }),
  row({ id: "explorer", kind: "subagent", status: "failed", startedAtMs: 500, target: { kind: "session", sessionId: "explorer" }, parentRowId: "reviewer", cardToolUseId: "toolu_workflow" }),
  row({ id: "server", status: "running", startedAtMs: 200, stop: { sessionId: "chat", toolUseId: "server" } }),
  row({ id: "test", status: "failed", startedAtMs: 300, exitCode: 2, durationMs: 1_500 }),
]
/** The runtime answers the rows in no stated order. */
const SHUFFLED: readonly BackgroundWorkRow[] = [ROWS[4]!, ROWS[2]!, ROWS[3]!, ROWS[1]!, ROWS[0]!]

describe("background index rows", () => {
  test("round-trips typed workflow and session destinations without a workflow session alias", () => {
    const result = Schema.decodeUnknownSync(SessionBackgroundWorkResultSchema, { onExcessProperty: "error" })(JSON.parse(JSON.stringify({ snapshotPosition: 4, rows: ROWS })))
    expect(result.rows[0]?.target).toEqual({ kind: "workflow", workflowId: "workflow" })
    expect(result.rows[1]?.target).toEqual({ kind: "session", sessionId: "reviewer" })
    expect(result.rows.every(entry => !("sessionId" in entry))).toBe(true)
  })
  test("Active keeps active rows and the parent row of each active nested row, dimmed when it finished; All keeps every row with its depth, from rows in any order", () => {
    expect(backgroundIndexEntries(SHUFFLED, "active").map((entry) => [entry.row.id, entry.depth, entry.dimmed])).toEqual([
      ["workflow", 0, true],
      ["reviewer", 1, false],
      ["server", 0, false],
    ])
    expect(backgroundIndexEntries(SHUFFLED, "all").map((entry) => [entry.row.id, entry.depth, entry.dimmed])).toEqual([
      ["workflow", 0, true],
      ["reviewer", 1, false],
      ["explorer", 2, true],
      ["server", 0, false],
      ["test", 0, true],
    ])
  })

  test("rows that start together order by id, and a row whose parent row is missing is a top-level row", () => {
    const rows = [
      row({ id: "b", status: "running", startedAtMs: 10 }),
      row({ id: "orphan", status: "running", startedAtMs: 5, parentRowId: "gone" }),
      row({ id: "a", status: "running", startedAtMs: 10 }),
    ]
    expect(backgroundIndexEntries(rows, "all").map((entry) => [entry.row.id, entry.depth])).toEqual([["orphan", 0], ["a", 0], ["b", 0]])
  })

  test("a row states its status, a finished command its exit code and duration, a stopped command no exit code, and a nested row lands on its top-level card", () => {
    expect(ROWS.map(backgroundRowDetail)).toEqual(["Completed", "Waiting on parent", "Failed", "Running", "Failed · exit 2 · 1.5s"])
    // A command that traps the stop signal still exits with a code, and Windows termination always exits 1: neither is the command's outcome.
    expect(backgroundRowDetail(row({ id: "dev", status: "stopped", exitCode: 1, durationMs: 195_000 }))).toBe("Stopped · 3m 15s")
    expect(backgroundRowDetail(row({ id: "build", status: "cancelled", exitCode: 143, durationMs: 1_500 }))).toBe("Canceled · 1.5s")
    expect(ROWS.find((candidate) => candidate.id === "explorer")?.cardToolUseId).toBe("toolu_workflow")
  })

  test("a workflow row states its progress, names its running agents only while it runs, and counts names past three", () => {
    const workflow = (status: BackgroundWorkRow["status"], active: readonly string[]) => row({
      id: "workflow", kind: "workflow", status, progress: { done: 3, total: 12, failed: 1, running: active.length === 1 ? 4 : active.length, active },
    })
    expect(backgroundRowDetail(workflow("running", ["Choose columns"]))).toBe("Running · 3/12 done, 1 failed, 4 running · Choose columns")
    expect(backgroundRowDetail(workflow("running", ["Plan", "Review", "Test", "Ship", "Notify"]))).toBe("Running · 3/12 done, 1 failed, 5 running · Plan, Review, Test +2 more")
    // An interrupt holds the agents it cut: an interrupted workflow names none as running.
    expect(backgroundRowDetail(workflow("interrupted", ["Choose columns"]))).toBe("Interrupted · 3/12 done, 1 failed")
    expect(Schema.decodeUnknownSync(SessionBackgroundWorkResultSchema, { onExcessProperty: "error" })({ snapshotPosition: 1, rows: [workflow("running", ["Choose columns"])] }).rows[0]?.progress?.active).toEqual(["Choose columns"])
  })

  test("Stop is admitted only on an active row, and ends the row's launching call", async () => {
    const sent: unknown[] = []
    const client: Pick<AttachedRuntimeClient, "dispatch"> = { dispatch: runtimeDispatch({ "background.terminate": async (mutation) => { sent.push(mutation); return { ok: true } } }) }

    expect(ROWS.map(canStopBackgroundRow)).toEqual([false, true, false, true, false])
    expect(await stopBackgroundRow(client, ROWS[4]!)).toBe(false)
    expect(await stopBackgroundRow(client, { ...ROWS[3]!, status: "ended" })).toBe(false)
    expect(await stopBackgroundRow(client, ROWS[1]!)).toBe(true)
    expect(sent).toEqual([{ type: "background.terminate", sessionId: "workflow", toolUseId: "toolu_reviewer" }])
  })
})

describe("background index readings", () => {
  /** `gated` holds each read until the test settles it through `reads`. */
  function runtime(options: { readonly fail?: () => Error | undefined; readonly gated?: boolean } = {}) {
    const lanes = fakeLanes()
    const listeners = new Set<(event: FrontendEvent) => void>()
    const queries: unknown[] = []
    const reads: PromiseWithResolvers<void>[] = []
    const released: unknown[] = []
    let rows: readonly BackgroundWorkRow[] = [ROWS[3]!]
    let position = 1
    const query = runtimeQuery({ sessionBackgroundWork: async (request) => {
      queries.push(request)
      if (options.gated) {
        const gate = Promise.withResolvers<void>()
        reads.push(gate)
        await gate.promise
      }
      const failure = options.fail?.()
      if (failure) throw failure
      return { snapshotPosition: position, rows }
    } })
    const counter = countStateRequests({ query })
    const client: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane"> = {
      query: (request) => counter.reader.query(request),
      dispatch: runtimeDispatch({ "background.release": async (mutation) => { released.push(mutation); return { ok: true } } }),
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      onLane: lanes.onLane,
    }
    const held = new Map<string, HeldBackgroundIndex>()
    const readings = createBackgroundIndexReadings({
      client,
      admits: (sessionId) => sessionId === "chat",
      views: {
        get: (sessionId) => held.get(sessionId),
        set: (sessionId, view) => { held.set(sessionId, view) },
        delete: (sessionId) => { held.delete(sessionId) },
        keys: () => held.keys(),
      },
    })
    const settle = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }
    const publish = async (sessionId: string, payload: BackgroundPatchPayload | { readonly kind: "runtime.invalidate"; readonly reason: "overflow" }, step = 1): Promise<void> => {
      const prevPosition = position
      position += step
      for (const listener of listeners) listener({ type: "patch", patch: { cursor: backgroundCursor(sessionId), position, prevPosition: payload.kind === "runtime.invalidate" ? position - 1 : prevPosition, payload } })
      await settle()
    }
    return {
      readings, queries, reads, released, lanes, counter, settle,
      state: (sessionId: string) => backgroundIndexState(held.get(sessionId)),
      setRows(next: readonly BackgroundWorkRow[]) { rows = next },
      publish: (event: FrontendEvent) => { for (const listener of listeners) listener(event) },
      updated: (sessionId: string, updated: BackgroundWorkRow) => publish(sessionId, { kind: "background.row.updated", row: updated }),
      removed: (sessionId: string, rowId: string) => publish(sessionId, { kind: "background.row.removed", rowId }),
      /** A patch was dropped at the bus limit, and its overflow invalidation follows it on the cursor. */
      overflowed: (sessionId: string) => publish(sessionId, { kind: "runtime.invalidate", reason: "overflow" }, 2),
    }
  }

  test("following reads once; row patches change the held rows in place with no read, and another session's patches cost nothing", async () => {
    const server = runtime()
    expect(server.state("chat")).toEqual({ status: "loading" })
    server.readings.ensure(["chat"])
    await server.settle()
    expect(server.queries).toEqual([{ type: "sessionBackgroundWork", sessionId: "chat" }])
    expect(server.state("chat")).toEqual({ status: "ready", rows: [ROWS[3]!] })
    server.counter.take()

    const finished = { ...ROWS[3]!, status: "completed" as const, durationMs: 2_000 }
    await server.updated("chat", finished)
    await server.updated("chat", ROWS[4]!)
    expect(server.state("chat")).toEqual({ status: "ready", rows: [finished, ROWS[4]!] })
    await server.removed("chat", "server")
    expect(server.state("chat")).toEqual({ status: "ready", rows: [ROWS[4]!] })

    await server.updated("other-chat", ROWS[0]!)
    expect(server.readings.sessionIds()).toEqual(["chat"])
    expect(server.counter.take()).toEqual([])
    server.readings.dispose()
  })

  test("a failed read states the error and keeps the rows held, and the read is retried with backoff", async () => {
    jest.useFakeTimers()
    let failure: Error | undefined
    const server = runtime({ fail: () => failure })
    try {
      server.readings.ensure(["chat"])
      await server.settle()
      failure = new Error("index build failed")
      await server.overflowed("chat")
      expect(server.state("chat")).toEqual({ status: "error", error: "index build failed", rows: [ROWS[3]!] })

      failure = undefined
      server.setRows(ROWS)
      jest.runOnlyPendingTimers()
      await server.settle()
      expect(server.state("chat")).toEqual({ status: "ready", rows: ROWS })
      expect(server.queries).toHaveLength(3)
    } finally {
      server.readings.dispose()
      jest.useRealTimers()
    }
  })

  test("a retired session releases its follow once its last read settled, unless it is followed again, and a retired read that fails late never replaces newer rows", async () => {
    const failures: Error[] = []
    const server = runtime({ gated: true, fail: () => failures[0] })
    server.readings.ensure(["chat"])
    await server.settle()
    server.readings.retire("chat")
    server.readings.ensure(["chat"])
    await server.settle()
    expect(server.reads).toHaveLength(2)

    server.reads[1]!.resolve()
    await server.settle()
    expect(server.state("chat")).toEqual({ status: "ready", rows: [ROWS[3]!] })
    failures.push(new Error("the released index failed to build"))
    server.reads[0]!.resolve()
    await server.settle()
    expect(server.state("chat")).toEqual({ status: "ready", rows: [ROWS[3]!] })
    expect(server.released).toEqual([])

    server.readings.retire("chat")
    await server.settle()
    expect(server.released).toEqual([{ type: "background.release", sessionId: "chat" }])
    server.readings.dispose()
  })

  test("dispose releases every followed session", async () => {
    const server = runtime()
    server.readings.ensure(["chat"])
    await server.settle()
    server.readings.dispose()
    await server.settle()
    expect(server.released).toEqual([{ type: "background.release", sessionId: "chat" }])
  })

  test("a lane break keeps the rows held and the next lane reads once", async () => {
    const server = runtime()
    server.readings.ensure(["chat"])
    await server.settle()
    server.counter.take()

    server.lanes.end()
    server.publish(LANE_BREAK)
    await server.settle()
    expect(server.state("chat")).toEqual({ status: "ready", rows: [ROWS[3]!] })
    expect(server.counter.take()).toEqual([])

    server.setRows(ROWS)
    server.lanes.open()
    await server.settle()
    expect(server.counter.take()).toHaveLength(1)
    expect(server.state("chat")).toEqual({ status: "ready", rows: ROWS })
    server.readings.dispose()
  })

  test("an overflow invalidation of the cursor reads the index again", async () => {
    const server = runtime()
    server.readings.ensure(["chat"])
    await server.settle()
    server.counter.take()

    server.setRows(ROWS)
    await server.overflowed("chat")
    expect(server.counter.take().map((request) => request.method)).toEqual(["query"])
    expect(server.state("chat")).toEqual({ status: "ready", rows: ROWS })
    server.readings.dispose()
  })
})
