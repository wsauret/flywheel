import { describe, expect, it, mock } from "bun:test"
import type { ChildSessionRow, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeSessionDetailView } from "../../../../src/protocol/session-detail-protocol-types.js"
import { createLinkNavigator, createSessionActivator, createSessionActivatorById } from "../../../../src/tui/hooks/session-activation.js"
import { RuntimeCallTimeout } from "../../../../src/protocol/runtime-client-deadlines.js"
import { sessionLink, workflowLink } from "../../../../src/protocol/client/session-links.js"
import { createOverlayLayers } from "../../../../src/tui/components/modal-stack.js"
import { runtimeDispatch, runtimeQuery, type DispatchAnswer } from "../../../helpers/runtime-dispatch.js"

function sessionClient(discard: DispatchAnswer<"session.discard_transient">) {
  return { dispatch: runtimeDispatch({ "session.discard_transient": discard }) }
}

function session(id: string, kind: "chat"): SessionCatalogRow {
  const common = {
    id,
    title: id,
    shortTitle: id,
    executionCwd: "/scratch/flywheel-test",
    lifecycleState: "inactive" as const,
    activity: "idle" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUpdated: "2026-01-01T00:00:00.000Z",
    notices: [],
    totalsLoading: true as const,
  }
  return { ...common, kind, inputMode: { kind: "chat" } }
}

