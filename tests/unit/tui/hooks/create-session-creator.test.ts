import { afterEach, describe, expect, it } from "bun:test"
import { batch, createComputed, createMemo, createRoot, createSignal } from "solid-js"
import type { FrontendMutation, MutationResult, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { createSessionCreator } from "../../../../src/tui/hooks/create-session-creator.js"
import { createDraftCache, UNBOUND_COMPOSER_DRAFT } from "../../../../src/tui/hooks/create-draft-cache.js"
import { createTabState } from "../../../../src/tui/hooks/create-tabs.js"
import { createTabCloser } from "../../../../src/tui/hooks/create-tab-closer.js"
import type { ForegroundTarget } from "../../../../src/tui/hooks/shell-state.js"
import { catalogRow } from "../../../helpers/session-catalog.js"

type ChatOpen = Extract<FrontendMutation, { readonly type: "chat.open" }>
type CreationResult = MutationResult<ChatOpen>

const disposers: Array<() => void> = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose() })

function harness(dispatch: (command: ChatOpen) => Promise<CreationResult>) {
  return createRoot((dispose) => {
  disposers.push(dispose)
  const [foregroundTarget, writeTarget] = createSignal<ForegroundTarget>()
  const [foregroundRevision, writeRevision] = createSignal(0)
  const foregroundId = createMemo(() => { const target = foregroundTarget(); return target?.kind === "session" ? target.sessionId : undefined })
  const foreground = { get current() { return foregroundId() } }
  const draftCache = createDraftCache()
  const opened: string[] = []
  const seeded: string[] = []
  const settlementEvents: string[] = []
  const retired: string[] = []
  const toasts: Array<{ message: string; variant: string }> = []
  const signals = {
    foregroundId, foregroundRevision, foregroundTarget,
    setForegroundTarget: (target: ForegroundTarget | undefined) => batch(() => {
      writeTarget(target)
      writeRevision((value) => value + 1)
    }),
    setForegroundId: (id: string | undefined) => {
      settlementEvents.push(`foreground:${id ?? "none"}`)
      signals.setForegroundTarget(id === undefined ? undefined : { kind: "session", sessionId: id })
    },
    sessionShortTitle: () => "",
    statusView: () => undefined,
    questionView: () => undefined,
    outputView: () => undefined,
  }
  const [rows, setRows] = createSignal<readonly SessionCatalogRow[]>([])
  const tabState = createTabState({ signals, sessions: rows })
  const deps: Parameters<typeof createSessionCreator>[0] = {
    signals,
    appService: { dispatch },
    openSessionTab: (id) => { opened.push(id); tabState.openSessionTab(id) },
    openPendingTab: tabState.openPendingTab,
    removePendingTab: tabState.removePendingTab,
    hasPendingTab: tabState.hasPendingTab,
    tabs: tabState.tabs,
    draftCache,
    adoptDraft: draftCache.adopt,
    seedSessionCatalogRow: (row) => { seeded.push(row.id); setRows((currentRows) => [...currentRows.filter((value) => value.id !== row.id), row]) },
    startKnownEmptyTranscript: (id) => { settlementEvents.push(`empty:${id}`) },
    retireTransientSession: (id: string) => { retired.push(id) },
    showToast: (toast) => { toasts.push(toast) },
  }
  const creator = createSessionCreator(deps)
  const frames: Array<{ id: string | undefined; pending: number; key: string | undefined }> = []
  createComputed(() => {
    const target = signals.foregroundTarget()
    frames.push({ id: foregroundId(), pending: tabState.tabs().filter((tab) => tab.kind === "pending" && tab.isForeground).length, key: target?.kind === "pending" ? target.key : undefined })
  })
  return { ...creator, signals, foreground, opened, seeded, settlementEvents, retired, toasts, tabState, draftCache, frames, dispose, setRows }
  })
}

