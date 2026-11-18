import { describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"
import { parseKeypress } from "@opentui/core"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import type { LoadedWorkflowView } from "../../../../src/protocol/workflow-view-protocol-types.js"
import type { SessionActivationResult } from "../../../../src/tui/hooks/session-activation.js"
import type { useSessionModal } from "../../../../src/tui/hooks/use-session-modal.js"
import { createModal, mockClipboardCopy, pressCtrl, rowLabels, session } from "./_session-modal-fixtures.js"

type LoadingCatalogRow = Extract<SessionCatalogRow, { readonly totalsLoading: true }>

function chatSummary(id: string, overrides: Partial<Omit<LoadingCatalogRow, "totalsLoading">> = {}): SessionCatalogRow {
  return session({
    id,
    title: "Paused chat",
    ...overrides,
  })
}

function queue(state: LoadedWorkflowView["state"]): LoadedWorkflowView {
  return { attempts: [], tree: { nodes: [] }, attemptsStatus: "loaded", state }
}

function firstSessionRow(hook: ReturnType<typeof useSessionModal>) {
  const row = hook.sessionModalResult().rows.find((resultRow) => resultRow.kind === "session")
  if (row?.kind !== "session") throw new Error("session row not rendered")
  return row
}

describe("useSessionModal", () => {
  it("jumps to list boundaries with Command arrows and wraps with plain arrows", () => {
    createRoot((dispose) => {
      const { hook, modals } = createModal({
        sessions: [session({ id: "first" }), session({ id: "middle" }), session({ id: "last", lastUpdated: "2026-05-21T00:00:00.000Z" })],
      })
      hook.openSessionsModal()
      const rows = hook.sessionModalResult().rows
      const first = rows.findIndex((row) => row.kind === "session")
      const last = rows.findLastIndex((row) => row.kind === "session")
      const key = (sequence: string) => {
        const event = parseKeypress(sequence)
        if (!event) throw new Error("key sequence was not parsed")
        modals.input(event)
      }
      key("\u001b[1;9B")
      expect(hook.modalCursor()).toBe(last)
      key("\u001b[1;9B")
      expect(hook.modalCursor()).toBe(last)
      key("\u001b[B")
      expect(hook.modalCursor()).toBe(first)
      key("\u001b[A")
      expect(hook.modalCursor()).toBe(last)
      key("\u001b[1;9A")
      expect(hook.modalCursor()).toBe(first)
      key("\u001b[1;9A")
      expect(hook.modalCursor()).toBe(first)
      dispose()
    })
  })

  it("opens the selected session for enter key events", async () => {
    await createRoot(async (dispose) => {
      const selected = session({ id: "chat-1" })
      const { hook, modals, activateSession } = createModal({ sessions: [selected] })

      hook.openSessionsModal()
      modals.input({ name: "Enter" })
      await Promise.resolve()

      expect(activateSession).toHaveBeenCalledWith(selected)
      dispose()
    })
  })

  it("opens a submitted picker session row from the filter input", async () => {
    await createRoot(async (dispose) => {
      const selected = session({ id: "chat-1" })
      const { hook, activateSession } = createModal({ sessions: [selected] })

      hook.openSessionsModal()
      hook.openSessionRow(firstSessionRow(hook))
      await Promise.resolve()

      expect(activateSession).toHaveBeenCalledWith(selected)
      dispose()
    })
  })

  it("preserves copy and open actions", async () => {
    await createRoot(async (dispose) => {
      mockClipboardCopy.mockClear()
      const showToast = mock(() => {})
      const selected = session({ id: "wf-1" })
      const { hook, modals, activateSession } = createModal({
        sessions: [selected],
        queueViews: { "wf-1": queue("paused") },
        showToast,
      })

      hook.openSessionsModal()
      expect(hook.sessionModalActions().some((action) => action.label === "resume")).toBe(false)

      pressCtrl(modals, "y")
      await Promise.resolve()
      expect(mockClipboardCopy).toHaveBeenCalledWith("wf-1")

      modals.input({ name: "return" })
      await Promise.resolve()
      expect(activateSession).toHaveBeenCalledWith(selected)
      expect(showToast).toHaveBeenCalledWith({ message: "Copied: wf-1", variant: "info" })
      dispose()
    })
  })

  it("does not expose resume when no queue status is cached", () => {
    createRoot((dispose) => {
      const { hook } = createModal({ sessions: [chatSummary("chat-1")] })

      hook.openSessionsModal()

      expect(hook.sessionModalActions().some((action) => action.label === "resume")).toBe(false)
      dispose()
    })
  })


  it("opens an exact unlisted child id through detail activation without a catalog row or control dispatch", async () => {
    await createRoot(async (dispose) => {
      const showToast = mock(() => {})
      const { hook, modals, appService, activateSessionById } = createModal({
        sessions: [session({ id: "parent", childSessionIds: ["0a1b2c3d4e5f"] })],
        queueViews: { "0a1b2c3d4e5f": queue("running") },
        showToast,
      })

      hook.openSessionsModal()
      hook.handleSessionFilter("0a1b2c3d4e5f")
      expect(hook.sessionModalResult().rows).toEqual([])
      modals.input({ name: "return" })
      await Promise.resolve()

      expect(activateSessionById).toHaveBeenCalledWith("0a1b2c3d4e5f")
      expect(appService.dispatch).not.toHaveBeenCalled()
      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("keeps the picker open and reads nothing when Enter meets a search with no match", async () => {
    await createRoot(async (dispose) => {
      const showToast = mock(() => {})
      const { hook, modals, appService, activateSessionById } = createModal({ sessions: [session({ id: "parent" })], showToast })

      hook.openSessionsModal()
      hook.handleSessionFilter("refactor auth")
      expect(hook.sessionModalResult().rows).toEqual([])
      modals.input({ name: "return" })
      await Promise.resolve()

      expect(activateSessionById).not.toHaveBeenCalled()
      expect(appService.dispatch).not.toHaveBeenCalled()
      expect(showToast).not.toHaveBeenCalled()
      expect(modals.stack).toHaveLength(1)
      dispose()
    })
  })

  it("exposes ctrl+r resume for a session whose row admits it, and resumes it as it opens", async () => {
    await createRoot(async (dispose) => {
      const { hook, modals, appService } = createModal({
        sessions: [session({ id: "chat-paused", admittedActions: ["chat.resume", "session.delete"] })],
      })

      hook.openSessionsModal()
      expect(hook.sessionModalActions().find((action) => action.key === "ctrl+r")?.label).toBe("resume")
      expect(hook.sessionModalActions().some((action) => action.label === "interrupt")).toBe(false)

      pressCtrl(modals, "r")
      await Promise.resolve()

      expect(appService.dispatch).toHaveBeenCalledWith({ type: "chat.resume", sessionId: "chat-paused" })
      dispose()
    })
  })

  it("exposes ctrl+g interrupt for a running chat whose row admits it, and dispatches the chat interrupt", async () => {
    await createRoot(async (dispose) => {
      const { hook, modals, appService } = createModal({ sessions: [session({ id: "chat-running", lifecycleState: "active", activity: "generating", admittedActions: ["chat.interrupt", "session.delete"] })] })

      hook.openSessionsModal()
      // The footer's one line truncates from the end, so Close chat comes after the primary control.
      expect(hook.sessionModalActions().map((action) => action.key)).toEqual(["ctrl+d", "ctrl+e", "ctrl+y", "ctrl+g", "ctrl+x"])

      pressCtrl(modals, "g")
      await Promise.resolve()

      expect(appService.dispatch).toHaveBeenCalledWith({ type: "chat.interrupt", sessionId: "chat-running" })
      dispose()
    })
  })

  it("offers Resume, not Interrupt, for a chat whose row admits both while no turn runs", () => {
    createRoot((dispose) => {
      const { hook } = createModal({ sessions: [session({ id: "chat-interrupted", lifecycleState: "active", activity: "idle", admittedActions: ["chat.interrupt", "chat.resume", "session.delete"] })] })

      hook.openSessionsModal()
      expect(hook.sessionModalActions().find((action) => action.key === "ctrl+r")?.label).toBe("resume")
      expect(hook.sessionModalActions().some((action) => action.label === "interrupt")).toBe(false)
      dispose()
    })
  })

  it("offers neither control for an idle listed row that carries no resume evidence, rather than a wrong Interrupt", () => {
    createRoot((dispose) => {
      const { hook } = createModal({ sessions: [session({ id: "chat-idle-listed", lifecycleState: "active", activity: "idle", admittedActions: ["chat.interrupt", "session.delete"] })] })

      hook.openSessionsModal()
      expect(hook.sessionModalActions().some((action) => action.label === "interrupt")).toBe(false)
      expect(hook.sessionModalActions().some((action) => action.label === "resume")).toBe(false)
      dispose()
    })
  })

  it("offers ctrl+x close chat for an active chat only, closes it now, and names a refusal", async () => {
    await createRoot(async (dispose) => {
      const showToast = mock(() => {})
      const { hook, modals, closeChat } = createModal({
        sessions: [session({ id: "chat-active", lifecycleState: "active" })],
        closeChat: async () => { throw new Error("refused") },
        showToast,
      })

      hook.openSessionsModal()
      expect(hook.sessionModalActions().find((action) => action.key === "ctrl+x")?.label).toBe("close chat")

      pressCtrl(modals, "x")
      await Bun.sleep(1)

      expect(closeChat).toHaveBeenCalledWith("chat-active")
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Close failed"), variant: "error" }))
      dispose()
    })
    createRoot((dispose) => {
      const { hook } = createModal({ sessions: [chatSummary("chat-inactive")] })
      hook.openSessionsModal()
      expect(hook.sessionModalActions().some((action) => action.label === "close chat")).toBe(false)
      dispose()
    })
  })

  it("offers no interrupt for inactive or active chats whose rows admit none", () => {
    createRoot((dispose) => {
      const { hook } = createModal({ sessions: [
        chatSummary("chat-inactive"),
        session({ id: "chat-active", lifecycleState: "active" }),
      ] })

      hook.openSessionsModal()
      expect(hook.sessionModalActions().some((action) => action.label === "interrupt")).toBe(false)
      dispose()
    })
  })

  it("deletes a session on a second ctrl+d of the same row", async () => {
    await createRoot(async (dispose) => {
      const selected = session({ id: "delete-me", title: "Delete me" })
      const { hook, modals, appService } = createModal({ sessions: [selected] })

      hook.openSessionsModal()
      pressCtrl(modals, "d")

      expect(hook.modalConfirmDelete()).toBe("delete-me")
      expect(appService.dispatch).not.toHaveBeenCalled()
      pressCtrl(modals, "d")
      await Promise.resolve()

      expect(appService.dispatch).toHaveBeenCalledWith({ type: "session.delete", sessionId: "delete-me" })
      dispose()
    })
  })

  it("closes on escape and ctrl+s", () => {
    createRoot((dispose) => {
      const { hook, modals } = createModal({ sessions: [session({ id: "s1" })] })

      hook.openSessionsModal()
      modals.input({ name: "escape" })
      expect(modals.stack).toHaveLength(0)

      hook.openSessionsModal()
      modals.input({ name: "s", ctrl: true })
      expect(modals.stack).toHaveLength(0)
      dispose()
    })
  })

  it("moves the cursor with arrows while skipping headers", () => {
    createRoot((dispose) => {
      const newer = session({ id: "newer", lastUpdated: "2026-05-22T00:02:00.000Z" })
      const older = session({ id: "older", lastUpdated: "2026-05-22T00:01:00.000Z" })
      const { hook, modals } = createModal({ sessions: [older, newer] })

      hook.openSessionsModal()
      expect(hook.modalCursor()).toBe(1)

      modals.input({ name: "down" })
      expect(hook.modalCursor()).toBe(2)
      modals.input({ name: "down" })
      expect(hook.modalCursor()).toBe(1)
      modals.input({ name: "up" })
      expect(hook.modalCursor()).toBe(2)
      dispose()
    })
  })

  it("types every letter into the search box while a row is selected, and acts on none", () => {
    createRoot((dispose) => {
      const { hook, modals, appService } = createModal({ sessions: [session({ id: "chat-1", title: "Dim land", lifecycleState: "active", admittedActions: ["chat.resume", "session.delete"] })] })

      hook.openSessionsModal()
      expect(hook.sessionModalActions()).not.toEqual([])
      for (const text of "dim_land") {
        const event = parseKeypress(text)
        if (!event) throw new Error("key sequence was not parsed")
        modals.input(event)
      }

      expect(hook.filterQuery()).toBe("dim_land")
      expect(rowLabels(hook)).toEqual(["chat-1"])
      expect(hook.modalConfirmDelete()).toBeUndefined()
      expect(hook.renameState()).toBeUndefined()
      expect(appService.dispatch).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("triggers each ctrl action on the selected row with an empty and a non-empty search box", async () => {
    for (const query of ["", "chat"]) {
      await createRoot(async (dispose) => {
        mockClipboardCopy.mockClear()
        const { hook, modals, appService, closeChat } = createModal({ sessions: [
          session({ id: "chat-running", title: "Running chat", lifecycleState: "active", activity: "generating", admittedActions: ["chat.interrupt", "session.delete"], lastUpdated: "2026-05-22T00:02:00.000Z" }),
          session({ id: "chat-paused", title: "Paused chat", admittedActions: ["chat.resume", "session.delete"], lastUpdated: "2026-05-22T00:01:00.000Z" }),
        ] })
        const select = (id: string) => hook.selectModalItem(hook.sessionModalResult().rows.findIndex((row) => row.kind === "session" && row.session.id === id))
        hook.openSessionsModal()
        hook.handleSessionFilter(query)

        select("chat-paused")
        expect(hook.sessionModalActions().map((action) => `${action.key} ${action.label}`)).toEqual(["ctrl+d delete", "ctrl+e rename", "ctrl+y copy session ID", "ctrl+r resume"])
        pressCtrl(modals, "y")
        expect(mockClipboardCopy).toHaveBeenCalledWith("chat-paused")
        pressCtrl(modals, "r")
        expect(appService.dispatch).toHaveBeenCalledWith({ type: "chat.resume", sessionId: "chat-paused" })

        hook.openSessionsModal()
        hook.handleSessionFilter(query)
        select("chat-running")
        pressCtrl(modals, "x")
        expect(closeChat).toHaveBeenCalledWith("chat-running")
        pressCtrl(modals, "e")
        expect(hook.renameState()?.sessionId).toBe("chat-running")
        modals.input({ name: "escape" })
        expect(hook.filterQuery()).toBe(query)
        pressCtrl(modals, "d")
        expect(hook.modalConfirmDelete()).toBe("chat-running")
        pressCtrl(modals, "d")
        expect(appService.dispatch).toHaveBeenCalledWith({ type: "session.delete", sessionId: "chat-running" })
        pressCtrl(modals, "g")
        expect(appService.dispatch).toHaveBeenCalledWith({ type: "chat.interrupt", sessionId: "chat-running" })
        await Promise.resolve()
        dispose()
      })
    }
  })

  it("keeps the filter editable after a query produces no rows", () => {
    createRoot((dispose) => {
      const { hook, modals } = createModal({ sessions: [session({ id: "alpha", title: "Alpha" })] })
      hook.openSessionsModal()

      for (const name of ["z", "z", "z"]) modals.input({ name, raw: name })
      expect(hook.sessionModalResult().rows).toEqual([])
      modals.input({ name: "backspace" })
      modals.input({ name: "left" })
      modals.input({ name: "backspace" })

      expect(hook.filterQuery()).toBe("z")
      dispose()
    })
  })

  it("edits the filter with Backspace and Delete while a matching row is selected", () => {
    createRoot((dispose) => {
      const { hook, modals } = createModal({ sessions: [session({ id: "alpha", title: "Alpha" })] })
      hook.openSessionsModal()
      const key = (sequence: string) => {
        const event = parseKeypress(sequence)
        if (!event) throw new Error("key sequence was not parsed")
        modals.input(event)
      }

      for (const text of ["a", "l", "p", "h"]) key(text)
      expect(rowLabels(hook)).toEqual(["alpha"])
      key("\x7f")
      expect(hook.filterQuery()).toBe("alp")
      key("\x08")
      expect(hook.filterQuery()).toBe("al")
      key("\u001b[D")
      key("\u001b[3~")
      expect(hook.filterQuery()).toBe("a")
      dispose()
    })
  })

  it("routes editing and paste through separate filter and rename editors", () => {
    createRoot((dispose) => {
      const { hook, modals, appService } = createModal({ sessions: [session({ id: "alpha", title: "Alpha description", shortTitle: "Alpha" })] })

      hook.openSessionsModal()
      pressCtrl(modals, "e")
      modals.input({ name: "left" })
      expect(modals.paste("X")).toBe(true)

      expect(hook.renameState()?.shortTitle).toBe("AlphXa")
      expect(hook.renameState()?.title).toBe("Alpha description")
      expect(hook.filterQuery()).toBe("")

      modals.input({ name: "enter" })
      expect(appService.dispatch).toHaveBeenCalledWith({ type: "session.rename", sessionId: "alpha", shortTitle: "AlphXa" })
      pressCtrl(modals, "e")
      modals.input({ name: "tab" })
      modals.input({ name: "a", super: true })
      modals.paste("A description longer than the generated title limit of forty-six characters")
      modals.input({ name: "enter" })
      expect(appService.dispatch).toHaveBeenLastCalledWith({ type: "session.rename", sessionId: "alpha", title: "A description longer than the generated title limit of forty-six characters" })
      pressCtrl(modals, "e")
      modals.input({ name: "a", super: true })
      modals.paste("12345678901234567890")
      expect(hook.renameState()?.shortTitle).toBe("12345678901234")
      modals.input({ name: "escape" })
      expect(modals.paste("query")).toBe(true)
      expect(hook.renameState()).toBeUndefined()
      expect(hook.filterQuery()).toBe("query")
      dispose()
    })
  })

  it("starts rename with the effective compact title when a stored title is absent or empty", () => {
    for (const shortTitle of [undefined, ""]) createRoot((dispose) => {
      const { hook, modals } = createModal({ sessions: [session({ id: "alpha", title: "Original description", shortTitle })] })
      hook.openSessionsModal()
      pressCtrl(modals, "e")
      expect(hook.renameState()?.shortTitle).toBe("Original descr")
      expect(hook.renameState()?.title).toBe("Original description")
      dispose()
    })
  })

  it("lists only the chat parent without expanding its workflow and subagent ids", () => {
    createRoot((dispose) => {
      const parent = session({ id: "parent", childSessionIds: ["child-1", "child-2", "workflow"], lastUpdated: "2026-05-22T00:06:00.000Z" })
      const { hook, modals, activateSession } = createModal({ sessions: [parent] })

      hook.openSessionsModal()
      expect(rowLabels(hook)).toEqual(["Today", "parent"])
      modals.input({ name: "down" })
      modals.input({ name: "enter" })
      expect(activateSession).toHaveBeenCalledWith(parent)
      dispose()
    })
  })

  it("filters exact full session ids to a single row without a highlight query", () => {
    createRoot((dispose) => {
      const { hook } = createModal({ sessions: [session({ id: "alpha-id" }), session({ id: "beta-id" })] })

      hook.openSessionsModal()
      hook.handleSessionFilter("  beta-id  ")

      expect(rowLabels(hook)).toEqual(["beta-id"])
      expect(hook.sessionModalResult().effectiveHighlightQuery).toBe("")
      dispose()
    })
  })

  it("matches sessions whose title, short title, or id has a word that each typed word starts, and hides date headers", () => {
    createRoot((dispose) => {
      const { hook } = createModal({ sessions: [
        session({ id: "0a1b2c3d4e5f", title: "Delay subagent spawn", lastUpdated: "2026-05-22T00:03:00.000Z" }),
        session({ id: "9f8e7d6c5b4a", title: "Lead agent trial", lastUpdated: "2026-05-22T00:02:00.000Z" }),
        session({ id: "1234abcd5678", title: "Untitled work", shortTitle: "Kafka lag", lastUpdated: "2026-05-22T00:01:00.000Z" }),
      ] })

      hook.openSessionsModal()
      hook.handleSessionFilter("lead agent")
      expect(rowLabels(hook)).toEqual(["9f8e7d6c5b4a"])
      expect(hook.sessionModalResult().effectiveHighlightQuery).toBe("lead agent")
      hook.handleSessionFilter("a")
      expect(rowLabels(hook)).toEqual(["9f8e7d6c5b4a"])
      hook.handleSessionFilter("kaf")
      expect(rowLabels(hook)).toEqual(["1234abcd5678"])
      hook.handleSessionFilter("0a1b")
      expect(rowLabels(hook)).toEqual(["0a1b2c3d4e5f"])
      hook.handleSessionFilter("s")
      expect(rowLabels(hook)).toEqual(["0a1b2c3d4e5f"])
      expect(hook.sessionModalResult().rows.every((row) => row.kind === "session")).toBe(true)
      dispose()
    })
  })

  it("lists unreadable sessions under a trailing header and refuses to open them", async () => {
    await createRoot(async (dispose) => {
      const { hook, modals, activateSession } = createModal({
        sessions: [session({ id: "good" })],
        errors: [{ sessionId: "broken", scope: "metadata", reason: "bad created fact" }],
      })

      hook.openSessionsModal()
      expect(rowLabels(hook)).toEqual(["Today", "good", "", "Unreadable", "corrupt:broken"])

      modals.input({ name: "down" })
      expect(hook.modalCursor()).toBe(4)
      modals.input({ name: "enter" })
      await Promise.resolve()

      expect(activateSession).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("keeps unreadable sessions delete-only with copy-id available", () => {
    createRoot((dispose) => {
      const { hook } = createModal({
        sessions: [],
        errors: [{ sessionId: "broken", scope: "metadata", reason: "bad created fact" }],
      })

      hook.openSessionsModal()

      expect(hook.sessionModalActions().map((action) => [action.key, action.label])).toEqual([
        ["ctrl+d", "delete"],
        ["ctrl+y", "copy session ID"],
      ])
      dispose()
    })
  })

  it("deletes a corrupt session on a second ctrl+d", async () => {
    await createRoot(async (dispose) => {
      const { hook, modals, appService } = createModal({
        sessions: [],
        errors: [{ sessionId: "broken", scope: "metadata", reason: "bad created fact" }],
      })

      hook.openSessionsModal()
      pressCtrl(modals, "d")

      expect(hook.modalConfirmDelete()).toBe("broken")
      pressCtrl(modals, "d")
      await Promise.resolve()

      expect(appService.dispatch).toHaveBeenCalledWith({ type: "session.delete", sessionId: "broken" })
      dispose()
    })
  })

  it("a late activation cannot close a newer modals or warn into it", async () => {
    await createRoot(async (dispose) => {
      const activation = Promise.withResolvers<SessionActivationResult>()
      const showToast = mock(() => {})
      const { hook, modals } = createModal({
        sessions: [session({ id: "s1" })],
        errors: [{ sessionId: "s1", scope: "budget", reason: "enrichment failed" }],
        activateSession: () => activation.promise,
        showToast,
      })

      hook.openSessionsModal()
      modals.input({ name: "enter" })
      modals.input({ name: "escape" })
      const newer = modals.replace("newer-modals")

      activation.resolve({ ok: true })
      await Promise.resolve()
      await Promise.resolve()

      expect(newer.isOpen()).toBe(true)
      expect(modals.stack).toHaveLength(1)
      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("drops an activation failure after the Sessions modals is replaced", async () => {
    await createRoot(async (dispose) => {
      const activation = Promise.withResolvers<SessionActivationResult>()
      const showToast = mock(() => {})
      const { hook, modals } = createModal({
        sessions: [session({ id: "s1", title: "Session One" })],
        activateSession: () => activation.promise,
        showToast,
      })

      hook.openSessionsModal()
      modals.input({ name: "enter" })
      modals.replace("newer-modals")
      activation.resolve({ ok: false, error: "activation failed" })
      await Promise.resolve()
      await Promise.resolve()

      expect(modals.stack[0]?.element).toBe("newer-modals")
      expect(showToast).not.toHaveBeenCalled()
      dispose()
    })
  })

  it("names the deleted session and leaves a newer modals's cursor alone", async () => {
    await createRoot(async (dispose) => {
      const deletion = Promise.withResolvers<{ ok: true }>()
      const showToast = mock(() => {})
      const { hook, modals } = createModal({
        sessions: [
          session({ id: "first", title: "First", lastUpdated: "2026-05-22T00:02:00.000Z" }),
          session({ id: "second", title: "Second", lastUpdated: "2026-05-22T00:01:00.000Z" }),
        ],
        dispatch: (command) => command.type === "session.delete" ? deletion.promise : Promise.resolve({ ok: true as const }),
        showToast,
      })

      hook.openSessionsModal()
      pressCtrl(modals, "d")
      pressCtrl(modals, "d")

      hook.openSessionsModal()
      modals.input({ name: "down" })
      const cursorOfNewerModal = hook.modalCursor()

      deletion.resolve({ ok: true })
      await Promise.resolve()
      await Promise.resolve()

      expect(hook.modalCursor()).toBe(cursorOfNewerModal)
      expect(showToast).toHaveBeenCalledWith({ message: "Session deleted: First", variant: "info" })
      dispose()
    })
  })
})