describe("session selection", () => {
  it("selects a durable catalog row from a pending foreground without dispatching cleanup for the local key", async () => {
    let foregroundId: string | undefined
    const dispatch = mock(async () => ({ ok: true as const }))
    const transientLookup = mock(() => true)
    const activate = createSessionActivator({
      signals: { foregroundId: () => foregroundId, setForegroundId: (id) => { foregroundId = id } },
      draftCache: { hasDraft: () => true }, appService: sessionClient(dispatch),
      openSessionTab: () => {}, closeSessionTab: () => {}, isTransientSessionTab: transientLookup, showToast: () => {}
    })
    await activate(session("durable", "chat"))
    expect(foregroundId).toBe("durable")
    expect(transientLookup).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  for (const kind of ["chat"] as const) {
    it(`opens a cold ${kind} without discarding a nontransient tab`, async () => {
      let foregroundId: string | undefined = "current"
      const dispatch = mock(async () => ({ ok: true as const }))
      const openSessionTab = mock(() => {})
      const activate = createSessionActivator({
        signals: {
          foregroundId: () => foregroundId,
          setForegroundId: (id) => { foregroundId = id },
        },
        draftCache: { hasDraft: () => false },
        appService: sessionClient(dispatch),
        openSessionTab,
        closeSessionTab: mock(() => {}),
        isTransientSessionTab: () => false,
        showToast: mock(() => {})
      })

      expect(await activate(session("cold", kind))).toEqual({ ok: true })

      expect(dispatch).not.toHaveBeenCalled()
      expect(openSessionTab).toHaveBeenCalledWith("cold")
      expect(foregroundId).toBe("cold")
    })
  }

  it("replaces an empty New Chat tab when the runtime removes it", async () => {
    let foregroundId: string | undefined = "new"
    const dispatch = mock(async () => ({ ok: true as const, sessionRemoved: true }))
    const closeSessionTab = mock(() => {})
    const activate = createSessionActivator({
      signals: {
        foregroundId: () => foregroundId,
        setForegroundId: (id) => { foregroundId = id },
      },
      draftCache: { hasDraft: () => false },
      appService: sessionClient(dispatch),
      openSessionTab: mock(() => {}),
      closeSessionTab,
      isTransientSessionTab: (id) => id === "new",
      showToast: mock(() => {})
    })

    expect(await activate(session("existing", "chat"))).toEqual({ ok: true })

    expect(dispatch).toHaveBeenCalledWith({ type: "session.discard_transient", sessionId: "new" })
    expect(closeSessionTab).toHaveBeenCalledWith("new")
    expect(foregroundId).toBe("existing")
  })

  it("preserves an empty New Chat tab with a draft", async () => {
    let foregroundId: string | undefined = "new"
    const dispatch = mock(async () => ({ ok: true as const, sessionRemoved: true }))
    const closeSessionTab = mock(() => {})
    const activate = createSessionActivator({
      signals: {
        foregroundId: () => foregroundId,
        setForegroundId: (id) => { foregroundId = id },
      },
      draftCache: { hasDraft: (id) => id === "new" },
      appService: sessionClient(dispatch),
      openSessionTab: mock(() => {}),
      closeSessionTab,
      isTransientSessionTab: (id) => id === "new",
      showToast: mock(() => {})
    })

    await activate(session("existing", "chat"))

    expect(dispatch).not.toHaveBeenCalled()
    expect(closeSessionTab).not.toHaveBeenCalled()
  })

  it("does not discard the selected session when it is already foreground", async () => {
    let foregroundId: string | undefined = "existing"
    const dispatch = mock(async () => ({ ok: true as const, sessionRemoved: true }))
    const activate = createSessionActivator({
      signals: {
        foregroundId: () => foregroundId,
        setForegroundId: (id) => { foregroundId = id },
      },
      draftCache: { hasDraft: () => false },
      appService: sessionClient(dispatch),
      openSessionTab: mock(() => {}),
      closeSessionTab: mock(() => {}),
      isTransientSessionTab: () => true,
      showToast: mock(() => {})
    })

    await activate(session("existing", "chat"))

    expect(dispatch).not.toHaveBeenCalled()
  })

  it("preserves the empty New Chat tab when the runtime refuses removal", async () => {
    let foregroundId: string | undefined = "new"
    const dispatch = mock(async () => ({ ok: true as const, sessionRemoved: false }))
    const closeSessionTab = mock(() => {})
    const activate = createSessionActivator({
      signals: {
        foregroundId: () => foregroundId,
        setForegroundId: (id) => { foregroundId = id },
      },
      draftCache: { hasDraft: () => false },
      appService: sessionClient(dispatch),
      openSessionTab: mock(() => {}),
      closeSessionTab,
      isTransientSessionTab: () => true,
      showToast: mock(() => {})
    })

    await activate(session("existing", "chat"))

    expect(dispatch).toHaveBeenCalledWith({ type: "session.discard_transient", sessionId: "new" })
    expect(closeSessionTab).not.toHaveBeenCalled()
  })

  it("dismisses the modal stack before activating a session", async () => {
    const order: string[] = []
    const activate = createSessionActivator({
      signals: { foregroundId: () => "parent", setForegroundId: () => { order.push("foreground") } },
      draftCache: { hasDraft: () => false },
      appService: sessionClient(async () => ({ ok: true })),
      openSessionTab: () => { order.push("tab") },
      closeSessionTab: () => {},
      isTransientSessionTab: () => false,
      showToast: () => {},
      dismissModalStack: () => { order.push("dismiss") },
    })

    await activate(session("other-chat", "chat"))

    expect(order).toEqual(["dismiss", "tab", "foreground"])
  })

  it("clears both overlay layers before activating a normal session", async () => {
    const overlay = createOverlayLayers()
    overlay.viewer.push("viewer")
    overlay.dialog.push("dialog")
    const activate = createSessionActivator({
      signals: { foregroundId: () => "parent", setForegroundId: () => {} },
      draftCache: { hasDraft: () => false },
      appService: sessionClient(async () => ({ ok: true })),
      openSessionTab: () => {},
      closeSessionTab: () => {},
      isTransientSessionTab: () => false,
      showToast: () => {},
      dismissModalStack: overlay.clear,
    })

    await activate(session("other-chat", "chat"))

    expect(overlay.dialog.stack).toHaveLength(0)
    expect(overlay.viewer.stack).toHaveLength(0)
  })
})

describe("session activation by id", () => {
  const status: RuntimeSessionDetailView["status"] = {
    activity: "idle", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0,
    activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false,
    startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
  }
  const childRow: ChildSessionRow = {
    id: "child", kind: "subagent", title: "Child", lifecycleState: "active", notices: [], inputMode: { kind: "message" },
    admittedActions: ["session.send", "subagent.interrupt", "background.terminate", "session.delete"], parentSessionId: "parent",
    lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/scratch/flywheel-test", totalsLoading: true,
  }
  function detailClient(views: { readonly [sessionId: string]: RuntimeSessionDetailView | null }) {
    const queried: string[] = []
    const query = runtimeQuery({
      sessionDetail: async (request) => {
        queried.push(request.sessionId)
        return { view: views[request.sessionId] ?? null }
      },
    })
    return { query, queried }
  }
  function activator(views: { readonly [sessionId: string]: RuntimeSessionDetailView | null }, rows: readonly SessionCatalogRow[] = []) {
    const client = detailClient(views)
    const activateSession = mock(async (_session: SessionCatalogRow) => ({ ok: true as const }))
    const openChild = mock((_child: { readonly id: string; readonly kind: "chat" | "subagent" | "workflow-agent" }) => {})
    const seedSessionCatalogRow = mock((_row: SessionCatalogRow) => {})
    const showToast = mock((_toast: { message: string; variant: "info" | "warning" | "error" | "success" }) => {})
    const activate = createSessionActivatorById({ rows: () => rows, appService: client, activateSession, openChild, seedSessionCatalogRow, showToast })
    return { activate, activateSession, openChild, seedSessionCatalogRow, showToast, queried: client.queried }
  }

  it("activates a listed session from its catalog row without a detail read", async () => {
    const listed = session("listed", "chat")
    const a = activator({}, [listed])
    await a.activate("listed")
    expect(a.activateSession).toHaveBeenCalledWith(listed)
    expect(a.queried).toEqual([])
  })

  it("opens a child, which never has a catalog row, over its chat through its detail", async () => {
    const parent = session("parent", "chat")
    const a = activator({ child: { source: "durable", id: "child", kind: "subagent", conversationId: "conv", budget: null, row: childRow, status } }, [parent])
    await a.activate("child")
    expect(a.queried).toEqual(["child"])
    expect(a.openChild).toHaveBeenCalledWith({ id: "child", kind: "subagent" })
    expect(a.activateSession).toHaveBeenCalledWith(parent)
    expect(a.showToast).not.toHaveBeenCalled()
  })

  it("activates a listed session whose row has not reached this window from the row its detail carries", async () => {
    const late = session("late", "chat")
    const a = activator({ late: { source: "durable", id: "late", kind: "chat", conversationId: "conv", budget: null, row: late, status } })
    await a.activate("late")
    expect(a.seedSessionCatalogRow).toHaveBeenCalledWith(late)
    expect(a.activateSession).toHaveBeenCalledWith(late)
  })

  it("resolves a workflow member and its subagent into root-to-leaf viewers without child catalog rows", async () => {
    const parent = session("parent", "chat")
    const a = activator({
      workflow: {
        source: "durable", id: "workflow", kind: "workflow-agent", conversationId: "member-conv", budget: null, status,
        row: { ...childRow, id: "workflow", kind: "workflow-agent", workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt-1" }, inputMode: { kind: "message" }, admittedActions: ["session.delete"] },
      },
      child: { source: "durable", id: "child", kind: "subagent", conversationId: "conv", budget: null, status, row: { ...childRow, parentSessionId: "workflow" } },
    }, [parent])
    await a.activate("child")
    expect(a.queried).toEqual(["child", "workflow"])
    expect(a.activateSession).toHaveBeenCalledWith(parent)
    expect(a.openChild.mock.calls).toEqual([[{ id: "workflow", kind: "workflow-agent" }], [{ id: "child", kind: "subagent" }]])
    expect(a.seedSessionCatalogRow).not.toHaveBeenCalled()
  })

  it("opens an exact workflow member link over its chat through the ordinary child viewer", async () => {
    const parent = session("parent", "chat")
    const a = activator({
      workflow: {
        source: "durable", id: "workflow", kind: "workflow-agent", conversationId: "member-conv", budget: null, status,
        row: { ...childRow, id: "workflow", kind: "workflow-agent", workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt-1" }, inputMode: { kind: "message" }, admittedActions: ["session.delete"] },
      },
    }, [parent])
    await a.activate("workflow")
    expect(a.activateSession).toHaveBeenCalledWith(parent)
    expect(a.openChild).toHaveBeenLastCalledWith({ id: "workflow", kind: "workflow-agent" })
  })

  it("reports only a session the runtime no longer has", async () => {
    const a = activator({ gone: null })
    await a.activate("gone")
    expect(a.showToast).toHaveBeenCalledWith({ message: "Session gone no longer exists", variant: "error" })
    expect(a.activateSession).not.toHaveBeenCalled()
    expect(a.openChild).not.toHaveBeenCalled()
  })
})

describe("link navigation", () => {
  type Toast = { message: string; variant: "info" | "warning" | "error" | "success" }
  /** Follows one link and waits past the turn in which a rejection nobody
   *  handled would fail this test. */
  async function follow(navigate: (uri: string) => void, uri: string): Promise<void> {
    navigate(uri)
    await Bun.sleep(1)
  }

  it("reports a session link whose detail read times out instead of leaving the rejection unhandled", async () => {
    const timeout = RuntimeCallTimeout.forDeadline(5_000)
    const activateById = createSessionActivatorById({
      rows: () => [],
      appService: { query: () => Promise.reject(timeout) },
      activateSession: mock(async () => ({ ok: true as const })),
      openChild: () => {},
      seedSessionCatalogRow: () => {},
      showToast: () => {},
    })
    const toasts: Toast[] = []
    const navigate = createLinkNavigator({ openSession: activateById, openModuleUri: async () => false, showToast: (toast) => { toasts.push(toast) } })

    await follow(navigate, sessionLink("child"))
    expect(toasts).toEqual([{ message: `Open failed for child: ${timeout.message}`, variant: "error" }])
  })

  it("reports a module link whose open fails instead of leaving the rejection unhandled", async () => {
    const toasts: Toast[] = []
    const navigate = createLinkNavigator({
      openSession: async () => {},
      openModuleUri: () => Promise.reject(new Error("workflow read failed")),
      showToast: (toast) => { toasts.push(toast) },
    })
    const uri = workflowLink("run")

    await follow(navigate, uri)
    expect(toasts).toEqual([{ message: `Open failed for ${uri}: workflow read failed`, variant: "error" }])
  })
})
