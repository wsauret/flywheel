import { describe, expect, it, mock, setSystemTime } from "bun:test"
import { createEffect, createRoot, createSignal } from "solid-js"
import type { AttachedRuntimeClient, ChildSessionRow, RuntimeClient, FrontendEvent, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { budgetCursor, type BudgetView } from "../../../../src/protocol/budget-protocol-types.js"
import { sessionDetailCursor, type RuntimeSessionDetailView } from "../../../../src/protocol/session-detail-protocol-types.js"
import { statusCursor, type StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { sessionCursor } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { offeredSessionControls, workflowStateLabel } from "../../../../src/protocol/client/session-controls.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { createBudgetCache } from "../../../../src/tui/hooks/create-budget-cache.js"
import { sessionHeaderParts } from "../../../../src/tui/hooks/create-header-display.js"
import { createSessionCatalog } from "../../../../src/tui/hooks/create-session-catalog.js"
import { createSessionDetailCache, createSessionSurface as bindSessionSurface, type SessionSurfaceDeps } from "../../../../src/tui/hooks/create-session-surface.js"
import { createStatusCache } from "../../../../src/tui/hooks/create-status-cache.js"
import { catalogRow, readyCatalogRow, snapshotResult } from "../../../helpers/session-catalog.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { transcriptCache } from "./_session-surface-transcript-fixture.js"

const detailEvents = new WeakMap<RuntimeClient["query"], (row: RuntimeSessionDetailView["row"] | null, id: string) => void>()
/** The sessions each fake query's surface told the runtime it let go of. */
const detailReleases = new WeakMap<RuntimeClient["query"], string[]>()
/** Records the sessions a detail cache lets go of. */
function releaseRecorder(released: string[] = []): Pick<RuntimeClient, "dispatch"> & { readonly released: string[] } {
  return {
    released,
    // A detail release never lets go of the tab's activation, so the cache
    // dispatches no other mutation.
    dispatch: runtimeDispatch({ "session_detail.release": async (command) => {
      released.push(command.sessionId)
      return { ok: true }
    } }),
  }
}
/** Binds a surface whose detail reads go to `deps.appService.query`. The
 *  catalog has answered unless the test says otherwise. */
function createSessionSurface(deps: Omit<SessionSurfaceDeps, "detailCache" | "catalogReady"> & Partial<Pick<SessionSurfaceDeps, "detailCache" | "catalogReady">>, id: Parameters<typeof bindSessionSurface>[1]) {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const sequencer = createRuntimeUiPatchSequencer()
  const answer = runtimeQuery({ sessionDetailSnapshot: async (request) => ({
    snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["session_detail"] }),
    views: await Promise.all(request.sessionIds.map(async (sessionId) => ({ sessionId, view: (await deps.appService.query({ type: "sessionDetail", sessionId })).view }))),
  }) })
  detailEvents.set(deps.appService.query, (row, sessionId) => {
    const patch = sequencer.publish({ cursor: sessionDetailCursor(sessionId), payload: { kind: "session_detail.changed", row } })
    for (const listener of listeners) listener({ type: "patch", patch })
  })
  const releases = releaseRecorder()
  detailReleases.set(deps.appService.query, releases.released)
  const detailCache = deps.detailCache ?? createSessionDetailCache({
    query: answer,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, onLane: fakeLanes().onLane,
  }, releases)
  return bindSessionSurface({ catalogReady: () => true, ...deps, detailCache }, id)
}

const emptyCache = { ensure: () => {}, ensureMany: () => {}, view: () => undefined }
const query = runtimeQuery({ sessionDetail: () => ({ view: null }) })

function queryWithDetail(view: RuntimeSessionDetailView) {
  return runtimeQuery({ sessionDetail: () => ({ view }) })
}

