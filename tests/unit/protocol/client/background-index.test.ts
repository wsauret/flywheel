import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { SessionBackgroundWorkResultSchema, type BackgroundWorkRow } from "../../../../src/protocol/background-index-protocol-types.js"
import {
  backgroundIndexEntries,
  backgroundRowDetail,
  canStopBackgroundRow,
  createBackgroundIndexController,
  stopBackgroundRow,
} from "../../../../src/protocol/client/background-index.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { countStateRequests } from "../../../helpers/state-requests.js"

const row = (fields: Partial<BackgroundWorkRow> & Pick<BackgroundWorkRow, "id" | "status">): BackgroundWorkRow => ({
  kind: "command", title: fields.id, startedAtMs: 0, cardToolUseId: fields.id, ...fields,
})

/** A finished workflow whose subagent waits on it, a running command, and a
 *  finished command. */
const ROWS: readonly BackgroundWorkRow[] = [
  row({ id: "workflow", kind: "workflow", status: "completed", target: { kind: "workflow", workflowId: "workflow" }, cardToolUseId: "toolu_workflow" }),
  row({ id: "reviewer", kind: "subagent", status: "waiting_on_parent", target: { kind: "session", sessionId: "reviewer" }, parentRowId: "workflow", cardToolUseId: "toolu_workflow", stop: { sessionId: "workflow", toolUseId: "toolu_reviewer" } }),
  row({ id: "explorer", kind: "subagent", status: "failed", target: { kind: "session", sessionId: "explorer" }, parentRowId: "reviewer", cardToolUseId: "toolu_workflow" }),
  row({ id: "server", status: "running", stop: { sessionId: "chat", toolUseId: "server" } }),
  row({ id: "test", status: "failed", exitCode: 2, durationMs: 1_500 }),
]

