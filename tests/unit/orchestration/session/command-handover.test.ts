import { describe, expect, test } from "bun:test"

import type { DebugLogRecordInput } from "../../../../src/infra/debug-log"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { Log } from "../../../../src/infra/log"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import {
  allCommandHandoversAsync,
  COMMAND_HANDOVER_IN_FLIGHT_KIND,
  commandHandoversOfAsync,
  keptCommandsOf,
  markCommandKept,
  retireCommandHandover,
  writeCommandHandover,
  type CommandHandoverRow,
} from "../../../../src/orchestration/session/command-handover"
import { temporaryDirectories } from "../../../helpers/directories"

const temporary = temporaryDirectories()

function openStore() {
  const store = createSqliteEventStore(resolveEventStoreDbFile(temporary("command-handover-row-")))
  return { store, writer: asAsyncEventWriter(store) }
}

/** A version 1 row exactly as a version 1 predecessor writes it. A later
 *  release must still read these bytes. */
const ROW_V1: CommandHandoverRow = {
  version: 1,
  handoffId: "handoff-1",
  sessionId: "chat",
  conversationId: "chat-conversation",
  processId: "bash-bg-1a2b3c4d",
  toolUseId: "toolu_1",
  modelRequestId: "request-1",
  description: "bun run build --watch",
  logPath: "/p/.flywheel/sessions/chat/scratch/flywheel-agent-bg-1a2b3c4d.log",
  recordPath: "/p/.flywheel/sessions/chat/scratch/flywheel-agent-bg-1a2b3c4d.outcome.json",
  channel: "/home/a/.flywheel/serve/h-0123456789abcdef.sock",
  token: "owned:1",
  pid: 4242,
  startedAtMs: 1758800000000,
  deadlineAtMs: 1758803600000,
}

async function capturedWarnings<T>(read: () => T | Promise<T>): Promise<{ readonly value: T; readonly warnings: readonly DebugLogRecordInput[] }> {
  const records: DebugLogRecordInput[] = []
  await Log.init({ forward: (record) => { records.push(record) } })
  try {
    return { value: await read(), warnings: records.filter((record) => record.type === "log.warn") }
  } finally {
    await Log.closeGlobal()
  }
}

