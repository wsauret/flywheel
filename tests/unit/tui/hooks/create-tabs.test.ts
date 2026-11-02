/** Tests for tab hooks: tab rows come from this shell's open-session ids,
 * while busy comes from the status cache and blocked comes from the question
 * cache -- the sole isBlocked authority (item 20), never the transcript. */

import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { createTabs, createTabState } from "../../../../src/tui/hooks/create-tabs.js"
import type { OutputView } from "../../../../src/protocol/output-protocol-types.js"
import type { ForegroundTarget } from "../../../../src/tui/hooks/shell-state.js"
import type { StatusView } from "../../../../src/protocol/status-protocol-types.js"

type Status = Pick<StatusView, "activity" | "activeSubagentCount" | "waitingOnBackgroundWork">
type Question = Extract<AnyBlock, { kind: "question" }>
interface QuestionsById { [id: string]: Question }
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
  questionView: (id: string) => Question | undefined = () => undefined,
  statusView: (id: string) => Status | undefined = () => undefined,
  outputView: (id: string) => OutputView | undefined = () => undefined,
) {
  const [foregroundId, setForegroundId] = createSignal<string | undefined>(undefined)
  const [sessionShortTitle, setSessionShortTitle] = createSignal("")
  return { foregroundId, setForegroundId, foregroundTarget: () => { const sessionId = foregroundId(); return sessionId ? { kind: "session" as const, sessionId } : undefined }, sessionShortTitle, setSessionShortTitle, questionView, statusView: (id: string): StatusView | undefined => {
    const status = statusView(id)
    return status ? { activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [], ...status } : undefined
  }, outputView }
}

function question(overrides: Partial<Question> = {}): Question {
  return {
    kind: "question",
    toolUseId: "q1",
    questions: [{ question: "Y/N?", choices: [{ kind: "freeform", label: "Other" }], multiSelect: false }],
    timestamp: 0,
    ...overrides,
  }
}

describe("createTabs", () => {
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
  it("derives isBusy from status cache and isBlocked from question cache per session", () => {
    createRoot((dispose) => {
      const [questions, setQuestions] = createStore<QuestionsById>({})
      const [statuses, setStatuses] = createStore<StatusesById>({})
      setStatuses("a", { activity: "generating", activeSubagentCount: 0, waitingOnBackgroundWork: false })
      setQuestions("b", question())

      const tabs = createTabs({
        sessions: () => [catalogRow({ id: "a" }), catalogRow({ id: "b" }), catalogRow({ id: "c" })],
        openSessionIds: () => ["a", "b", "c"],
        signals: makeSignals((id) => questions[id], (id) => statuses[id]),
      })

      expect(tabs().map((t) => [t.id, t.isBusy, t.isBlocked])).toEqual([
        ["a", true, false],
        ["b", false, true],
        ["c", false, false],
      ])
      dispose()
    })
  })

  it("treats awaiting_user with an open question as blocked but not busy", () => {
    createRoot((dispose) => {
      const tabs = createTabs({
        sessions: () => [catalogRow({ id: "a" })],
        openSessionIds: () => ["a"],
        signals: makeSignals(
          () => question(),
          () => ({ activity: "awaiting_user", activeSubagentCount: 0, waitingOnBackgroundWork: false }),
        ),
      })

      expect(tabs().find((t) => t.id === "a")).toMatchObject({ isBusy: false, isBlocked: true })
      dispose()
    })
  })

  it("marks busy for active subagents or background work and keeps absent questions unblocked", () => {
    createRoot((dispose) => {
      // An answered question is never resident in the cache in the first place
      // (the server publishes `question.removed` the moment it's answered), so
      // the fixture for "b" models that as an absent questionView entry rather
      // than a raw answered block for the client to filter.
      const tabs = createTabs({
        sessions: () => [catalogRow({ id: "a" }), catalogRow({ id: "b" }), catalogRow({ id: "c" })],
        openSessionIds: () => ["a", "b", "c"],
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
      expect(tabs().find((t) => t.id === "b")?.isBlocked).toBe(false)
      dispose()
    })
  })

  it("uses local open-tab order and ignores globally active unopened sessions", () => {
    createRoot((dispose) => {
      const signals = makeSignals()
      signals.setForegroundId("wf")
      signals.setSessionShortTitle("Foreground Flow")
      const [oldTitle, setOldTitle] = createSignal(catalogRow({ id: "old", title: "Original description", lifecycleState: "inactive" }))
      const tabs = createTabs({
        sessions: () => [
          catalogRow({ id: "chat", title: "Chat Title", shortTitle: "Chat" }),
          oldTitle(),
          catalogRow({ id: "global-active", title: "Other Runtime Tab" }),
          catalogRow({ id: "wf", title: "Foreground Chat", shortTitle: "Flow" }),
        ],
        openSessionIds: () => ["old", "chat", "wf"],
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
      const tabs = createTabs({ sessions: () => [], openSessionIds: () => [], signals })

      expect(tabs()).toEqual([{
        kind: "session",
        id: "pending-fg",
        title: "New Chat",
        isForeground: true,
        isBusy: false,
        isBlocked: false,
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
