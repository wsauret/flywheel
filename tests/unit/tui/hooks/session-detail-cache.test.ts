import { describe, expect, it } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { sessionDetailCursor, type RuntimeSessionDetailView } from "../../../../src/protocol/session-detail-protocol-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { createSessionDetailCache } from "../../../../src/tui/hooks/create-session-surface.js"
import { catalogRow } from "../../../helpers/session-catalog.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

function chatView(id: string): RuntimeSessionDetailView {
  return {
    id, source: "durable", kind: "chat", conversationId: `conv-${id}`, budget: null, row: catalogRow(id, "Original"),
    status: {
      activity: "absent", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected",
      activeSubagentCount: 0, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
      waitingOnBackgroundWork: false, startedAt: 0,
      streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
    },
  }
}

describe("createSessionDetailCache", () => {
  it("wakes only the readers of the held session that changed", async () => {
    await createRoot(async (dispose) => {
      const listeners = new Set<(event: FrontendEvent) => void>()
      const sequencer = createRuntimeUiPatchSequencer()
      const query = runtimeQuery({
        sessionDetailSnapshot: async (request) => ({
          snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["session_detail"] }),
          views: request.sessionIds.map((sessionId) => ({ sessionId, view: chatView(sessionId) })),
        }),
      })
      const releases = { dispatch: runtimeDispatch({ "session_detail.release": async () => ({ ok: true }) }) }
      const cache = createSessionDetailCache({
        query, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }, onLane: fakeLanes().onLane,
      }, releases)
      const rename = (id: string, title: string): void => {
        const patch = sequencer.publish({ cursor: sessionDetailCursor(id), payload: { kind: "session_detail.changed", row: catalogRow(id, title) } })
        for (const listener of listeners) listener({ type: "patch", patch })
      }
      const runs = { a: 0, b: 0, later: 0 }
      createComputed(() => { cache.view("a"); cache.state("a"); runs.a += 1 })
      createComputed(() => { cache.view("b"); cache.state("b"); runs.b += 1 })
      createComputed(() => { cache.view("later"); runs.later += 1 })
      const holdA = cache.retain("a")
      const holdB = cache.retain("b")
      await Bun.sleep(0)
      expect(cache.view("a")?.row.title).toBe("Original")
      expect(cache.view("b")?.row.title).toBe("Original")
      const settled = { ...runs }

      rename("a", "Renamed")
      expect(cache.view("a")?.row.title).toBe("Renamed")
      expect(runs).toEqual({ ...settled, a: settled.a + 1 })

      // A session that becomes held wakes the readers that wait on it, and
      // its later changes reach only them.
      const holdLater = cache.retain("later")
      await Bun.sleep(0)
      expect(cache.view("later")?.row.title).toBe("Original")
      const beforeRename = { ...runs }
      rename("later", "Renamed")
      expect(runs).toEqual({ ...beforeRename, later: beforeRename.later + 1 })

      // The last release wakes only the released session's readers.
      holdA.release()
      expect(cache.view("a")).toBeUndefined()
      expect(runs).toEqual({ ...beforeRename, a: beforeRename.a + 1, later: beforeRename.later + 1 })

      // A release outside a batch leaves its reader waiting on the next
      // hold, so holding the session again wakes it, and so do later changes.
      const afterRelease = { ...runs }
      const holdAgain = cache.retain("a")
      await Bun.sleep(0)
      expect(cache.view("a")?.row.title).toBe("Original")
      expect(runs.a).toBeGreaterThan(afterRelease.a)
      const afterHold = { ...runs }
      rename("a", "Again")
      expect(runs).toEqual({ ...afterHold, a: afterHold.a + 1 })
      holdAgain.release()
      holdB.release()
      holdLater.release()
      dispose()
    })
  })
})