describe("command handover row", () => {
  test("a version 1 row decodes to the typed row its host reads, and only that conversation's host reads it", async () => {
    const { store } = openStore()
    const reader = asAsyncEventReadSurface(store)
    store.putInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND, ROW_V1.processId, ROW_V1)

    expect((await commandHandoversOfAsync(reader, "chat", "chat-conversation")).map((stored) => stored.row)).toEqual([ROW_V1])
    expect(await commandHandoversOfAsync(reader, "chat", "another-conversation")).toEqual([])
    store.close()
  })

  test("a version 1 row that names the home of the private copy its command runs in decodes with it, and one whose copy home is empty is unreadable", async () => {
    const { store } = openStore()
    const edits = { ...ROW_V1, processId: "bash-bg-5e6f7a8b", privateCopyHome: "/p/.flywheel/sessions/chat/scratch/edits/1" }
    store.putInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND, edits.processId, edits)
    store.putInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND, "bash-bg-empty", { ...edits, processId: "bash-bg-empty", privateCopyHome: "" })

    const { value, warnings } = await capturedWarnings(() => commandHandoversOfAsync(asAsyncEventReadSurface(store), "chat", "chat-conversation"))

    expect(value.map((stored) => stored.row)).toEqual([edits])
    expect(warnings).toHaveLength(1)
    expect(store.readInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND)).toHaveLength(2)
    store.close()
  })

  test("a row is written under its process id and answered as stored", async () => {
    const { store, writer } = openStore()
    const { version: _version, ...row } = ROW_V1

    const stored = await writeCommandHandover({ reader: asAsyncEventReadSurface(store), writer, row })

    expect(stored.row).toEqual(ROW_V1)
    expect(store.readInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND).map((record) => ({ key: record.key, raw: record.raw }))).toEqual([{ key: ROW_V1.processId, raw: stored.raw }])
    store.close()
  })

  test("handover recovery awaits an asynchronous-only state reader", async () => {
    const { store } = openStore()
    store.putInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND, ROW_V1.processId, ROW_V1)
    const direct = asAsyncEventReadSurface(store)
    let reads = 0
    const reader = {
      ...direct,
      async readInFlight(sessionId: string, kinds: string | readonly string[]) {
        await Promise.resolve()
        reads += 1
        return direct.readInFlight(sessionId, kinds)
      },
    }

    expect((await commandHandoversOfAsync(reader, "chat", "chat-conversation")).map(({ row }) => row)).toEqual([ROW_V1])
    expect(reads).toBe(1)
    store.close()
  })

  test("a row of an unknown version is warned about, skipped by the reader, and still present afterwards", async () => {
    const { store } = openStore()
    store.putInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND, ROW_V1.processId, { ...ROW_V1, version: 2, cwd: "/p" })

    const { value, warnings } = await capturedWarnings(() => commandHandoversOfAsync(asAsyncEventReadSurface(store), "chat", "chat-conversation"))

    expect(value).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ sessionId: "chat", payload: { count: 1, versions: "2" } })
    expect(store.readInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND)).toHaveLength(1)
    store.close()
  })

  test("the store-wide read answers every session's readable rows and warns once about the rest, which stay", async () => {
    const { store } = openStore()
    const child = { ...ROW_V1, sessionId: "child", conversationId: "child-run", processId: "bash-bg-5e6f7a8b" }
    store.putInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND, ROW_V1.processId, ROW_V1)
    store.putInFlight("child", COMMAND_HANDOVER_IN_FLIGHT_KIND, child.processId, child)
    store.putInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND, "bash-bg-newer", { ...ROW_V1, processId: "bash-bg-newer", version: 2 })
    store.putInFlight("workflow", COMMAND_HANDOVER_IN_FLIGHT_KIND, "bash-bg-newest", { ...ROW_V1, sessionId: "workflow", processId: "bash-bg-newest", version: 3 })

    const { value, warnings } = await capturedWarnings(() => allCommandHandoversAsync(asAsyncEventReadSurface(store)))

    expect(value.map((stored) => stored.row).toSorted((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([ROW_V1, child])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ payload: { sessions: 2, count: 2, versions: "2,3" } })
    expect(store.readInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND)).toHaveLength(2)
    expect(store.readInFlight("workflow", COMMAND_HANDOVER_IN_FLIGHT_KIND)).toHaveLength(1)
    store.close()
  })

  test("the keeper's mark on a version 1 row decodes with it, only a marked row shows its command, and a mark other than true is unreadable", async () => {
    const { store, writer } = openStore()
    store.putInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND, ROW_V1.processId, ROW_V1)
    store.putInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND, "bash-bg-false", { ...ROW_V1, processId: "bash-bg-false", kept: false })
    const reader = asAsyncEventReadSurface(store)
    const [stored] = (await capturedWarnings(() => commandHandoversOfAsync(reader, "chat", "chat-conversation"))).value
    if (!stored) throw new Error("the row was not read")
    expect(await keptCommandsOf(reader, "chat")).toEqual([])

    const marked = await markCommandKept(reader, writer, stored)

    expect(marked?.row).toEqual({ ...ROW_V1, kept: true })
    const { value, warnings } = await capturedWarnings(() => commandHandoversOfAsync(reader, "chat", "chat-conversation"))
    expect(value).toEqual(marked === undefined ? [] : [marked])
    expect(warnings).toHaveLength(1)
    expect(await keptCommandsOf(reader, "chat")).toEqual([{ id: ROW_V1.processId, description: ROW_V1.description, toolUseId: "toolu_1", startedAtMs: ROW_V1.startedAtMs }])
    // The mark compares against the row as read, so a stale read marks nothing.
    expect(await markCommandKept(reader, writer, stored)).toBeUndefined()
    store.close()
  })

  test("of two concurrent retirements of one row exactly one answers true", async () => {
    const { store, writer } = openStore()
    store.putInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND, ROW_V1.processId, ROW_V1)
    const [stored] = await commandHandoversOfAsync(asAsyncEventReadSurface(store), "chat", "chat-conversation")
    if (!stored) throw new Error("the row was not read")

    const answers = await Promise.all([retireCommandHandover(writer, stored), retireCommandHandover(writer, stored)])

    expect(answers.filter(Boolean)).toHaveLength(1)
    expect(store.readInFlight("chat", COMMAND_HANDOVER_IN_FLIGHT_KIND)).toEqual([])
    store.close()
  })
})
