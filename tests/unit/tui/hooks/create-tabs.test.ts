/** Tests for tab hooks: tab rows come from this shell's open-session ids,
 * while busy comes from the status cache and the mark comes from the
 * project's waiting and unread sets -- the sole mark authority, never the
 * transcript. */

import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionCatalogRow } from "../../../../src/protocol/runtime/app-service-types.js"
import { createTabState } from "../../../../src/tui/hooks/create-tabs.js"
import type { OutputView } from "../../../../src/protocol/transcript/output-protocol-types.js"
import type { ForegroundTarget } from "../../../../src/tui/hooks/state/shell-state.js"
import type { StatusView } from "../../../../src/protocol/session/status-protocol-types.js"
import type { ChatMark } from "../../../../src/tui/components/notices/chat-marks.js"

type Status = Pick<StatusView, "activity" | "activeSubagentCount" | "waitingOnBackgroundWork">
interface StatusesById { [id: string]: Status }

type LoadingCatalogRow = Extract<SessionCatalogRow, { readonly totalsLoading: true }>

function catalogRow(overrides: Partial<Omit<LoadingCatalogRow, "totalsLoading">> & { id: string }): SessionCatalogRow {
  return {
    kind: "chat",
    title: overrides.id,
    lifecycleState: "active",
    notices: [],
    inputMode: { kind: "chat" },
    executionCwd: "/workspace",
    lastUpdated: "2026-01-01T00:00:00.000Z",
    totalsLoading: true,
    ...overrides,
  }
}

function makeSignals(
  chatMark: (id: string) => ChatMark | undefined = () => undefined,
  statusView: (id: string) => Status | undefined = () => undefined,
  outputView: (id: string) => OutputView | undefined = () => undefined,
) {
  const [foregroundId, setForegroundId] = createSignal<string | undefined>(undefined)
  const [sessionShortTitle, setSessionShortTitle] = createSignal("")
  return { foregroundId, setForegroundId, foregroundTarget: () => { const sessionId = foregroundId(); return sessionId ? { kind: "session" as const, sessionId } : undefined }, sessionShortTitle, setSessionShortTitle, chatMark, statusView: (id: string): StatusView | undefined => {
    const status = statusView(id)
    return status ? { activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [], ...status } : undefined
  }, outputView }
}

/** Opens each id as a session tab, in order, the way the shell opens them. */
function openTabs(deps: { sessions: () => readonly SessionCatalogRow[]; openSessionIds: readonly string[]; signals: ReturnType<typeof makeSignals> }) {
  const state = createTabState({ sessions: deps.sessions, signals: deps.signals })
  for (const id of deps.openSessionIds) state.openSessionTab(id)
  return state.tabs
}