describe("background index rows", () => {
  test("round-trips typed workflow and session destinations without a workflow session alias", () => {
    const result = Schema.decodeUnknownSync(SessionBackgroundWorkResultSchema, { onExcessProperty: "error" })(JSON.parse(JSON.stringify({ snapshotPosition: 4, rows: ROWS })))
    expect(result.rows[0]?.target).toEqual({ kind: "workflow", workflowId: "workflow" })
    expect(result.rows[1]?.target).toEqual({ kind: "session", sessionId: "reviewer" })
    expect(result.rows.every(entry => !("sessionId" in entry))).toBe(true)
  })
  test("Active keeps active rows and the parent row of each active nested row, dimmed when it finished; All keeps every row with its depth", () => {
    expect(backgroundIndexEntries(ROWS, "active").map((entry) => [entry.row.id, entry.depth, entry.dimmed])).toEqual([
      ["workflow", 0, true],
      ["reviewer", 1, false],
      ["server", 0, false],
    ])
    expect(backgroundIndexEntries(ROWS, "all").map((entry) => [entry.row.id, entry.depth, entry.dimmed])).toEqual([
      ["workflow", 0, true],
      ["reviewer", 1, false],
      ["explorer", 2, true],
      ["server", 0, false],
      ["test", 0, true],
    ])
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

describe("background index controller", () => {
  function runtime() {
    const lanes = fakeLanes()
    const listeners = new Set<(event: FrontendEvent) => void>()
    const queries: unknown[] = []
    let rows: readonly BackgroundWorkRow[] = [ROWS[3]!]
    let position = 1
    let held: PromiseWithResolvers<void>[] | undefined
    const query = runtimeQuery({ sessionBackgroundWork: async (request) => {
      queries.push(request)
      // The runtime anchors before it awaits the rows (ARCH-PROTOCOL-045).
      const answer = { snapshotPosition: position, rows }
      if (held) {
        const reply = Promise.withResolvers<void>()
        held.push(reply)
        await reply.promise
      }
      return answer
    } })
    const counter = countStateRequests({ query })
    const client: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> = {
      query: (request) => counter.reader.query(request),
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      onLane: lanes.onLane,
    }
    const settle = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }
    return {
      client, queries, lanes, counter, settle,
      get subscribers() { return listeners.size },
      setRows(next: readonly BackgroundWorkRow[]) { rows = next },
      /** Holds every later reply until `release` answers the oldest one. */
      hold() { held = [] },
      async release(): Promise<void> {
        await settle()
        held?.shift()?.resolve()
        await settle()
      },
      publish(event: FrontendEvent) { for (const listener of listeners) listener(event) },
      async changed(sessionId: string): Promise<void> {
        const prevPosition = position
        position += 1
        for (const listener of listeners) listener({ type: "patch", patch: { cursor: { scope: "session", domain: "background", sessionId }, position, prevPosition, payload: { kind: "background.changed" } } })
        await settle()
      },
      /** A patch was dropped at the bus limit, and its overflow invalidation follows it on the cursor. */
      async overflowed(sessionId: string): Promise<void> {
        position += 2
        for (const listener of listeners) listener({ type: "patch", patch: { cursor: { scope: "session", domain: "background", sessionId }, position, prevPosition: position - 1, payload: { kind: "runtime.invalidate", reason: "overflow" } } })
        await settle()
      },
    }
  }

  test("construction is passive; start reads once, a change of its chat reads again keeping the rows meanwhile, and dispose unsubscribes", async () => {
    const server = runtime()
    const controller = createBackgroundIndexController({ client: server.client, sessionId: "chat" })
    expect(server.queries).toEqual([])

    await controller.start()
    expect(server.queries).toEqual([{ type: "sessionBackgroundWork", sessionId: "chat" }])
    expect(controller.snapshot).toEqual({ status: "ready", rows: [ROWS[3]!] })

    const seen: string[] = []
    controller.onChange(() => { seen.push(controller.snapshot.status) })
    server.setRows(ROWS)
    await server.changed("chat")
    expect(seen).toEqual(["loading", "ready"])
    expect(controller.snapshot).toEqual({ status: "ready", rows: ROWS })

    await server.changed("other-chat")
    expect(server.queries).toHaveLength(2)

    controller.dispose()
    expect(server.subscribers).toBe(0)
  })

  test.each([3, 30])("a burst of %i changes while the index is read keeps one read out and asks for one more; the overtaken answer shows as loading", async (burst) => {
    const server = runtime()
    const controller = createBackgroundIndexController({ client: server.client, sessionId: "chat" })
    await controller.start()
    server.counter.take()
    server.hold()

    const first = [ROWS[3]!, ROWS[4]!]
    server.setRows(first)
    await server.changed("chat")
    server.setRows(ROWS)
    for (let change = 1; change < burst; change++) await server.changed("chat")
    // Reads per burst do not grow with the burst: one is out.
    expect(server.counter.take().map((request) => request.method)).toEqual(["query"])

    await server.release()
    // The answer is valid at its anchor, so it is shown, but a change overtook it.
    expect(controller.snapshot).toEqual({ status: "loading", rows: first })
    expect(server.counter.take().map((request) => request.method)).toEqual(["query"])

    await server.release()
    expect(controller.snapshot).toEqual({ status: "ready", rows: ROWS })
    await server.settle()
    expect(server.counter.take()).toEqual([])
  })

  test("an overflow invalidation of the cursor voids the read that is out and reads at once", async () => {
    const server = runtime()
    const controller = createBackgroundIndexController({ client: server.client, sessionId: "chat" })
    await controller.start()
    server.counter.take()
    server.hold()
    const first = [ROWS[3]!, ROWS[4]!]
    server.setRows(first)
    await server.changed("chat")

    // The runtime bus dropped a patch and publishes its overflow invalidation on the cursor.
    server.setRows(ROWS)
    await server.overflowed("chat")
    expect(server.counter.take().map((request) => request.method)).toEqual(["query", "query"])

    await server.release()
    expect(controller.snapshot).toEqual({ status: "loading", rows: [ROWS[3]!] })
    await server.release()
    expect(controller.snapshot).toEqual({ status: "ready", rows: ROWS })
    await server.settle()
    expect(server.counter.take()).toEqual([])
  })

  test("a lane break voids the read that is out and reads nothing; the next lane reads once", async () => {
    const server = runtime()
    const controller = createBackgroundIndexController({ client: server.client, sessionId: "chat" })
    await controller.start()
    server.counter.take()
    server.hold()
    await server.changed("chat")

    server.lanes.end()
    server.publish(LANE_BREAK)
    await server.release()
    expect(controller.snapshot).toEqual({ status: "loading", rows: [ROWS[3]!] })
    expect(server.counter.take()).toHaveLength(1)

    server.setRows(ROWS)
    server.lanes.open()
    await server.release()
    expect(server.counter.take()).toHaveLength(1)
    expect(controller.snapshot).toEqual({ status: "ready", rows: ROWS })
  })
})
