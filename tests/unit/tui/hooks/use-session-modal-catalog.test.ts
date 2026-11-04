import { describe, expect, it, mock, spyOn } from "bun:test"
import { createRenderEffect, createRoot, createSignal } from "solid-js"
import fuzzysort from "fuzzysort"
import { createModal, rowLabels, session } from "./_session-modal-fixtures.js"

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
    const search = spyOn(fuzzysort, "go")
    try {
      createRoot((dispose) => {
        try {
          const { hook, modals } = createModal({
            sessions: [session({ id: "recent", title: "Alpha", lastUpdated: "2026-05-22T00:01:00.000Z" }), session({ id: "foreground", title: "Beta" })],
            foregroundId: "foreground",
          })
          createRenderEffect(() => hook.sessionModalResult())
          hook.openSessionsModal()
          expect(hook.modalCursor()).toBe(2)
          modals.paste("Al")
          expect(search).toHaveBeenCalledTimes(1)
          expect(rowLabels(hook)).toEqual(["recent"])
          expect(hook.modalCursor()).toBe(0)
          modals.input({ name: "p", raw: "p" })
          expect(search).toHaveBeenCalledTimes(2)
          expect(hook.filterQuery()).toBe("Alp")
          expect(rowLabels(hook)).toEqual(["recent"])
          hook.openSessionsModal()
          expect(hook.filterQuery()).toBe("")
          expect(hook.modalCursor()).toBe(2)
        } finally {
          dispose()
        }
      })
    } finally {
      search.mockRestore()
    }
  })

  it("matches the full catalog, weak matches included, before applying the 200-row cap", () => {
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
        hook.handleSessionFilter("ndt")
        expect(rowLabels(hook)).toEqual(["session-249"])
        hook.handleSessionFilter("task")
        expect(hook.sessionModalResult().totalMatches).toBe(250)
        expect(hook.sessionModalResult().rows).toHaveLength(200)
      } finally {
        dispose()
      }
    })
  })

  it("preserves visible chat rows, cursor, rename draft, and pending shortcuts across equivalent catalogs", () => {
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
        modals.input({ name: "n", raw: "n" })
        setCatalog((rows) => rows.map((row) => ({ ...row })))
        modals.input({ name: "n", raw: "n" })
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
