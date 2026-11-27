import { describe, expect, it, mock } from "bun:test"
import { createRenderEffect, createRoot, createSignal } from "solid-js"
import { createModal, pressCtrl, rowLabels, session } from "../../../_session-modal-fixtures.js"
import type { UnreadChatsView } from "../../../../../../../src/protocol/session/unread-protocol-types.js"

describe("useSessionModal catalog lifecycle", () => {
  it("keeps the selected session through prepend, minute regrouping, and the presentation cap", () => {
    createRoot((dispose) => {
      try {
        const [now, setNow] = createSignal(Date.parse("2026-05-22T23:59:00.000Z"))
        const [catalog, setCatalog] = createSignal(Array.from({ length: 200 }, (_, index) => session({
          id: `session-${index}`,
          lastUpdated: new Date(Date.parse("2026-05-22T23:58:00.000Z") - index * 60_000).toISOString(),
        })))
        const { hook, modals, activateSession } = createModal({ get sessions() { return catalog() }, now })
        hook.openSessionsModal()
        hook.selectModalItem(hook.sessionModalResult().rows.findIndex((row) => row.kind === "session" && row.session.id === "session-199"))
        const revision = hook.modalNavigationRevision()
        setCatalog((rows) => [session({ id: "new", lastUpdated: "2026-05-22T23:59:00.000Z" }), ...rows])
        setNow((value) => value + 60_000)
        expect(hook.modalNavigationRevision()).toBe(revision)
        expect(hook.sessionModalResult().rows.filter((row) => row.kind === "session")).toHaveLength(200)
        expect(hook.sessionModalResult().rows[hook.modalCursor()]).toMatchObject({ session: { id: "session-199" } })
        modals.input({ name: "return" })
        expect(activateSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-199" }))
      } finally { dispose() }
    })
  })
  it("keeps every chat that waits on the person reachable past the 200-row cap", () => {
    createRoot((dispose) => {
      try {
        const rows = Array.from({ length: 450 }, (_, index) => session({ id: `session-${index}`, lastUpdated: new Date(Date.parse("2026-05-22T23:58:00.000Z") - index * 60_000).toISOString() }))
        // The 210 oldest chats wait, more than the cap holds on its own, and
        // the 240 others still exceed it.
        const waiting = rows.slice(240).map((row) => row.id)
        const { hook } = createModal({ sessions: rows, waitingSessions: waiting })
        hook.openSessionsModal()
        const result = hook.sessionModalResult()
        const shown = result.rows.flatMap((row) => row.kind === "session" ? [row] : [])
        expect(shown.filter((row) => row.category === "Needs you").map((row) => row.session.id).sort()).toEqual([...waiting].sort())
        expect(shown.filter((row) => row.category !== "Needs you")).toHaveLength(200)
        expect(result.rows[0]).toMatchObject({ kind: "header", label: "Needs you" })
        expect(result.capped).toBe(true)
      } finally { dispose() }
    })
  })
  it("lists a stopped unread chat after the questions, marks it read and unread from the list, and keeps the selection as the set moves", async () => {
    await createRoot(async (dispose) => {
      try {
        const done = { sessionId: "done", ending: { kind: "completed" }, firstLine: "Shipped.", stoppedAt: Date.parse("2026-05-22T00:05:00.000Z"), stopKey: "entry-9" } as const
        const [unread, setUnread] = createSignal<UnreadChatsView>({ stopped: [done], unread: [] })
        const rows = ["asks", "done", "other"].map((id, index) => session({ id, lastUpdated: new Date(Date.parse("2026-05-22T00:04:00.000Z") - index * 60_000).toISOString() }))
        const { hook, modals, appService } = createModal({ sessions: rows, waitingSessions: ["asks"], unreadChats: unread })
        hook.openSessionsModal()
        expect(rowLabels(hook).slice(0, 3)).toEqual(["Needs you", "asks", "done"])
        const select = (id: string) => hook.selectModalItem(hook.sessionModalResult().rows.findIndex((row) => row.kind === "session" && row.session.id === id))

        // A question needs its answer, so it offers no mark.
        select("asks")
        expect(hook.sessionModalActions().map((action) => action.label)).not.toContain("mark read")
        select("done")
        expect(hook.sessionModalActions().map((action) => action.label)).toContain("mark read")
        pressCtrl(modals, "t")
        expect(appService.dispatch).toHaveBeenCalledWith({ type: "chat.mark_read", sessionId: "done" })

        // The row moves only when the set says so, and the selection stays on
        // the chat the person chose.
        select("other")
        const revision = hook.modalNavigationRevision()
        setUnread({ stopped: [], unread: [] })
        expect(rowLabels(hook).slice(0, 2)).toEqual(["Needs you", "asks"])
        expect(hook.sessionModalResult().rows[hook.modalCursor()]).toMatchObject({ session: { id: "other" } })
        expect(hook.modalNavigationRevision()).toBe(revision)

        select("done")
        expect(hook.sessionModalActions().map((action) => action.label)).toContain("mark unread")
        pressCtrl(modals, "t")
        expect(appService.dispatch).toHaveBeenCalledWith({ type: "chat.mark_unread", sessionId: "done" })
        setUnread({ stopped: [done], unread: [] })
        expect(rowLabels(hook).slice(0, 3)).toEqual(["Needs you", "asks", "done"])
        expect(hook.sessionModalResult().rows[hook.modalCursor()]).toMatchObject({ session: { id: "done" } })
        await Promise.resolve()
      } finally { dispose() }
    })
  })
  it("says so in a toast when the runtime refuses to mark unread a chat with nothing to read", async () => {
    await createRoot(async (dispose) => {
      try {
        const showToast = mock((_toast: { message: string; variant: string }) => {})
        const { hook, modals } = createModal({
          sessions: [session({ id: "quiet", title: "Quiet" })],
          dispatch: async (command) => command.type === "chat.mark_unread" ? { ok: false, error: "it has no message to read since it last started" } : { ok: true },
          showToast,
        })
        hook.openSessionsModal()
        hook.selectModalItem(hook.sessionModalResult().rows.findIndex((row) => row.kind === "session"))
        pressCtrl(modals, "t")
        await Promise.resolve()
        await Promise.resolve()
        expect(showToast).toHaveBeenCalledWith({ message: "Mark unread failed for Quiet: it has no message to read since it last started", variant: "error" })
      } finally { dispose() }
    })
  })

  it("does not read the full catalog until its own modal opens", () => {
    createRoot((dispose) => {
      try {
        const [catalog, setCatalog] = createSignal([session({ id: "first" })])
        const readCatalog = mock(catalog)
        const { hook, modals } = createModal({ get sessions() { return readCatalog() } })
        createRenderEffect(() => hook.sessionModalResult())
        expect(readCatalog).not.toHaveBeenCalled()
        modals.replace("another-modal")
        setCatalog([session({ id: "latest" })])
        expect(readCatalog).not.toHaveBeenCalled()
        hook.openSessionsModal()
        expect(rowLabels(hook)).toEqual(["Today", "latest"])
        expect(readCatalog).toHaveBeenCalledTimes(1)
      } finally {
        dispose()
      }
    })
  })

  it("stops catalog work on close and replacement, including minute ticks", () => {
    createRoot((dispose) => {
      try {
        const [now, setNow] = createSignal(Date.parse("2026-05-22T00:10:00.000Z"))
        const [catalog, setCatalog] = createSignal([session({ id: "alpha", title: "Alpha task" })])
        const readCatalog = mock(catalog)
        const { hook, modals } = createModal({ get sessions() { return readCatalog() }, now })
        createRenderEffect(() => hook.sessionModalResult())
        hook.openSessionsModal()
        hook.handleSessionFilter("task")
        const beforeTick = readCatalog.mock.calls.length
        setNow((value) => value + 60_000)
        expect(readCatalog.mock.calls.length).toBe(beforeTick + 1)
        hook.closeSessionsModal()
        readCatalog.mockClear()
        setNow((value) => value + 60_000)
        setCatalog([session({ id: "beta", title: "Beta task" })])
        expect(readCatalog).not.toHaveBeenCalled()
        hook.openSessionsModal()
        expect(rowLabels(hook)).toEqual(["Today", "beta"])
        modals.replace("another-modal")
        readCatalog.mockClear()
        setNow((value) => value + 60_000)
        setCatalog((rows) => rows.map((row) => ({ ...row })))
        expect(readCatalog).not.toHaveBeenCalled()
      } finally {
        dispose()
      }
    })
  })

  it("uses one result for each edit and selects the foreground row on opening", () => {
    createRoot((dispose) => {
      try {
        const readCatalog = mock(() => [session({ id: "recent", title: "Alpha", lastUpdated: "2026-05-22T00:01:00.000Z" }), session({ id: "foreground", title: "Beta" })])
        const { hook, modals } = createModal({ get sessions() { return readCatalog() }, foregroundId: "foreground" })
        createRenderEffect(() => hook.sessionModalResult())
        hook.openSessionsModal()
        expect(hook.modalCursor()).toBe(2)
        readCatalog.mockClear()
        modals.paste("Al")
        expect(readCatalog).toHaveBeenCalledTimes(1)
        expect(rowLabels(hook)).toEqual(["recent"])
        expect(hook.modalCursor()).toBe(0)
        modals.input({ name: "p", raw: "p" })
        expect(readCatalog).toHaveBeenCalledTimes(2)
        expect(hook.filterQuery()).toBe("Alp")
        expect(rowLabels(hook)).toEqual(["recent"])
        hook.openSessionsModal()
        expect(hook.filterQuery()).toBe("")
        expect(hook.modalCursor()).toBe(2)
      } finally {
        dispose()
      }
    })
  })

  it("matches the full catalog before applying the 200-row cap", () => {
    createRoot((dispose) => {
      try {
        const sessions = Array.from({ length: 250 }, (_, index) => session({
          id: `session-${index}`,
          title: index === 249 ? "Needle task" : "Common task",
          lastUpdated: new Date(Date.parse("2026-05-22T00:00:00.000Z") - index * 60_000).toISOString(),
        }))
        const { hook } = createModal({ sessions, foregroundId: "session-249" })
        hook.openSessionsModal()
        expect(hook.sessionModalResult().totalMatches).toBe(250)
        expect(hook.sessionModalResult().capped).toBe(true)
        expect(hook.sessionModalResult().rows.filter((row) => row.kind === "session")).toHaveLength(200)
        expect(hook.modalCursor()).toBe(1)
        hook.handleSessionFilter("Needle")
        expect(rowLabels(hook)).toEqual(["session-249"])
        expect(hook.modalCursor()).toBe(0)
        hook.handleSessionFilter("ta nee")
        expect(rowLabels(hook)).toEqual(["session-249"])
        hook.handleSessionFilter("task")
        expect(hook.sessionModalResult().totalMatches).toBe(250)
        expect(hook.sessionModalResult().rows).toHaveLength(200)
      } finally {
        dispose()
      }
    })
  })

  it("preserves visible chat rows, cursor, and rename draft across equivalent catalogs", () => {
    createRoot((dispose) => {
      try {
        const [catalog, setCatalog] = createSignal([
          session({ id: "parent", title: "Parent", shortTitle: "Parent", childSessionIds: ["child-1", "child-2"], lastUpdated: "2026-05-22T00:06:00.000Z" }),
          session({
            id: "second-chat",
            lastUpdated: "2026-05-22T00:05:00.000Z",
          }),
        ])
        const { hook, modals } = createModal({ get sessions() { return catalog() } })
        createRenderEffect(() => hook.sessionModalResult())
        hook.openSessionsModal()
        hook.selectModalItem(1)
        setCatalog((rows) => rows.map((row) => ({ ...row })))
        pressCtrl(modals, "e")
        modals.input({ name: "left" })
        modals.paste("X")
        const presentation = hook.inputPresentation()
        const labels = rowLabels(hook)
        setCatalog((rows) => rows.map((row) => ({ ...row })))
        expect(hook.modalCursor()).toBe(1)
        expect(hook.renameState()?.shortTitle).toBe("ParenXt")
        expect(hook.inputPresentation()).toEqual(presentation)
        expect(rowLabels(hook)).toEqual(labels)
        expect(labels).toEqual(["Today", "parent", "second-chat"])
        modals.input({ name: "escape" })
        modals.input({ name: "down" })
        expect(hook.modalCursor()).toBe(2)
      } finally {
        dispose()
      }
    })
  })
})
