/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { EMPTY_LEAD_CHATS, EMPTY_LEAD_VIEW, leadReportLink, type LeadView } from "../../../../../src/protocol/modules/lead.js"
import type { MutationResult } from "../../../../../src/protocol/app-service-types.js"
import { createModalStack } from "../../../../../src/tui/components/modal-stack.js"
import { hidesTabControls } from "../../../../../src/tui/context/client-extensions.js"
import { createTabCloser } from "../../../../../src/tui/hooks/create-tab-closer.js"
import type { TabInfo } from "../../../../../src/tui/hooks/create-tabs.js"
import { createLeadClient } from "../../../../../src/tui/modules/lead/client.js"
import { moduleSessionNavigation, moduleTerminalTitle } from "../../../../../src/tui/modules.js"
import { createModal, rowLabels, session } from "../../hooks/_session-modal-fixtures.js"
import { runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import { catalogRow } from "../../../../helpers/session-catalog.js"
import { viewerHost } from "./_lead-fixtures.js"

const LEAD: LeadView = { leadSessionId: "lead-1", dismissed: false }
const LEAD_ROW = catalogRow("lead-1", "Lead")

function tab(id: string, isForeground = false): TabInfo {
  return { kind: "session", id, title: id, isForeground, isBusy: false, isBlocked: false }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The lead client over a scripted lead view, with the shell's own tab closer
 *  asking its close guard and following its first tab. */
function harness(openAnswer: () => Promise<MutationResult<{ readonly type: "lead.open"; readonly reason: "launch" | "command" }>> = async () => ({ ok: true, sessionId: "lead-1", row: LEAD_ROW, created: false })) {
  const [view, setView] = createSignal<LeadView | undefined>(LEAD)
  const [tabs, setTabs] = createSignal<readonly TabInfo[]>([tab("lead-1", true), tab("chat-2")])
  const dialog = createModalStack()
  const sent: string[] = []
  const toasts: string[] = []
  const dispatch = runtimeDispatch({
    "lead.open": async (command) => { sent.push(`lead.open ${command.reason}`); return await openAnswer() },
    "lead.dismiss": async (command) => { sent.push(`lead.dismiss ${command.sessionId}`); return { ok: true, sessionId: command.sessionId } },
    "session.close": async (command) => { sent.push(`session.close ${command.sessionId}${command.atRest ? " at rest" : ""}`); return { ok: true } },
  })
  const { client, closer, dispose } = createRoot((release) => {
    const lead = createLeadClient({ domains: { lead: { scope: "workspace", view }, leadChats: { scope: "workspace", view: () => EMPTY_LEAD_CHATS } }, client: { dispatch, query: runtimeQuery({}) }, dialog, showToast: (toast) => { toasts.push(toast.message) },
      ...viewerHost().host })
    const tabCloser = createTabCloser({
      tabs, appService: { dispatch },
      switchForeground: async (id) => { setTabs((list) => list.map((row) => ({ ...row, isForeground: row.id === id }))) },
      startChat: async () => ({ kind: "foregrounded" }),
      closeSessionTab: (id) => { setTabs((list) => list.filter((row) => row.id !== id)) },
      removePendingTab: () => {}, draftCache: { clear: () => {} }, seedSessionCatalogRow: () => {}, showToast: (toast) => { toasts.push(toast.message) },
      closeGuards: lead.closeGuard ? [lead.closeGuard] : [],
      firstTab: () => lead.firstTab?.current(),
    })
    return { client: lead, closer: tabCloser, dispose: release }
  })
  const key = (name: string): void => { dialog.stack.at(-1)?.onKey?.({ name }) }
  return { client, closer, dispose, dialog, sent, toasts, tabs, setTabs, setView, key }
}

describe("the lead's terminal client", () => {
  it("names the lead as the first tab only while the capability is on and the lead is not dismissed", () => {
    const h = harness()
    try {
      expect(h.client.firstTab?.current()).toBe("lead-1")
      h.setView({ ...LEAD, dismissed: true })
      expect(h.client.firstTab?.current()).toBeUndefined()
      h.setView(EMPTY_LEAD_VIEW)
      expect(h.client.firstTab?.current()).toBeUndefined()
      h.setView(LEAD)
      expect(h.client.firstTab?.current()).toBe("lead-1")
    } finally { h.dispose() }
  })

  it("hides the tab controls for the lead's tab only, and for no tab once the lead is dismissed", () => {
    const h = harness()
    try {
      expect(hidesTabControls([h.client], "lead-1")).toBe(true)
      expect(hidesTabControls([h.client], "chat-2")).toBe(false)
      h.setView({ ...LEAD, dismissed: true })
      expect(hidesTabControls([h.client], "lead-1")).toBe(false)
    } finally { h.dispose() }
  })

  it("titles the terminal 'Flywheel | <Project>' from the project directory's name while the lead's tab is in front, and leaves an ordinary tab's title alone", () => {
    const h = harness()
    try {
      expect(h.client.firstTab?.terminalTitle?.("/Users/someone/Documents/GitHub/data")).toBe("Flywheel | Data")
      expect(moduleTerminalTitle([h.client], "lead-1", "/Users/someone/Documents/GitHub/data")).toBe("Flywheel | Data")
      expect(moduleTerminalTitle([h.client], "chat-2", "/Users/someone/Documents/GitHub/data")).toBeUndefined()
    } finally {
      h.dispose()
    }
  })

  it("opens a report's link as the chat over the lead, and claims no other link", async () => {
    const h = harness()
    try {
      expect(await h.client.openUri("flywheel://session/chat-2")).toBe(false)
      expect(await h.client.openUri(leadReportLink("chat-2", "final-1"))).toBe(true)
    } finally {
      h.dispose()
    }
  })

  it("asks the runtime for the lead at launch and answers the chat it names with its row", async () => {
    let answer: MutationResult<{ readonly type: "lead.open"; readonly reason: "launch" | "command" }> = { ok: true, sessionId: "lead-1", row: LEAD_ROW, created: true }
    const h = harness(async () => answer)
    try {
      expect(await h.client.firstTab?.open()).toEqual({ sessionId: "lead-1", row: LEAD_ROW, created: true })
      answer = { ok: true, sessionId: null }
      expect(await h.client.firstTab?.open()).toBeUndefined()
      answer = { ok: false, error: "runtime stopping" }
      await expect(h.client.firstTab?.open()).rejects.toThrow("runtime stopping")
      expect(h.sent).toEqual(["lead.open launch", "lead.open launch", "lead.open launch"])
    } finally { h.dispose() }
  })

  it("asks before the lead's tab closes: cancel keeps it, confirm dismisses the lead and closes its chat at rest", async () => {
    const h = harness()
    try {
      h.closer.closeTab("lead-1")
      await settle()
      expect(h.dialog.stack).toHaveLength(1)
      h.key("enter")
      await settle()
      expect(h.dialog.stack).toHaveLength(0)
      expect(h.sent).toEqual([])
      expect(h.tabs().map((row) => row.id)).toEqual(["lead-1", "chat-2"])

      h.closer.closeTab("lead-1")
      await settle()
      h.key("tab")
      h.key("enter")
      await settle()
      expect(h.dialog.stack).toHaveLength(0)
      expect(h.sent).toEqual(["lead.dismiss lead-1", "session.close lead-1 at rest"])
      expect(h.tabs().map((row) => [row.id, row.isForeground])).toEqual([["chat-2", true]])
      // The dismissal arrives after the tab went, so it removes nothing more.
      h.setView({ ...LEAD, dismissed: true })
      await settle()
      expect(h.sent).toHaveLength(2)
      expect(h.tabs().map((row) => row.id)).toEqual(["chat-2"])
    } finally { h.dispose() }
  })

  it("asks before Close chat closes the lead: escape closes nothing, confirm dismisses it and closes the chat", async () => {
    const h = harness()
    try {
      const cancelled = h.closer.closeChat("lead-1")
      await settle()
      h.key("escape")
      await cancelled
      expect(h.sent).toEqual([])
      expect(h.tabs().map((row) => row.id)).toEqual(["lead-1", "chat-2"])

      const confirmed = h.closer.closeChat("lead-1")
      await settle()
      h.key("right")
      h.key("return")
      await confirmed
      expect(h.sent).toEqual(["lead.dismiss lead-1", "session.close lead-1"])
      expect(h.tabs().map((row) => row.id)).toEqual(["chat-2"])
    } finally { h.dispose() }
  })

  it("closes an ordinary tab with no dialog", async () => {
    const h = harness()
    try {
      h.closer.closeTab("chat-2")
      await settle()
      expect(h.dialog.stack).toHaveLength(0)
      expect(h.sent).toEqual(["session.close chat-2 at rest"])
    } finally { h.dispose() }
  })

  it("removes the lead's tab with no dialog and closes nothing when the capability turns off", async () => {
    const h = harness()
    try {
      h.setView(EMPTY_LEAD_VIEW)
      await settle()
      expect(h.dialog.stack).toHaveLength(0)
      expect(h.sent).toEqual([])
      expect(h.tabs().map((row) => [row.id, row.isForeground])).toEqual([["chat-2", true]])
    } finally { h.dispose() }
  })
})

/** The Sessions modal over the lead client's session navigation, with the lead's tab or another tab in front. */
function sessionsHarness(foregroundId: string, view: LeadView = LEAD) {
  const viewer = viewerHost()
  return createRoot((dispose) => {
    const lead = createLeadClient({ domains: { lead: { scope: "workspace", view: () => view }, leadChats: { scope: "workspace", view: () => EMPTY_LEAD_CHATS } }, client: { dispatch: runtimeDispatch({}), query: runtimeQuery({}) }, dialog: viewer.overlay.dialog, showToast: () => {},
      ...viewer.host })
    const modal = createModal({ sessions: [session({ id: "lead-1", title: "Lead" }), session({ id: "chat-2", title: "Fix the parser" }), session({ id: "chat-3", title: "Old chat", lastUpdated: "2026-01-01T00:00:00.000Z" })], foregroundId, navigation: moduleSessionNavigation([lead]) })
    return { ...modal, overlay: viewer.overlay, dispose }
  })
}

describe("the Sessions modal with the lead", () => {
  it("lists every chat but the lead on any tab, and a search does not find the lead", () => {
    for (const foreground of ["lead-1", "chat-2"]) {
      const h = sessionsHarness(foreground)
      try {
        h.hook.openSessionsModal()
        expect(rowLabels(h.hook).filter((label) => label.startsWith("chat") || label.startsWith("lead"))).toEqual(["chat-2", "chat-3"])
        h.hook.handleSessionFilter("Lead")
        expect(rowLabels(h.hook)).not.toContain("lead-1")
      } finally { h.dispose() }
    }
  })

  it("lists every chat while the lead module is off", () => {
    const h = sessionsHarness("lead-1", EMPTY_LEAD_VIEW)
    try {
      h.hook.openSessionsModal()
      expect(rowLabels(h.hook).filter((label) => label.startsWith("chat") || label.startsWith("lead"))).toEqual(["lead-1", "chat-2", "chat-3"])
    } finally { h.dispose() }
  })

  it("opens the chosen chat over the lead with Enter or a click, and as a tab with ctrl+t, and names both", async () => {
    const h = sessionsHarness("lead-1")
    try {
      h.hook.openSessionsModal()
      expect(h.hook.sessionModalActions().filter((action) => action.opens).map((action) => `${action.key} ${action.label}`)).toEqual(["enter open", "ctrl+t open as tab"])
      h.modals.input({ name: "Enter" })
      await settle()
      expect(h.overlay.viewer.stack).toHaveLength(1)
      expect(h.modals.stack).toHaveLength(0)
      expect(h.activateSession).not.toHaveBeenCalled()
      h.overlay.viewer.clear()

      h.hook.openSessionsModal()
      const chat3 = h.hook.sessionModalResult().rows.findIndex((row) => row.kind === "session" && row.session.id === "chat-3")
      h.hook.clickRow(chat3)
      await settle()
      expect(h.overlay.viewer.stack).toHaveLength(1)
      expect(h.activateSession).not.toHaveBeenCalled()
      h.overlay.viewer.clear()

      h.hook.openSessionsModal()
      h.modals.input({ name: "t", ctrl: true })
      await settle()
      expect(h.overlay.viewer.stack).toHaveLength(0)
      expect(h.activateSession).toHaveBeenCalledTimes(1)
    } finally { h.dispose() }
  })

  it("opens the chosen chat's tab with Enter on another tab, as without a lead", async () => {
    const h = sessionsHarness("chat-2")
    try {
      h.hook.openSessionsModal()
      expect(h.hook.sessionModalActions().map((action) => action.key)).toEqual(["d", "n", "c"])
      h.modals.input({ name: "Enter" })
      await settle()
      expect(h.activateSession).toHaveBeenCalledTimes(1)
      expect(h.overlay.viewer.stack).toHaveLength(0)
      h.hook.clickRow(h.hook.sessionModalResult().rows.findIndex((row) => row.kind === "session" && row.session.id === "chat-3"))
      await settle()
      expect(h.activateSession).toHaveBeenCalledTimes(1)
    } finally { h.dispose() }
  })
})
