import type { ChildSessionRow, FrontendEvent, FrontendMutation, FrontendOutputBlock, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { CONNECTED_PROVIDER, fakeConnection } from "./session-connection-fixture.js"
import { detailView, tailWindow } from "../../../tests/helpers/runtime-views.js"
import { fakeLanes, LANE_BREAK } from "../../../tests/helpers/fake-lanes.js"
import { recordedDispatch, runtimeDispatch, runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"

const chatRow = (id: string, title: string): SessionCatalogRow => ({
  id, kind: "chat", title, shortTitle: title, lifecycleState: "inactive", activity: "idle", inputMode: { kind: "chat" },
  createdAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z", notices: [], executionCwd: "/project", totalsLoading: true,
})
const childRow: ChildSessionRow = {
  id: "child", kind: "subagent", title: "Review agent", shortTitle: "Review agent", lifecycleState: "active", activity: "idle",
  inputMode: { kind: "message" }, admittedActions: ["session.send"], createdAt: "2026-01-01T00:00:00.000Z", lastUpdated: "2026-01-01T00:00:00.000Z",
  parentSessionId: "chat", notices: [], executionCwd: "/project", totalsLoading: true,
}

/** What one tail read of a session's transcript answers. */
export interface TailRead {
  readonly blocks: readonly FrontendOutputBlock[]
  readonly hasBefore: boolean
}

/** A runtime with listed chats and one child. `detail` answers each child
 *  detail read, `unreadable` names the sessions whose detail read fails,
 *  `open` answers each `chat.open`, `created` holds every
 *  catalog read after the first and every detail read of a created chat,
 *  `remove` answers each `session.delete`, and `tail` answers each tail
 *  read of a session's transcript. */
export function navigationConnection(options: {
  readonly rows?: readonly string[]
  readonly tail?: (sessionId: string) => TailRead
  readonly detail?: () => Promise<"row" | "missing">
  readonly unreadable?: readonly string[]
  readonly open?: () => Promise<void>
  readonly created?: () => Promise<void>
  readonly remove?: () => Promise<{ readonly ok: false; readonly error: string } | void>
}) {
  const opened: string[] = []
  const dispatched: FrontendMutation[] = []
  const listeners = new Set<(event: FrontendEvent) => void>()
  let created = 0
  let snapshots = 0
  const rows = (options.rows ?? ["chat"]).map((id) => chatRow(id, id === "chat" ? "Chat" : id))
  /** Sessions whose catalog metadata the next snapshot cannot read. They
   *  still exist, so their detail still reads. */
  const metadataUnreadable = new Set<string>()
  const lanes = fakeLanes()
  const base = fakeConnection([CONNECTED_PROVIDER])
  const tail = options.tail
  const query = runtimeQuery({
    snapshot: async () => {
      snapshots += 1
      if (snapshots > 1) await options.created?.()
      return {
        rows: rows.filter((row) => !metadataUnreadable.has(row.id)), activeRuntimeCount: 0,
        errors: [...metadataUnreadable].map((sessionId) => ({ sessionId, scope: "metadata", reason: "the metadata read failed" })),
        snapshotPosition: 0, runtimeVersion: "test", runtimeBuildId: null, projectRoot: "/project", chatDefault: { kind: "none" },
        executor: { kind: "serving" }, service: { kind: "serving" },
      }
    },
    sessionDetailSnapshot: async (request) => {
      const views = await Promise.all(request.sessionIds.map(async (sessionId) => {
        if (sessionId.startsWith("new-")) await options.created?.()
        if (options.unreadable?.includes(sessionId)) throw new Error("the read timed out")
        const known = sessionId === "child" ? await (options.detail?.() ?? Promise.resolve("row")) : "missing"
        const row = sessionId === "child" && known === "row" ? childRow : rows.find((candidate) => candidate.id === sessionId)
        return { sessionId, view: row ? detailView(row) : null }
      }))
      return { snapshotPosition: 0, views }
    },
    commandCatalog: async () => ({ revision: 1, builtInCommands: [{ id: "review", title: "Review", description: "Review the change", aliases: [] }], offCommands: [], snapshotPosition: 0 }),
    ...(tail === undefined ? {} : { outputWindow: async (request) => {
      const { blocks, hasBefore } = tail(request.sessionId)
      return tailWindow(blocks, { startBlockIndex: hasBefore ? 500 : 0 })
    } }),
  }, base.query)
  const acknowledge = async () => ({ ok: true as const })
  const dispatch = recordedDispatch((command) => { dispatched.push(command) }, runtimeDispatch({
    "session.delete": async (command) => {
      const refused = await options.remove?.()
      if (refused) return refused
      const listed = rows.findIndex((row) => row.id === command.sessionId)
      if (listed >= 0) rows.splice(listed, 1)
      return { ok: true }
    },
    "chat.open": async () => {
      await options.open?.()
      const sessionId = `new-${++created}`
      opened.push(sessionId)
      rows.push(chatRow(sessionId, "Named chat"))
      return { ok: true, sessionId }
    },
    "session.activate": acknowledge, "session.release": acknowledge, "session_detail.release": acknowledge,
    "session.send": acknowledge, "command.invoke": async () => ({ kind: "none" as const }),
  }))
  const connection: RuntimeConnection = {
    ...base,
    ...lanes.client,
    query,
    dispatch,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    connection,
    opened,
    dispatched,
    /** The lane breaks and the next one opens, as a phone's return does. */
    reattach() { lanes.end(); for (const listener of listeners) listener(LANE_BREAK); lanes.open() },
    publishCatalog() {
      const row = rows.find((candidate) => candidate.id === "chat")
      if (row === undefined) throw new Error("the runtime lists no chat to publish")
      for (const listener of listeners) listener({ type: "patch", patch: {
        cursor: { scope: "session", domain: "session", sessionId: "chat" }, position: 1, prevPosition: 0,
        payload: { kind: "session.updated", row },
      } })
    },
    /** Makes the catalog's metadata read of `sessionId` fail from the next
     *  snapshot on, while the session itself stays. */
    metadataFails(sessionId: string) { metadataUnreadable.add(sessionId) },
    /** The global invalidation the runtime publishes when its executor attaches. */
    invalidate() {
      for (const listener of listeners) listener({ type: "patch", patch: {
        cursor: { scope: "workspace", domain: "runtime" }, position: 1, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "overflow" },
      } })
    },
    /** What another client's delete of `sessionId` sends here: the catalog
     *  removal when the session is listed, and its detail turning null. */
    deletedElsewhere(sessionId: string) {
      const listed = rows.findIndex((row) => row.id === sessionId)
      if (listed >= 0) {
        rows.splice(listed, 1)
        for (const listener of listeners) listener({ type: "patch", patch: {
          cursor: { scope: "session", domain: "session", sessionId }, position: 1, prevPosition: 0, payload: { kind: "session.removed" },
        } })
      }
      for (const listener of listeners) listener({ type: "patch", patch: {
        cursor: { scope: "session", domain: "session_detail", sessionId }, position: 1, prevPosition: 0,
        payload: { kind: "session_detail.changed", row: null },
      } })
    },
  }
}