describe("createSessionCreator", () => {
  it("preserves chat-open payload and foreground settlement", async () => {
    const commands: Array<{ type: string; sessionId?: string }> = []
    const h = harness(async (command) => {
      commands.push(command)
      return { ok: true, sessionId: "chat-1" }
    })

    expect(await h.startChat()).toEqual({ kind: "foregrounded", sessionId: "chat-1" })
    expect(commands).toEqual([{ type: "chat.open" }])
    expect(h.foreground.current).toBe("chat-1")
    expect(h.opened).toEqual(["chat-1"])
    expect(h.settlementEvents).toEqual(["empty:chat-1", "foreground:chat-1"])
  })

  it("phase15a removes the prior durable foreground before dispatch settles", async () => {
    const pending = Promise.withResolvers<CreationResult>()
    const h = harness(() => {
      expect(h.frames.at(-1)).toMatchObject({ id: undefined, pending: 1 })
      return pending.promise
    })
    h.signals.setForegroundId("current")

    const creation = h.startChat()

    expect(h.foreground.current).toBeUndefined()
    expect(h.frames.at(-1)).toMatchObject({ id: undefined, pending: 1 })
    const key = h.frames.at(-1)!.key!
    expect(h.tabState.tabs().find((tab) => tab.id === key)?.title).toBe("Opening")
    h.draftCache.set("current", { text: "old", attachments: [], pastes: [] })
    h.draftCache.set(key, { text: "new", attachments: [], pastes: [] })
    expect(h.retired).toEqual([])
    pending.resolve({ ok: true, sessionId: "next" })
    expect(await creation).toEqual({ kind: "foregrounded", sessionId: "next" })
    expect(h.foreground.current).toBe("next")
    expect(h.retired).toEqual(["current"])
    expect(h.draftCache.get("current").text).toBe("old")
    expect(h.draftCache.get("next").text).toBe("new")
    expect(h.draftCache.hasDraft(key)).toBe(false)
  })

  it("foregrounds a session the runtime created for a command and retires the transient it replaces", async () => {
    const commands: Array<{ type: string; sessionId?: string }> = []
    const h = harness(async (command) => {
      commands.push(command)
      return { ok: true, sessionId: "unused" }
    })
    h.signals.setForegroundId("source")
    h.opened.push("source")

    h.focusSession("copy")

    expect(commands).toEqual([])
    expect(h.opened).toEqual(["source", "copy"])
    expect(h.foreground.current).toBe("copy")
    expect(h.retired).toEqual(["source"])
  })

  it("phase15a settles a background pending tab without stealing newer navigation", async () => {
    const pending = Promise.withResolvers<CreationResult>()
    const h = harness(() => pending.promise)
    h.signals.setForegroundId("source")

    const creation = h.startChat()
    h.signals.setForegroundId("user-picked")
    pending.resolve({ ok: true, sessionId: "next", sessionCatalogRow: {
      id: "next", kind: "chat", title: "New Chat", lifecycleState: "active",
      notices: [], inputMode: { kind: "chat" }, executionCwd: "/workspace",
      lastUpdated: "2026-01-01T00:00:00.000Z", totalsLoading: true,
    } })

    expect(await creation).toEqual({ kind: "stale", sessionId: "next" })
    expect(h.foreground.current).toBe("user-picked")
    expect(h.opened).toEqual(["next"])
    expect(h.seeded).toEqual(["next"])
  })

  it("settles only the newest of two concurrent chat opens", async () => {
    const deferred: Array<ReturnType<typeof Promise.withResolvers<CreationResult>>> = []
    const h = harness(() => {
      const next = Promise.withResolvers<CreationResult>()
      deferred.push(next)
      return next.promise
    })

    const first = h.startChat()
    const second = h.startChat()
    deferred[1]!.resolve({ ok: true, sessionId: "second" })
    expect(await second).toEqual({ kind: "foregrounded", sessionId: "second" })
    deferred[0]!.resolve({ ok: true, sessionId: "first" })
    expect(await first).toEqual({ kind: "stale", sessionId: "first" })
    expect(h.opened).toEqual(["second", "first"])
  })

  it("shows a creation failure once and leaves tabs unchanged", async () => {
    const h = harness(async () => ({ ok: false, error: "cannot open" }))
    h.opened.push("source")

    expect(await h.startChat()).toEqual({ kind: "failed" })
    expect(h.toasts).toEqual([{ message: "cannot open", variant: "error" }])
    expect(h.opened).toEqual(["source"])
    expect(h.seeded).toEqual([])
  })

  it("preserves missing-session chat failure feedback", async () => {
    const h = harness(async () => ({ ok: true }))

    expect(await h.startChat()).toEqual({ kind: "failed" })
    expect(h.toasts).toEqual([{ message: "Chat failed to start", variant: "error" }])
  })

  it("phase15a adopts a reused tab once and merges both drafts", async () => {
    const pending = Promise.withResolvers<CreationResult>()
    const h = harness(() => pending.promise)
    h.focusSession("reuse")
    h.draftCache.set("reuse", { text: "existing", pastes: [], attachments: [] })
    const creation = h.startChat()
    const key = h.frames.at(-1)!.key!
    h.draftCache.set(key, { text: "typed", pastes: [], attachments: [] })
    pending.resolve({ ok: true, sessionId: "reuse" })
    expect(await creation).toEqual({ kind: "foregrounded", sessionId: "reuse" })
    expect(h.tabState.tabs().map((tab) => tab.id)).toEqual(["reuse"])
    expect(h.draftCache.get("reuse").text).toBe("existing\n\ntyped")
    expect(h.draftCache.hasDraft(key)).toBe(false)
  })

  it("phase15a removes only a failed pending draft and restores its prior focus", async () => {
    const pending = Promise.withResolvers<CreationResult>()
    const h = harness(() => pending.promise)
    h.setRows([catalogRow("source", "Source")])
    h.tabState.openSessionTab("source")
    h.signals.setForegroundId("source")
    const creation = h.startChat()
    const key = h.frames.at(-1)!.key!
    h.draftCache.set(key, { text: "typed", pastes: [], attachments: [] })
    pending.reject(new Error("transport failed"))
    expect(await creation).toEqual({ kind: "failed" })
    expect(h.foreground.current).toBe("source")
    expect(h.tabState.hasPendingTab(key)).toBe(false)
    expect(h.draftCache.hasDraft(key)).toBe(false)
    expect(h.toasts).toEqual([{ message: "transport failed", variant: "error" }])
  })

  it("phase15a leaves a newer pending target intact when an older request fails", async () => {
    const first = Promise.withResolvers<CreationResult>()
    const second = Promise.withResolvers<CreationResult>()
    let count = 0
    const h = harness(() => ++count === 1 ? first.promise : second.promise)
    const older = h.startChat()
    const newer = h.startChat()
    const target = h.signals.foregroundTarget()
    first.resolve({ ok: false, error: "older failed" })
    await older
    expect(h.signals.foregroundTarget()).toEqual(target)
    expect(h.tabState.tabs().filter((tab) => tab.kind === "pending")).toHaveLength(1)
    second.resolve({ ok: true, sessionId: "newer" })
    expect(await newer).toEqual({ kind: "foregrounded", sessionId: "newer" })
  })

  it("recalls only submitted messages and keeps the later pending draft separate", async () => {
    const request = Promise.withResolvers<CreationResult>()
    const h = harness(() => request.promise)
    const creation = h.startChat({ text: "first [Image #1]", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "Zmlyc3Q=" }] })
    const key = h.frames.at(-1)!.key!
    h.draftCache.set(key, { text: "[Pasted ~5 lines]", pastes: [{ start: 0, end: 17, text: "pending paste" }], attachments: [] })
    request.reject(new Error("creation failed"))
    expect(await creation).toEqual({ kind: "failed" })
    expect(h.tabState.hasPendingTab(key)).toBe(false)
    expect(h.draftCache.get(UNBOUND_COMPOSER_DRAFT)).toEqual({
      text: "[Pasted ~5 lines]", pastes: [{ start: 0, end: 17, text: "pending paste" }], attachments: [],
    })

    expect(await h.startChat({ text: "second [Image #1]", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "c2Vjb25k" }] })).toEqual({ kind: "failed" })
    expect(h.recallFailedChat()).toEqual({
      text: "first [Image #1]\n\nsecond [Image #2]",
      attachments: [
        { marker: "[Image #1]", mediaType: "image/png", data: "Zmlyc3Q=" },
        { marker: "[Image #2]", mediaType: "image/png", data: "c2Vjb25k" },
      ],
    })
    expect(h.recallFailedChat()).toBeNull()
  })

  it("phase15a a removed pending tab seeds history without reopening", async () => {
    const pending = Promise.withResolvers<CreationResult>()
    const h = harness(() => pending.promise)
    const creation = h.startChat()
    const key = h.frames.at(-1)!.key!
    h.signals.setForegroundId("chosen")
    h.draftCache.set(key, { text: "discard me", pastes: [], attachments: [] })
    const { closeTab } = createTabCloser({
      tabs: h.tabState.tabs,
      appService: { dispatch: async () => { throw new Error("pending close must not dispatch") } },
      switchForeground: async () => {}, startChat: h.startChat,
      closeSessionTab: h.tabState.closeSessionTab, removePendingTab: h.tabState.removePendingTab,
      draftCache: h.draftCache, seedSessionCatalogRow: () => {}, showToast: () => { throw new Error("unexpected close toast") },
    })
    closeTab(key)
    expect(h.draftCache.hasDraft(key)).toBe(false)
    pending.resolve({ ok: true, sessionId: "closed", sessionCatalogRow: catalogRow("closed", "Closed") })
    expect(await creation).toEqual({ kind: "stale", sessionId: "closed" })
    expect(h.seeded).toEqual(["closed"])
    expect(h.opened).toEqual([])
    expect(h.foreground.current).toBe("chosen")
  })

  it("phase15a does not settle into a disposed shell", async () => {
    const pending = Promise.withResolvers<CreationResult>()
    const h = harness(() => pending.promise)
    const creation = h.startChat()
    h.dispose()
    pending.resolve({ ok: true, sessionId: "late" })
    expect(await creation).toEqual({ kind: "stale", sessionId: "late" })
    expect(h.opened).toEqual([])
  })

  it("adopts when the user reselects the same pending target", async () => {
    const pending = Promise.withResolvers<CreationResult>()
    const h = harness(() => pending.promise)
    const creation = h.startChat()
    const target = h.signals.foregroundTarget()
    h.signals.setForegroundTarget(target)
    pending.resolve({ ok: true, sessionId: "settled" })
    expect(await creation).toEqual({ kind: "foregrounded", sessionId: "settled" })
    expect(h.signals.foregroundTarget()).toEqual({ kind: "session", sessionId: "settled" })
    expect(h.tabState.tabs().some((tab) => tab.isForeground)).toBe(true)
  })

  it("restores a visible adjacent tab when an overlapping request's prior pending target settled", async () => {
    const first = Promise.withResolvers<CreationResult>()
    const second = Promise.withResolvers<CreationResult>()
    let count = 0
    const h = harness(() => ++count === 1 ? first.promise : second.promise)
    const older = h.startChat()
    const newer = h.startChat()
    first.resolve({ ok: true, sessionId: "settled", sessionCatalogRow: catalogRow("settled", "Settled") })
    await older
    second.resolve({ ok: false, error: "failed" })
    await newer
    expect(h.signals.foregroundTarget()).toEqual({ kind: "session", sessionId: "settled" })
    expect(h.tabState.tabs().some((tab) => tab.isForeground)).toBe(true)
  })

  it("adopts after the user navigates away and deliberately returns to the pending target", async () => {
    const request = Promise.withResolvers<CreationResult>()
    const h = harness(() => request.promise)
    const creation = h.startChat()
    const pending = h.signals.foregroundTarget()
    h.signals.setForegroundId("other")
    h.signals.setForegroundTarget(pending)
    request.resolve({ ok: true, sessionId: "returned" })
    expect(await creation).toEqual({ kind: "foregrounded", sessionId: "returned" })
    expect(h.foreground.current).toBe("returned")
  })
})
