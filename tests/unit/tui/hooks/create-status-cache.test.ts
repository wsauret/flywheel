import { describe, expect, it, setSystemTime } from "bun:test"
import { createRoot } from "solid-js"
import type { AttachedRuntimeClient, FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { statusCursor, type StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { createStatusCache } from "../../../../src/tui/hooks/create-status-cache.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

function status(overrides: Partial<StatusView> = {}): StatusView {
  return {
    activity: "idle",
    settledOutputPosition: 0,
    activityStartedAt: 0,
    connectionState: "connected",
    activeSubagentCount: 0,
    waitingOnBackgroundWork: false,
    activeBackgroundCommands: [],
    activeForegroundBashToolCallIds: [],
    processorHeldToolCallIds: [],
    startedAt: 100,
    streamingStartedAt: null,
    accumulatedActiveMs: 0,
    compactionStartedAt: null,
    replyWaits: [],
    ...overrides,
  }
}

interface InitialStatuses {
  [sessionId: string]: StatusView
}

function fakeAppService(initial: InitialStatuses = {}) {
  const sequencer = createRuntimeUiPatchSequencer()
  const snapshots = new Map(Object.entries(initial))
  let snapshotCalls = 0
  let listener: ((event: FrontendEvent) => void) | null = null
  let lastPatch: FrontendEvent & { type: "patch" } | null = null

  const query = runtimeQuery({ statusSnapshot: async (request) => {
    snapshotCalls += 1
    return { views: request.sessionIds.map((sessionId) => ({ sessionId, view: snapshots.get(sessionId) ?? null })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["status"] }) }
  } })
  const lanes = fakeLanes()

  const service = {
    query,
    subscribe: (l: (event: FrontendEvent) => void) => {
      listener = l
      return () => { listener = null }
    },
    onLane: lanes.onLane,
  } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">

  return {
    service,
    /** The lane came back after a break: the runtime attaches again. */
    reconnect: () => { lanes.open() },
    /** The lane broke: the connection voids what every receiver holds. */
    breakLane: () => {
      lanes.end()
      listener?.({ type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 0, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "reconnect_required" } } })
    },
    setSnapshot: (sessionId: string, next: StatusView) => { snapshots.set(sessionId, next) },
    dropSnapshot: (sessionId: string) => { snapshots.delete(sessionId) },
    snapshotCalls: () => snapshotCalls,
    live: (sessionId: string, next: StatusView) => {
      lastPatch = { type: "patch", patch: sequencer.publish({ cursor: statusCursor(sessionId), payload: { kind: "status.updated", status: next } }) }
      listener?.(lastPatch)
    },
    redeliverLastPatch: () => { if (lastPatch) listener?.(lastPatch) },
    skipThenLive: (sessionId: string, next: StatusView) => {
      sequencer.publish({ cursor: statusCursor(sessionId), payload: { kind: "status.updated", status: status({ activity: "thinking", settledOutputPosition: null }) } })
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: statusCursor(sessionId), payload: { kind: "status.updated", status: next } }) })
    },
  }
}

describe("createStatusCache", () => {
  it("re-reads every held status once the runtime attaches again and drops a session the runtime no longer serves", async () => {
    await createRoot(async (dispose) => {
      const running = status({ activity: "executing_tools", settledOutputPosition: null })
      const fake = fakeAppService({ "chat-1": running, "chat-2": status() })
      const cache = createStatusCache({ appService: fake.service })
      cache.ensureMany(["chat-1", "chat-2"])
      await Bun.sleep(0)
      expect(cache.view("chat-1")?.activity).toBe("executing_tools")
      const before = fake.snapshotCalls()

      // The runtime restarted while chat-1's tool ran: its session opened
      // paused and holds no live status any more; chat-2 keeps one.
      fake.dropSnapshot("chat-1")
      fake.setSnapshot("chat-2", status({ accumulatedActiveMs: 7 }))
      fake.breakLane()
      fake.reconnect()
      // The held view stays on screen until the fresh read lands.
      expect(cache.view("chat-1")?.activity).toBe("executing_tools")
      await Bun.sleep(0)

      expect(fake.snapshotCalls()).toBe(before + 1)
      expect(cache.view("chat-1")).toBeUndefined()
      expect(cache.view("chat-2")?.accumulatedActiveMs).toBe(7)
      dispose()
    })
  })

  it("stops a held status's clock where the lane broke, and keeps it there until the next lane's status replaces it", async () => {
    try {
      await createRoot(async (dispose) => {
        setSystemTime(new Date(1_000_000))
        const running = status({ activity: "waiting", settledOutputPosition: null, accumulatedActiveMs: 50_000, streamingStartedAt: 990_000 })
        const fake = fakeAppService({ "chat-1": running, "chat-2": status({ accumulatedActiveMs: 4_000 }) })
        const cache = createStatusCache({ appService: fake.service })
        cache.ensureMany(["chat-1", "chat-2"])
        await Bun.sleep(0)
        expect(cache.view("chat-1")).toEqual(running)

        setSystemTime(new Date(1_002_500))
        fake.breakLane()
        expect(cache.view("chat-1")).toEqual({ ...running, accumulatedActiveMs: 62_500, streamingStartedAt: null })
        expect(cache.view("chat-2")).toEqual(status({ accumulatedActiveMs: 4_000 }))

        // The successor runtime's status for the session replaces it.
        const continued = status({ activity: "thinking", settledOutputPosition: null, accumulatedActiveMs: 62_400, streamingStartedAt: 1_003_000 })
        fake.setSnapshot("chat-1", continued)
        setSystemTime(new Date(1_003_500))
        fake.reconnect()
        await Bun.sleep(0)
        expect(cache.view("chat-1")).toEqual(continued)
        dispose()
      })
    } finally {
      setSystemTime()
    }
  })

})
