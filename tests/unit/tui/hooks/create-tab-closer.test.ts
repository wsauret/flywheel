import { describe, expect, it, mock } from "bun:test"
import { createComputed, createMemo, createRoot, createSignal } from "solid-js"
import type { FrontendMutation, MutationResult, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"
import { createTabCloser } from "../../../../src/tui/hooks/create-tab-closer.js"
import type { TabInfo } from "../../../../src/tui/hooks/create-tabs.js"

function tab(id: string, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    kind: "session",
    id,
    title: "Chat",
    isForeground: false,
    isBusy: false,
    isBlocked: false,
    ...overrides,
  }
}

function catalogRow(id: string): SessionCatalogRow {
  return {
    id,
    kind: "chat",
    title: "History",
    lifecycleState: "inactive",
    notices: [],
    inputMode: { kind: "chat" },
    lastUpdated: "2026-06-24T00:00:00.000Z",
    executionCwd: "/workspace",
    totalsLoading: true,
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** A runtime dispatch that records each session close and answers it through `answer`. */
function recordingDispatch(answer: () => Promise<MutationResult>) {
  const commands = mock((_command: FrontendMutation) => answer())
  return { dispatch: runtimeDispatch({ "session.close": commands }), commands }
}

interface CloserMocks {
  closeTab: (tabId: string) => void
  calls: string[]
  dispatch: ReturnType<typeof mock>
  showToast: ReturnType<typeof mock>
}

function makeCloser(
  tabs: readonly TabInfo[],
  dispatchImpl: () => Promise<MutationResult>,
  overrides: { switchForeground?: (id: string) => Promise<void> } = {},
): CloserMocks {
  const calls: string[] = []
  const { dispatch, commands } = recordingDispatch(async () => {
    calls.push("dispatch")
    return await dispatchImpl()
  })
  const showToast = mock((toast: { message: string }) => { calls.push(`toast:${toast.message}`) })
  const closeTab = createTabCloser({
    tabs: () => tabs,
    appService: { dispatch },
    switchForeground: overrides.switchForeground ?? mock(async (id: string) => { calls.push(`foreground:${id}`) }),
    startChat: mock(async () => { calls.push("startChat"); return { kind: "foregrounded" } }),
    closeSessionTab: mock((sessionId: string) => { calls.push(`close:${sessionId}`) }),
    removePendingTab: mock((key: string) => { calls.push(`remove:${key}`) }),
    draftCache: { clear: (key) => { calls.push(`clear:${key}`) } },
    seedSessionCatalogRow: mock((row: SessionCatalogRow) => { calls.push(`seed:${row.id}:${row.lifecycleState}`) }),
    showToast,
  })
  return { closeTab, calls, dispatch: commands, showToast }
}

describe("createTabCloser", () => {
  it("publishes pending removal and adjacent focus in one local update", () => {
    createRoot((dispose) => {
      const [rows, setRows] = createSignal([tab("pending", { kind: "pending" }), tab("durable")])
      const [foreground, setForeground] = createSignal("pending")
      const tabs = createMemo(() => rows().map((row) => ({ ...row, isForeground: row.id === foreground() })))
      const frames: boolean[] = []
      createComputed(() => { frames.push(tabs().some((row) => row.isForeground)) })
      const { dispatch, commands } = recordingDispatch(async () => ({ ok: true }))
      const close = createTabCloser({
        tabs, appService: { dispatch }, switchForeground: async (key) => { setForeground(key) },
        startChat: async () => ({ kind: "foregrounded" }), closeSessionTab: () => {},
        removePendingTab: (key) => { setRows((list) => list.filter((row) => row.id !== key)) },
        draftCache: { clear: () => {} }, seedSessionCatalogRow: () => {}, showToast: () => {},
      })
      close("pending")
      expect(foreground()).toBe("durable")
      expect(frames).toEqual([true, true])
      expect(commands).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("closes a pending row locally and clears its draft after adjacent mixed-tab focus", async () => {
    const h = makeCloser([
      tab("opening", { kind: "pending", isForeground: true }),
      tab("next", { kind: "pending" }),
    ], async () => ({ ok: true }))
    h.closeTab("opening")
    await settle()
    expect(h.calls).toEqual(["remove:opening", "foreground:next", "clear:opening"])
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it("closes the last pending row without a runtime close", async () => {
    const h = makeCloser([tab("opening", { kind: "pending", title: "Opening", isForeground: true })], async () => ({ ok: true }))
    h.closeTab("opening")
    await settle()
    expect(h.calls).toEqual(["remove:opening", "startChat", "clear:opening"])
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it("removes the tab first, then keeps the closed durable session in the local catalog as inactive", async () => {
    const inactiveRow = catalogRow("chat-1")
    const { closeTab, calls, dispatch } = makeCloser(
      [tab("chat-1"), tab("chat-2", { isForeground: true })],
      async () => ({ ok: true as const, sessionId: "chat-1", sessionCatalogRow: inactiveRow }),
    )

    closeTab("chat-1")
    await settle()

    expect(dispatch).toHaveBeenCalledWith({ type: "session.close", sessionId: "chat-1" })
    expect(calls).toEqual(["close:chat-1", "dispatch", "seed:chat-1:inactive"])
  })

  // The incident case: a poisoned session whose runtime close is refused must
  // still lose its tab. Closing a tab is UI intent and structurally
  // unrefusable; the backend failure surfaces as a toast only.
  it("closes the tab even when the runtime close fails", async () => {
    const { closeTab, calls, showToast } = makeCloser(
      [tab("chat-1"), tab("chat-2", { isForeground: true })],
      async () => ({ ok: false as const, error: "Unable to close chat session chat-1" }),
    )

    closeTab("chat-1")
    await settle()

    expect(calls).toEqual(["close:chat-1", "dispatch", "toast:Unable to close chat session chat-1"])
    expect(showToast).toHaveBeenCalledWith({ message: "Unable to close chat session chat-1", variant: "error" })
  })

  it("switches to the adjacent tab when the foreground closes, even when the runtime close fails", async () => {
    const { closeTab, calls } = makeCloser(
      [tab("chat-1", { isForeground: true }), tab("chat-2")],
      async () => { throw new Error("runtime unreachable") },
    )

    closeTab("chat-1")
    await settle()

    expect(calls).toEqual(["close:chat-1", "foreground:chat-2", "dispatch", "toast:runtime unreachable"])
  })

  it("starts a fresh chat when the last tab's foreground closes", async () => {
    const { closeTab, calls } = makeCloser(
      [tab("chat-1", { isForeground: true })],
      async () => ({ ok: true as const, sessionId: "chat-1" }),
    )

    closeTab("chat-1")
    await settle()

    expect(calls).toEqual(["close:chat-1", "startChat", "dispatch"])
  })

  // The two chains are independent: a broken foreground fallback must not
  // prevent the runtime close (which would leak the session), and vice versa.
  it("still dispatches the runtime close when the foreground fallback fails", async () => {
    const { closeTab, calls } = makeCloser(
      [tab("chat-1", { isForeground: true }), tab("chat-2")],
      async () => ({ ok: true as const, sessionId: "chat-1" }),
      { switchForeground: async () => { throw new Error("switch failed") } },
    )

    closeTab("chat-1")
    await settle()

    expect(calls).toEqual(["close:chat-1", "dispatch", "toast:switch failed"])
  })

  it("keeps a sole idle New Chat tab open (nothing worth closing)", async () => {
    const { closeTab, calls, dispatch } = makeCloser(
      [tab("chat-1", { isForeground: true, title: "New Chat" })],
      async () => ({ ok: true as const, sessionId: "chat-1" }),
    )

    closeTab("chat-1")
    await settle()

    expect(calls).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("closes a sole New Chat tab that is busy", async () => {
    const { closeTab, calls } = makeCloser(
      [tab("chat-1", { isForeground: true, title: "New Chat", isBusy: true })],
      async () => ({ ok: true as const, sessionId: "chat-1" }),
    )

    closeTab("chat-1")
    await settle()

    expect(calls).toEqual(["close:chat-1", "startChat", "dispatch"])
  })
})