describe("createSessionSurface", () => {
  it("shares held detail, orders pending metadata patches, and ignores unheld children", async () => {
    await createRoot(async (dispose) => {
      const listeners = new Set<(event: FrontendEvent) => void>()
      const send = (event: FrontendEvent) => { for (const listener of listeners) listener(event) }
      const sequencer = createRuntimeUiPatchSequencer()
      const pending = Promise.withResolvers<void>()
      const requests: string[][] = []
      const view: RuntimeSessionDetailView = {
        id: "chat", source: "durable", kind: "chat", conversationId: "conv",
        budget: null, row: catalogRow("chat", "Original"), status: {
          activity: "absent", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected",
          activeSubagentCount: 0, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
          waitingOnBackgroundWork: false, startedAt: 0,
          streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
        },
      }
      let blocked = true
      const queryDetails = runtimeQuery({ sessionDetailSnapshot: async (request) => {
        requests.push([...request.sessionIds])
        const snapshotPosition = sequencer.snapshotPosition({ kind: "workspace", domains: ["session_detail"] })
        if (blocked) await pending.promise
        return { snapshotPosition, views: request.sessionIds.map((sessionId) => ({ sessionId, view: { ...view, id: sessionId } })) }
      } })
      const releases = releaseRecorder()
      const lanes = fakeLanes()
      const reattach = (): void => { lanes.end(); send(LANE_BREAK); lanes.open() }
      const cache = createSessionDetailCache({
        query: queryDetails, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }, onLane: lanes.onLane,
      }, releases)
      send({ type: "patch", patch: { cursor: sessionDetailCursor("unheld"), position: 8, prevPosition: 7, payload: { kind: "session_detail.changed", row: null } } })
      expect(requests).toEqual([])
      const [first, second] = [cache.retain("chat"), cache.retain("chat")]
      const abandoned = cache.retain("gone")
      await Bun.sleep(0)
      abandoned.release()
      send({ type: "patch", patch: sequencer.publish({ cursor: sessionDetailCursor("chat"), payload: { kind: "session_detail.changed", row: { ...view.row, title: "Renamed" } } }) })
      pending.resolve()
      blocked = false
      await Bun.sleep(0)
      expect(cache.view("chat")?.row.title).toBe("Renamed")
      expect(cache.view("gone")).toBeUndefined()
      first.release()
      expect(cache.view("chat")?.row.title).toBe("Renamed")
      expect(requests).toEqual([["chat"], ["gone"]])
      expect(releases.released).toEqual(["gone"])
      second.release()
      expect(cache.view("chat")).toBeUndefined()
      // The runtime hears one release, from the last hold of the session,
      // once the read that took the hold has answered.
      await Bun.sleep(0)
      expect(releases.released).toEqual(["gone", "chat"])
      reattach()
      await Bun.sleep(0)
      expect(requests).toEqual([["chat"], ["gone"]])
      const live = cache.retain("chat")
      await Bun.sleep(0)
      reattach()
      await Bun.sleep(0)
      expect(requests).toEqual([["chat"], ["gone"], ["chat"], ["chat"]])
      live.release()
      dispose()
    })
  })
  it("never shows less active time than the status has accumulated, before and after the display clock's next tick", () => {
    createRoot((dispose) => {
      const [now, setNow] = createSignal(1_000_000)
      const running: StatusView = {
        activity: "thinking", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, activeBackgroundCommands: [],
        activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false, startedAt: 0,
        // The episode began after the display clock's last tick.
        streamingStartedAt: 1_000_400, accumulatedActiveMs: 58_700, compactionStartedAt: null, replyWaits: [],
      }
      const surface = createSessionSurface({
        appService: { query },
        transcriptCache: transcriptCache().cache,
        statusCache: { ensure: () => {}, ensureMany: () => {}, view: () => running },
        budgetCache: emptyCache, questionCache: emptyCache,
        row: () => undefined, now, hydrateToHead: async () => {}, onTranscriptFailure: () => {},
      }, () => "chat")

      expect(surface.elapsed()).toBe(58_700)
      setNow(1_001_000)
      expect(surface.elapsed()).toBe(59_300)
      dispose()
    })
  })

  it("binds shared caches to its session and owns an isolated retention handle", async () => {
    await createRoot(async (dispose) => {
      const transcript = transcriptCache()
      const [sessionId, setSessionId] = createSignal<string | undefined>("parent")
      const hydrate = mock(async () => {})
      const surface = createSessionSurface({
        appService: { query },
        transcriptCache: { ...transcript.cache, streamingOutputChars: (id) => id === "parent" ? 7 : 3 },
        statusCache: emptyCache,
        budgetCache: emptyCache,
        questionCache: emptyCache,
        row: () => undefined,
        now: () => 0,
        hydrateToHead: hydrate,
        onTranscriptFailure: () => {},
      }, sessionId)

      await Promise.resolve()
      expect(surface.sessionId()).toBe("parent")
      expect(surface.streamingOutputChars()).toBe(7)
      expect(transcript.retained).toEqual(["parent"])
      expect(transcript.opened).toEqual(["parent"])

      setSessionId("child")
      await Promise.resolve()
      expect(surface.streamingOutputChars()).toBe(3)
      expect(transcript.released).toEqual(["parent"])
      expect(transcript.retained).toEqual(["parent", "child"])

      dispose()
      expect(transcript.released).toEqual(["parent", "child"])
    })
  })

  it("keeps a nullable detail budget absent until an independent cache view replaces it", async () => {
    await createRoot(async (dispose) => {
      const transcript = transcriptCache()
      const [budget, setBudget] = createSignal<BudgetView>()
      const detail: RuntimeSessionDetailView = {
        id: "historical",
        source: "durable",
        kind: "chat",
        conversationId: "conversation",
        budget: null,
        row: {
          id: "historical",
          kind: "chat",
          title: "Historical",
          lifecycleState: "inactive",
          notices: [],
          inputMode: { kind: "chat" },
          lastUpdated: "2026-01-01T00:00:00.000Z",
          executionCwd: "/repo",
          totalsLoading: true,
        },
        status: {
          activity: "idle", activityStartedAt: 0,
          settledOutputPosition: null,
          connectionState: "connected",
          activeSubagentCount: 0,
          activeBackgroundCommands: [],
          activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
          waitingOnBackgroundWork: false,
          startedAt: 0,
          streamingStartedAt: null,
          accumulatedActiveMs: 0,
          compactionStartedAt: null, replyWaits: [],
        },
      }
      const surface = createSessionSurface({
        appService: { query: queryWithDetail(detail) },
        transcriptCache: transcript.cache,
        statusCache: emptyCache,
        budgetCache: { ensure: () => {}, ensureMany: () => {}, view: () => budget() },
        questionCache: emptyCache,
        row: () => undefined,
        now: () => 0,
        hydrateToHead: async () => {},
        onTranscriptFailure: () => {},
      }, () => "historical")

      await Bun.sleep(0)
      expect(surface.detail()?.budget).toBeNull()
      expect(surface.budget()).toBeUndefined()

      const ready: BudgetView = { totalsLoading: false, tokens: 25, cost: 0.25, billedCost: 0.1, priceUnavailable: false, contextPercent: 40, contextPromptTokens: 500 }
      setBudget(ready)
      expect(surface.budget()).toEqual(ready)
      dispose()
    })
  })

  it("replaces a child's admitted row without refetching when its status settles", async () => {
    await createRoot(async (dispose) => {
      const transcript = transcriptCache()
      const [childStatus, setChildStatus] = createSignal<StatusView | undefined>()
      const status = (activity: StatusView["activity"]): StatusView => ({
        activity, activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, activeBackgroundCommands: [],
        activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false, startedAt: 0, streamingStartedAt: null,
        accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
      })
      const row = (admittedActions: Extract<ChildSessionRow, { kind: "subagent" }>["admittedActions"]): Extract<ChildSessionRow, { kind: "subagent" }> => ({
        id: "child", kind: "subagent", title: "Child", lifecycleState: "active", notices: [], inputMode: { kind: "message" },
        admittedActions, lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/repo", totalsLoading: true,
      })
      const live: RuntimeSessionDetailView = { id: "child", source: "live", kind: "subagent", conversationId: "conv", streamingToolText: {}, budget: { totalsLoading: true }, row: row(["session.send", "subagent.interrupt", "background.terminate", "session.delete"]), status: status("generating") }
      const settled: RuntimeSessionDetailView = { id: "child", source: "durable", kind: "subagent", conversationId: "conv", budget: null, row: { ...row(["session.delete"]), lifecycleState: "inactive" }, status: status("absent") }
      let reads = 0
      const detailQuery = runtimeQuery({ sessionDetail: () => {
        reads += 1
        return { view: reads === 1 ? live : settled }
      } })
      const surface = createSessionSurface({
        appService: { query: detailQuery },
        transcriptCache: transcript.cache,
        statusCache: { ensure: () => {}, ensureMany: () => {}, view: () => childStatus() },
        budgetCache: emptyCache,
        questionCache: emptyCache,
        row: () => undefined,
        now: () => 0,
        hydrateToHead: async () => {},
        onTranscriptFailure: () => {},
      }, () => "child")
      const admitted = () => { const current = surface.summary(); return current?.kind === "subagent" ? current.admittedActions : undefined }
      await Bun.sleep(0)
      expect(reads).toBe(1)
      // The status stream arriving is not a reason to read again.
      setChildStatus(status("generating"))
      await Bun.sleep(0)
      expect(reads).toBe(1)
      expect(admitted()).toEqual(["session.send", "subagent.interrupt", "background.terminate", "session.delete"])
      // The runtime drops the child's status when it settles: detail is read
      // again, and the surface shows the settled row and status, not the live ones.
      setChildStatus(status("absent"))
      detailEvents.get(detailQuery)?.(settled.row, "child")
      await Bun.sleep(0)
      expect(reads).toBe(1)
      expect(admitted()).toEqual(["session.delete"])
      expect(surface.status()?.activity).toBe("absent")
      expect(surface.agentState()).toBe("idle")
      expect(surface.sessionState()).toBe("inactive")
      dispose()
    })
  })

  it("does not refetch detail when activity crosses the admission line", async () => {
    await createRoot(async (dispose) => {
      const transcript = transcriptCache()
      const [childStatus, setChildStatus] = createSignal<StatusView | undefined>()
      const status = (activity: StatusView["activity"]): StatusView => ({
        activity, activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, activeBackgroundCommands: [],
        activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false, startedAt: 0, streamingStartedAt: null,
        accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
      })
      let reads = 0
      const detailQuery = runtimeQuery({ sessionDetail: () => {
        reads += 1
        return { view: null }
      } })
      createSessionSurface({
        appService: { query: detailQuery },
        transcriptCache: transcript.cache,
        statusCache: { ensure: () => {}, ensureMany: () => {}, view: () => childStatus() },
        budgetCache: emptyCache, questionCache: emptyCache,
        row: () => undefined, now: () => 0, hydrateToHead: async () => {}, onTranscriptFailure: () => {},
      }, () => "child")
      await Bun.sleep(0)
      setChildStatus(status("thinking"))
      await Bun.sleep(0)
      expect(reads).toBe(1)
      setChildStatus(status("executing_tools"))
      await Bun.sleep(0)
      expect(reads).toBe(1)
      setChildStatus(status("idle"))
      await Bun.sleep(0)
      expect(reads).toBe(1)
      dispose()
    })
  })

  it("reads a listed root chat's Resume from its catalog row and never holds its detail", async () => {
    for (const before of [{ activity: "generating", waitingOnBackgroundWork: false }, { activity: "idle", waitingOnBackgroundWork: true }] as const) {
      await createRoot(async (dispose) => {
        const [chatStatus, setChatStatus] = createSignal<StatusView | undefined>()
        const status = (reading: Pick<StatusView, "activity" | "waitingOnBackgroundWork">): StatusView => ({
          ...reading, activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, activeBackgroundCommands: [],
          activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: null,
          accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
        })
        const chat = (admittedActions: SessionCatalogRow["admittedActions"]): SessionCatalogRow => ({ id: "chat", kind: "chat", title: "Chat", lifecycleState: "active", notices: [], inputMode: { kind: "chat" }, admittedActions, lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/repo", totalsLoading: true })
        const [listed, setListed] = createSignal(chat(["chat.interrupt", "session.delete"]))
        const reads: string[] = []
        const detailQuery = runtimeQuery({ sessionDetail: (request) => {
          reads.push(request.type)
          return { view: null }
        } })
        const surface = createSessionSurface({
          appService: { query: detailQuery },
          transcriptCache: transcriptCache().cache,
          statusCache: { ensure: () => {}, ensureMany: () => {}, view: () => chatStatus() },
          budgetCache: emptyCache, questionCache: emptyCache,
          row: (id) => id === "chat" ? listed() : undefined, now: () => 0, hydrateToHead: async () => {}, onTranscriptFailure: () => {},
        }, () => "chat")
        const offered = () => offeredSessionControls(surface.summary(), surface.interruptible())
        setChatStatus(status(before))
        await Bun.sleep(0)
        expect(offered().primary).toBe("interrupt")

        // The interrupt reports nothing until its record is durable; the
        // runtime then lists the chat with Resume, and the park after it
        // reports the settled status.
        setListed(chat(["chat.resume", "session.delete"]))
        setChatStatus(status({ activity: "idle", waitingOnBackgroundWork: false }))
        await Bun.sleep(0)
        expect(surface.interruptible()).toBe(false)
        expect(offered().primary).toBe("resume")
        expect(surface.loadResult()).toBeUndefined()
        dispose()
        expect(reads).toEqual([])
        expect(detailReleases.get(detailQuery)).toEqual([])
      })
    }
  })

  it("holds a chat's detail only once the catalog has answered without it, and lets go when the catalog lists it", async () => {
    await createRoot(async (dispose) => {
      const [ready, setReady] = createSignal(false)
      const [listed, setListed] = createSignal<SessionCatalogRow | undefined>()
      const reads: string[] = []
      const detailQuery = runtimeQuery({ sessionDetail: (request) => {
        reads.push(request.sessionId)
        return { view: null }
      } })
      const surface = createSessionSurface({
        appService: { query: detailQuery },
        transcriptCache: transcriptCache().cache,
        statusCache: emptyCache, budgetCache: emptyCache, questionCache: emptyCache,
        row: () => listed(), catalogReady: ready, now: () => 0, hydrateToHead: async () => {}, onTranscriptFailure: () => {},
      }, () => "chat")
      await Bun.sleep(0)
      expect(reads).toEqual([])
      // A catalog that answered without the chat: it is gone, and its detail says so.
      setReady(true)
      await Bun.sleep(0)
      expect(reads).toEqual(["chat"])
      expect(surface.loadResult()).toEqual({ id: "chat", view: null, loadError: undefined })
      setListed(catalogRow("chat", "Chat"))
      await Bun.sleep(0)
      expect(detailReleases.get(detailQuery)).toEqual(["chat"])
      expect(surface.summary()?.title).toBe("Chat")
      dispose()
    })
  })

  it("lets go of a detail only after the read that holds it answered, and never while it is held again", async () => {
    await createRoot(async (dispose) => {
      // Every read waits, as one queued behind other snapshot reads does.
      const gate = Promise.withResolvers<void>()
      const detailQuery = runtimeQuery({ sessionDetail: async () => {
        await gate.promise
        return { view: null }
      } })
      const [shown, setShown] = createSignal<string | undefined>("child")
      createSessionSurface({
        appService: { query: detailQuery },
        transcriptCache: transcriptCache().cache,
        statusCache: emptyCache, budgetCache: emptyCache, questionCache: emptyCache,
        row: () => undefined, now: () => 0, hydrateToHead: async () => {}, onTranscriptFailure: () => {},
      }, shown)
      await Bun.sleep(0)
      setShown(undefined)
      await Bun.sleep(0)
      // The read still takes the hold when it reaches the runtime, so a
      // release sent now would arrive first and let go of nothing.
      expect(detailReleases.get(detailQuery)).toEqual([])
      setShown("child")
      gate.resolve()
      await Bun.sleep(0)
      await Bun.sleep(0)
      expect(detailReleases.get(detailQuery)).toEqual([])
      setShown(undefined)
      await Bun.sleep(0)
      expect(detailReleases.get(detailQuery)).toEqual(["child"])
      dispose()
    })
  })

  it("reads a stopped workflow member from its ordinary detail and admits no Resume", async () => {
    await createRoot(async (dispose) => {
      const listed: Extract<RuntimeSessionDetailView, { kind: "workflow-agent" }>["row"] = {
        id: "wf", kind: "workflow-agent", workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt-1" }, title: "Investigate", lifecycleState: "inactive", notices: [], inputMode: { kind: "message" },
        admittedActions: ["chat.resume", "session.delete"], parentSessionId: "parent",
        lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/repo", totalsLoading: true,
      }
      const view: RuntimeSessionDetailView = { id: "wf", source: "durable", kind: "workflow-agent", conversationId: "conv-wf", budget: null, row: { ...listed, admittedActions: ["session.delete"], stoppedBy: "person" }, status: {
        activity: "absent", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, activeBackgroundCommands: [],
        activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false, startedAt: 0, streamingStartedAt: null,
        accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
      } }
      const surface = createSessionSurface({
        appService: { query: queryWithDetail(view) },
        transcriptCache: transcriptCache().cache,
        statusCache: emptyCache,
        budgetCache: emptyCache, questionCache: emptyCache,
        row: () => undefined, now: () => 0, hydrateToHead: async () => {}, onTranscriptFailure: () => {},
      }, () => "wf")
      await Bun.sleep(0)
      const summary = surface.summary()
      expect(summary?.stoppedBy).toBe("person")
      expect(workflowStateLabel("paused", summary)).toBe("Stopped")
      expect(offeredSessionControls(summary, false).primary).toBeNull()
      dispose()
    })
  })
})

describe("a surface across a reattach", () => {
  /** The status of a turn whose clock runs from `since` after `accumulated`. */
  function turnStatus(activity: StatusView["activity"], accumulated: number, since: number | null): StatusView {
    return {
      activity, activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, activeBackgroundCommands: [],
      activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false, startedAt: 0,
      streamingStartedAt: since, accumulatedActiveMs: accumulated, compactionStartedAt: null, replyWaits: [],
    }
  }
  function budgetAt(contextPromptTokens: number): BudgetView {
    return { totalsLoading: false, tokens: contextPromptTokens, cost: 0.1, billedCost: 0, priceUnavailable: false, contextPercent: contextPromptTokens / 2_700, contextPromptTokens }
  }
  /** What the runtime serving the lane answers for the session. */
  interface Serving {
    row: SessionCatalogRow
    budget: BudgetView
    status: StatusView
  }
  /** The runtime at the other end of the lane: its answers, the patches it
   *  publishes, and a lane that breaks and attaches to its successor. */
  function lane() {
    const sequencer = createRuntimeUiPatchSequencer()
    const listeners = new Set<(event: FrontendEvent) => void>()
    const deliver = (event: FrontendEvent): void => { for (const listener of listeners) listener(event) }
    let broken = false
    const serving: Serving = {
      row: readyCatalogRow("chat", "Five-step run", { contextPercent: 15, contextPromptTokens: 40_500, durationMs: 50_000, totalCost: 0.1, totalBilledCost: 0 }),
      budget: budgetAt(40_500),
      status: turnStatus("executing_tools", 50_000, 1_000_000),
    }
    const lanes = fakeLanes()
    const up = (): void => { if (broken) throw new Error("the lane is down") }
    const answer = runtimeQuery({
      snapshot: async () => { up(); return snapshotResult([serving.row], sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })) },
      budgetSnapshot: async (request) => { up(); return { views: request.sessionIds.map((sessionId) => ({ sessionId, view: serving.budget })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["budget"] }) } },
      statusSnapshot: async (request) => { up(); return { views: request.sessionIds.map((sessionId) => ({ sessionId, view: serving.status })), snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["status"] }) } },
      sessionDetail: async () => { up(); return { view: null } },
    })
    const client = {
      query: answer,
      subscribe: (next: (event: FrontendEvent) => void) => {
        listeners.add(next)
        return () => { listeners.delete(next) }
      },
      onLane: lanes.onLane,
    } satisfies Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
    return {
      client,
      serving,
      breakLane() {
        broken = true
        lanes.end()
        deliver({ type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 0, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "reconnect_required" } } })
      },
      attach() {
        broken = false
        lanes.open()
      },
      publishRow(row: SessionCatalogRow) { deliver({ type: "patch", patch: sequencer.publish({ cursor: sessionCursor(row.id), payload: { kind: "session.updated", row } }) }) },
      publishBudget(budget: BudgetView) { deliver({ type: "patch", patch: sequencer.publish({ cursor: budgetCursor("chat"), payload: { kind: "budget.updated", budget } }) }) },
      publishStatus(status: StatusView) { deliver({ type: "patch", patch: sequencer.publish({ cursor: statusCursor("chat"), payload: { kind: "status.updated", status } }) }) },
    }
  }

  it("shows the last known totals, context, and time until the successor's values replace them, and the time never steps back", async () => {
    try {
      await createRoot(async (dispose) => {
        setSystemTime(new Date(1_008_000))
        const runtime = lane()
        const statusCache = createStatusCache({ appService: runtime.client })
        const catalog = createSessionCatalog({ appService: runtime.client, projectRoot: "/workspace" })
        const [now, setNow] = createSignal(1_008_000)
        const surface = createSessionSurface({
          appService: { query: runtime.client.query },
          transcriptCache: transcriptCache().cache,
          statusCache,
          budgetCache: createBudgetCache({ appService: runtime.client }),
          questionCache: emptyCache,
          row: catalog.row, now, hydrateToHead: async () => {}, onTranscriptFailure: () => {},
        }, () => "chat")
        statusCache.ensureMany(["chat"])
        const shown: string[] = []
        createEffect(() => {
          const parts = sessionHeaderParts(surface, 120, 270_000)
          shown.push(`${parts.before}${parts.context}${parts.after}`)
        })
        await Bun.sleep(1)
        expect(shown.at(-1)).toBe("58s · 15% ctx · ~$0.10")

        // A planned replacement cuts the turn at 1_008_300, then closes the
        // lane 10 ms later; the display clock ticks while nothing is attached.
        setSystemTime(new Date(1_008_310))
        runtime.breakLane()
        setNow(1_009_000)
        // The successor has not read the session's totals yet, and shows its
        // turn waiting at the time recorded at the cut.
        runtime.serving.row = catalogRow("chat", "Five-step run")
        runtime.serving.budget = { totalsLoading: true }
        runtime.serving.status = turnStatus("waiting", 58_300, null)
        runtime.attach()
        await Bun.sleep(1)
        // It resumes the turn, then reads the totals, which have moved on.
        runtime.publishStatus(turnStatus("thinking", 58_300, 1_009_500))
        setNow(1_010_000)
        runtime.publishBudget(budgetAt(21_600))
        runtime.publishRow(readyCatalogRow("chat", "Five-step run", { contextPercent: 8, contextPromptTokens: 21_600, durationMs: 58_300, totalCost: 0.1, totalBilledCost: 0 }))
        setNow(1_011_000)

        expect(shown.at(-1)).toBe("59s · 8% ctx · ~$0.10")
        // A first load marks what it does not know yet; from the first
        // complete header on, every header is complete.
        const known = shown.slice(shown.indexOf("58s · 15% ctx · ~$0.10"))
        expect(known.filter((text) => text.includes("totals loading") || text.includes("… ctx") || !/^\d+s · \d+% ctx · /.test(text))).toEqual([])
        const seconds = known.map((text) => Number(/^(\d+)s/.exec(text)?.[1]))
        expect(seconds).toEqual([...seconds].sort((a, b) => a - b))
        dispose()
      })
    } finally {
      setSystemTime()
    }
  })
})
