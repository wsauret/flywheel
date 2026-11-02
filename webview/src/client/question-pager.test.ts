import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createRoot, createSignal } from "solid-js"

import type { FrontendEvent, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import type { DesktopNotice } from "../../../src/protocol/client/question-pages.js"
import type { RuntimeSessionDetailView } from "../../../src/protocol/session-detail-protocol-types.js"
import { questionCursor, type PendingQuestionView } from "../../../src/protocol/question-protocol-types.js"
import { browserDesktopNotifier, desktopPermissionRefusal, desktopSwitchOn, type DesktopNotifier, type DesktopPermission } from "./desktop-notifier.js"
import { createQuestionPager } from "./question-pager.js"
import { fakePanelSettings } from "../app/client-context-fixture.js"
import { fakeRuntimeConnection } from "./runtime-connection-fixture.js"
import { createSessionReadings } from "./session-readings.js"
import type { WorkspaceSettings } from "./session-settings.js"

const CHAT = "chat-1"
const AGENT = "workflow-agent-1"
const settle = () => new Promise<void>((resolve) => { setImmediate(resolve) })
const question = (toolUseId: string): PendingQuestionView => ({ kind: "question", toolUseId, questions: [], timestamp: 0 })
const chatRow: SessionCatalogRow = { id: CHAT, kind: "chat", title: "Plan the release", lifecycleState: "active", notices: [], inputMode: { kind: "chat" }, lastUpdated: "2026-09-06T00:00:00.000Z", executionCwd: "/workspace", totalsLoading: true }

function fakeNotifier(initial: DesktopPermission) {
  const shown: DesktopNotice[] = []
  const openers = new Set<(sessionId: string) => void>()
  const notifier: DesktopNotifier = {
    permission: () => initial,
    request: async () => initial,
    show: (notice) => { shown.push(notice) },
    onChange: () => () => {},
    onOpen: (listener) => { openers.add(listener); return () => { openers.delete(listener) } },
  }
  return { notifier, shown, click: (sessionId: string) => { for (const open of openers) open(sessionId) } }
}

const settingsWith = (on: boolean): WorkspaceSettings => fakePanelSettings({
  moduleSettings: [{ control: "config-boolean", setting: "notificationsDesktop", label: "Desktop notifications", description: "", value: on }],
})

/** The detail of a workflow agent titled "Build". */
function agentDetail(sessionId: string): RuntimeSessionDetailView {
  return {
    source: "durable", id: sessionId, kind: "workflow-agent", conversationId: `${sessionId}-conv`, budget: null,
    row: {
      id: sessionId, kind: "workflow-agent", title: "Build", lifecycleState: "active", notices: [], inputMode: { kind: "message" }, admittedActions: [],
      workflowMembership: { kind: "attempt", workflowId: "workflow", attemptId: "attempt" }, lastUpdated: "2026-09-06T00:00:00.000Z", executionCwd: "/workspace", totalsLoading: true,
    },
    status: {
      activity: "idle", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, waitingOnBackgroundWork: false, replyWaits: [],
      activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null,
    },
  }
}

/** A runtime that answers the question presence read from `waiting` and the
 *  session detail read with "Build" once `titles` lets it, and broadcasts
 *  live question patches. */
function fakeRuntime() {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const waiting = new Map<string, PendingQuestionView>()
  const detailReads: string[] = []
  let titles = Promise.withResolvers<void>()
  titles.resolve()
  let position = 0
  const connection = fakeRuntimeConnection({ queries: {
    questionSnapshot: (request) => ({ snapshotPosition: position, views: request.sessionIds.map((sessionId) => ({ sessionId, view: waiting.get(sessionId) ?? null })) }),
    sessionDetail: async (request) => {
      detailReads.push(request.sessionId)
      await titles.promise
      return { view: agentDetail(request.sessionId) }
    },
  } }, {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  const emit = (sessionId: string, payload: { readonly kind: "question.updated"; readonly question: PendingQuestionView } | { readonly kind: "question.removed" }) => {
    position += 1
    for (const listener of listeners) listener({ type: "patch", patch: { cursor: questionCursor(sessionId), position, prevPosition: position - 1, payload } })
  }
  return {
    connection, waiting, detailReads,
    ask: (sessionId: string, toolUseId: string) => { emit(sessionId, { kind: "question.updated", question: question(toolUseId) }) },
    answer: (sessionId: string) => { emit(sessionId, { kind: "question.removed" }) },
    holdTitles() { titles = Promise.withResolvers<void>(); return titles.resolve },
  }
}

function pagerFor(permission: DesktopPermission, on: boolean) {
  const desktop = fakeNotifier(permission)
  const runtime = fakeRuntime()
  const attended: string[] = []
  return createRoot((dispose) => {
    const readings = createSessionReadings({ connection: runtime.connection, changed() {} })
    const [frame, setFrame] = createSignal({ settings: settingsWith(on) })
    createQuestionPager({
      state: frame,
      session: { desktopNotifier: desktop.notifier, row: (sessionId) => (sessionId === CHAT ? chatRow : undefined) },
      connection: runtime.connection,
      attend: (sessionId) => { attended.push(sessionId) },
    })
    return {
      desktop, runtime, readings, attended,
      dispose() { readings.dispose(); dispose() },
      turn: (next: boolean) => setFrame({ settings: settingsWith(next) }),
    }
  })
}

describe("question pager", () => {
  test("a question that waits at attach pages no one, and each live question from a chat or a workflow agent pages once", async () => {
    const page = pagerFor("granted", true)
    page.runtime.waiting.set(CHAT, question("waiting"))
    page.readings.reconcile([chatRow])
    await settle()
    assert.equal(page.readings.pendingQuestions.has(CHAT), true)
    assert.equal(page.desktop.shown.length, 0, "a question waiting at attach is a baseline")
    page.runtime.ask(AGENT, "ask-1")
    page.runtime.ask(AGENT, "ask-1")
    page.runtime.answer(CHAT)
    page.runtime.ask(CHAT, "ask-2")
    await settle()
    assert.deepEqual(page.desktop.shown, [
      { sessionId: CHAT, questionId: "ask-2", title: "Flywheel has a question", body: "Plan the release" },
      { sessionId: AGENT, questionId: "ask-1", title: "Flywheel has a question", body: "Build" },
    ])
    assert.deepEqual(page.runtime.detailReads, [AGENT], "a session the page holds a row for reads nothing")
    page.runtime.answer(AGENT)
    page.runtime.ask(AGENT, "ask-3")
    await settle()
    assert.deepEqual(page.desktop.shown.map((notice) => notice.questionId), ["ask-2", "ask-1", "ask-3"], "a new question of the same session pages again")
    page.dispose()
  })

  test("a catalog read of question presence while a title is read still pages for a workflow agent the catalog does not list", async () => {
    const page = pagerFor("granted", true)
    const release = page.runtime.holdTitles()
    page.runtime.ask(AGENT, "ask-1")
    await settle()
    page.readings.reconcile([chatRow])
    await settle()
    assert.equal(page.readings.pendingQuestions.has(AGENT), false)
    release()
    await settle()
    assert.deepEqual(page.desktop.shown.map((notice) => notice.sessionId), [AGENT])
    page.dispose()
  })

  test("pages no one while the setting is off or the browser does not allow it", async () => {
    for (const [permission, on] of [["granted", false], ["denied", true], ["default", true], ["unsupported", true]] as const) {
      const page = pagerFor(permission, on)
      page.runtime.ask(CHAT, "ask-1")
      await settle()
      assert.deepEqual(page.desktop.shown, [], `${permission}, setting ${on ? "on" : "off"}`)
      page.dispose()
    }
  })

  test("a question asked while paging is off does not page once paging turns on", async () => {
    const page = pagerFor("granted", false)
    page.runtime.ask(CHAT, "ask-1")
    page.turn(true)
    await settle()
    assert.equal(page.desktop.shown.length, 0)
    page.runtime.ask(CHAT, "ask-2")
    await settle()
    assert.deepEqual(page.desktop.shown.map((notice) => notice.questionId), ["ask-2"])
    page.dispose()
  })

  test("a click on a notice attends the session that asks", () => {
    const page = pagerFor("granted", true)
    page.desktop.click(AGENT)
    assert.deepEqual(page.attended, [AGENT])
    page.dispose()
  })
})

describe("desktop notifier", () => {
  function browserApi(permission: NotificationPermission, answer: NotificationPermission) {
    const created: { readonly title: string; readonly options?: NotificationOptions }[] = []
    let asked = 0
    class FakeNotification extends EventTarget implements Notification {
      static permission = permission
      static async requestPermission() {
        asked += 1
        FakeNotification.permission = answer
        return answer
      }
      readonly body: string
      readonly data: unknown = undefined
      readonly dir: NotificationDirection = "auto"
      readonly icon = ""
      readonly lang = ""
      readonly requireInteraction = false
      readonly silent = null
      readonly tag: string
      onclick = null
      onclose = null
      onerror = null
      onshow = null
      constructor(readonly title: string, options?: NotificationOptions) {
        super()
        this.body = options?.body ?? ""
        this.tag = options?.tag ?? ""
        created.push({ title, ...(options === undefined ? {} : { options }) })
        shown.push(this)
      }
      close() {}
    }
    const shown: FakeNotification[] = []
    return { api: FakeNotification, created, shown, get asked() { return asked } }
  }

  test("a click on a notice brings the page to the front and opens the session it names", () => {
    const browser = browserApi("granted", "granted")
    let focused = 0
    const notifier = browserDesktopNotifier({ Notification: browser.api, focus: () => { focused += 1 } })
    const opened: string[] = []
    const stop = notifier.onOpen((sessionId) => { opened.push(sessionId) })
    notifier.show({ sessionId: CHAT, questionId: "ask-1", title: "Flywheel has a question", body: "Chat" })
    browser.shown[0]?.dispatchEvent(new Event("click"))
    assert.equal(focused, 1)
    assert.deepEqual(opened, [CHAT])
    stop()
    browser.shown[0]?.dispatchEvent(new Event("click"))
    assert.deepEqual(opened, [CHAT], "a page that stopped listening opens nothing")
  })

  test("asks the browser once, and shows one notice for each question only while it is allowed", async () => {
    const browser = browserApi("default", "granted")
    const notifier = browserDesktopNotifier({ Notification: browser.api })
    let changes = 0
    notifier.onChange(() => { changes += 1 })
    notifier.show({ sessionId: CHAT, questionId: "ask-1", title: "early", body: "" })
    assert.equal(await notifier.request(), "granted")
    assert.equal(await notifier.request(), "granted")
    assert.equal(browser.asked, 1, "the browser prompt shows only while the answer is default")
    assert.equal(changes, 1)
    notifier.show({ sessionId: CHAT, questionId: "ask-2", title: "Flywheel has a question", body: "Chat" })
    assert.deepEqual(browser.created, [{ title: "Flywheel has a question", options: { body: "Chat", tag: "flywheel-question:ask-2" } }])
  })

  test("the switch shows on only while the setting is on and the page can notify", () => {
    // The setting is on by default, so a page the browser has not answered yet shows the switch off.
    assert.deepEqual((["granted", "unsupported", "default", "denied"] as const).map((permission) => desktopSwitchOn(true, permission)), [true, true, false, false])
    assert.equal(desktopSwitchOn(false, "granted"), false)
  })

  test("a page without the API is unsupported", () => {
    assert.equal(browserDesktopNotifier({}).permission(), "unsupported")
  })

  test("turning the setting on asks the browser, and a block keeps the setting off", async () => {
    const setting = { control: "config-boolean" as const, setting: "notificationsDesktop" as const, label: "Desktop notifications", description: "", value: false }
    const on = { kind: "set-module-setting" as const, setting, on: true }
    const answers = {
      granted: undefined,
      unsupported: undefined,
      denied: "Desktop notifications stay off: this browser blocks them for this page.",
      default: "Desktop notifications stay off: the browser did not allow them. Turn them on again to ask again.",
    } satisfies { readonly [permission in DesktopPermission]: string | undefined }
    for (const permission of ["granted", "unsupported", "denied", "default"] as const) {
      const outcome = await desktopPermissionRefusal(on, fakeNotifier(permission).notifier)
      assert.equal(outcome?.kind === "notice" ? outcome.message : undefined, answers[permission], permission)
    }
    assert.equal(desktopPermissionRefusal({ ...on, on: false }, fakeNotifier("denied").notifier), undefined, "turning it off asks nothing")
  })
})