describe("createTabState", () => {
  it("phase15a pending tabs share tab order but never read runtime session state", () => {
    createRoot((dispose) => {
      const [foregroundTarget, setForegroundTarget] = createSignal<ForegroundTarget>()
      const reads: string[] = []
      const signals = { ...makeSignals(undefined, (id) => { reads.push(id); return undefined }), foregroundTarget }
      const state = createTabState({ sessions: () => [catalogRow({ id: "durable" })], signals })
      state.openSessionTab("durable")
      state.openPendingTab("private")
      setForegroundTarget({ kind: "pending", key: "private" })
      expect(state.tabs().map((tab) => [tab.kind, tab.id, tab.isForeground])).toEqual([
        ["session", "durable", false], ["pending", "private", true],
      ])
      expect(reads).not.toContain("private")
      state.reorderTab("private", "durable")
      expect(state.tabs().map((tab) => tab.id)).toEqual(["private", "durable"])
      state.reorderTab("private", null)
      expect(state.tabs().map((tab) => tab.id)).toEqual(["durable", "private"])
      state.removePendingTab("private")
      expect(state.hasPendingTab("private")).toBe(false)
      expect(state.tabs().map((tab) => tab.id)).toEqual(["durable"])
      dispose()
    })
  })
  it("derives isBusy from status cache and the mark from the project's sets per session, in tab order", () => {
    createRoot((dispose) => {
      const [marks, setMarks] = createSignal<ReadonlyMap<string, ChatMark>>(new Map([["a", "unread"], ["b", "question"], ["c", "stopped"]]))
      const [statuses, setStatuses] = createStore<StatusesById>({})
      setStatuses("a", { activity: "generating", activeSubagentCount: 0, waitingOnBackgroundWork: false })

      const tabs = openTabs({
        sessions: () => [catalogRow({ id: "a" }), catalogRow({ id: "b" }), catalogRow({ id: "c" })],
        openSessionIds: ["a", "b", "c"],
        signals: makeSignals((id) => marks().get(id), (id) => statuses[id]),
      })

      // A working chat with unread messages keeps its place and its busy state.
      expect(tabs().map((t) => [t.id, t.isBusy, t.mark])).toEqual([
        ["a", true, "unread"],
        ["b", false, "question"],
        ["c", false, "stopped"],
      ])
      setMarks(new Map())
      expect(tabs().map((t) => [t.id, t.mark])).toEqual([["a", undefined], ["b", undefined], ["c", undefined]])
      dispose()
    })
  })

  it("treats awaiting_user with an open question as blocked but not busy", () => {
    createRoot((dispose) => {
      const tabs = openTabs({
        sessions: () => [catalogRow({ id: "a" })],
        openSessionIds: ["a"],
        signals: makeSignals(
          () => "question",
          () => ({ activity: "awaiting_user", activeSubagentCount: 0, waitingOnBackgroundWork: false }),
        ),
      })

      expect(tabs().find((t) => t.id === "a")).toMatchObject({ isBusy: false, mark: "question" })
      dispose()
    })
  })

  it("marks busy for active subagents or background work and keeps absent questions unblocked", () => {
    createRoot((dispose) => {
      // An answered question leaves the waiting set at once, so "b" is absent
      // from it rather than an answered block for the client to filter.
      const tabs = openTabs({
        sessions: () => [catalogRow({ id: "a" }), catalogRow({ id: "b" }), catalogRow({ id: "c" })],
        openSessionIds: ["a", "b", "c"],
        signals: makeSignals(
          () => undefined,
          (id) => {
            if (id === "a") return { activity: "idle", activeSubagentCount: 1, waitingOnBackgroundWork: false }
            if (id === "c") return { activity: "idle", activeSubagentCount: 0, waitingOnBackgroundWork: true }
            return undefined
          },
        ),
      })

      expect(tabs().find((t) => t.id === "a")?.isBusy).toBe(true)
      expect(tabs().find((t) => t.id === "c")?.isBusy).toBe(true)
      expect(tabs().find((t) => t.id === "b")?.mark).toBeUndefined()
      dispose()
    })
  })

  it("uses local open-tab order and ignores globally active unopened sessions", () => {
    createRoot((dispose) => {
      const signals = makeSignals()
      signals.setForegroundId("wf")
      signals.setSessionShortTitle("Foreground Flow")
      const [oldTitle, setOldTitle] = createSignal(catalogRow({ id: "old", title: "Original description", lifecycleState: "inactive" }))
      const tabs = openTabs({
        sessions: () => [
          catalogRow({ id: "chat", title: "Chat Title", shortTitle: "Chat" }),
          oldTitle(),
          catalogRow({ id: "global-active", title: "Other Runtime Tab" }),
          catalogRow({ id: "wf", title: "Foreground Chat", shortTitle: "Flow" }),
        ],
        openSessionIds: ["old", "chat", "wf"],
        signals,
      })

      expect(tabs().map((t) => [t.id, t.title, t.isForeground])).toEqual([
        ["old", "Original descr", false],
        ["chat", "Chat", false],
        ["wf", "Foreground Flow", true],
      ])
      setOldTitle(catalogRow({ id: "old", title: "Edited description", shortTitle: "Original descr", lifecycleState: "inactive" }))
      expect(tabs().find((tab) => tab.id === "old")?.title).toBe("Original descr")
      dispose()
    })
  })

  it("synthesizes a foreground tab while a newly dispatched session awaits its added patch", () => {
    createRoot((dispose) => {
      const signals = makeSignals()
      signals.setForegroundId("pending-fg")
      const tabs = openTabs({ sessions: () => [], openSessionIds: [], signals })

      expect(tabs()).toEqual([{
        kind: "session",
        id: "pending-fg",
        title: "New Chat",
        isForeground: true,
        isBusy: false,
      }])
      dispose()
    })
  })

  it("detects transient empty chat tabs from the live catalog and output cache", () => {
    createRoot((dispose) => {
      const outputView = (id: string): OutputView | undefined => ({
        blocks: id === "chat-with-output" ? [{ kind: "system", id: "block-1", message: "hello", level: "info", timestamp: 0 }] : [],
        streamingToolText: {},
      })
      const tabState = createTabState({
        sessions: () => [
          catalogRow({ id: "empty-chat", title: "New Chat" }),
          catalogRow({ id: "chat-with-output", title: "New Chat" }),
          catalogRow({ id: "renamed-chat", title: "Renamed" }),
        ],
        signals: makeSignals(undefined, undefined, outputView),
      })

      expect(tabState.isTransientSessionTab("empty-chat")).toBe(true)
      expect(tabState.isTransientSessionTab("chat-with-output")).toBe(false)
      expect(tabState.isTransientSessionTab("renamed-chat")).toBe(false)
      expect(tabState.isTransientSessionTab("workflow")).toBe(false)
      dispose()
    })
  })
})
