/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { EMPTY_LEAD_CHATS, EMPTY_LEAD_VIEW, type LeadView } from "../../../../../src/protocol/modules/lead.js"
import type { MutationResult } from "../../../../../src/protocol/app-service-types.js"
import { createModalStack } from "../../../../../src/tui/components/modal-stack.js"
import { createTabCloser } from "../../../../../src/tui/hooks/create-tab-closer.js"
import type { TabInfo } from "../../../../../src/tui/hooks/create-tabs.js"
import { createLeadClient } from "../../../../../src/tui/modules/lead/client.js"
import { runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import { catalogRow } from "../../../../helpers/session-catalog.js"
import { readerHost } from "./_lead-fixtures.js"

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
      ...readerHost().host })
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
