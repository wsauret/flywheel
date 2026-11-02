import { describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"
import { parseKeypress } from "@opentui/core"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import type { LoadedWorkflowView } from "../../../../src/protocol/workflow-view-protocol-types.js"
import type { SessionActivationResult } from "../../../../src/tui/hooks/session-activation.js"
import type { useSessionModal } from "../../../../src/tui/hooks/use-session-modal.js"
import { createModal, mockClipboardCopy, rowLabels, session } from "./_session-modal-fixtures.js"

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
      expect(hook.sessionModalActions().some((action) => action.key === "r")).toBe(false)

      // A single action key schedules its shortcut (it may still become filter
      // text); the immediate repeat confirms it without waiting out the delay.
      modals.input({ name: "c", raw: "c" })
      modals.input({ name: "c", raw: "c" })
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

      expect(hook.sessionModalActions().some((action) => action.key === "r")).toBe(false)
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

  it("exposes r resume for a session whose row admits it, and resumes it as it opens", async () => {
    await createRoot(async (dispose) => {
      const { hook, modals, appService } = createModal({
        sessions: [session({ id: "chat-paused", admittedActions: ["chat.resume", "session.delete"] })],
      })

      hook.openSessionsModal()
      expect(hook.sessionModalActions().find((action) => action.key === "r")?.label).toBe("resume")
      expect(hook.sessionModalActions().some((action) => action.key === "i")).toBe(false)

      modals.input({ name: "r", raw: "r" })
      modals.input({ name: "r", raw: "r" })
      await Promise.resolve()

      expect(appService.dispatch).toHaveBeenCalledWith({ type: "chat.resume", sessionId: "chat-paused" })
      dispose()
    })
  })

  it("exposes i interrupt for a running chat whose row admits it, and dispatches the chat interrupt", async () => {
    await createRoot(async (dispose) => {
      const { hook, modals, appService } = createModal({ sessions: [session({ id: "chat-running", lifecycleState: "active", activity: "generating", admittedActions: ["chat.interrupt", "session.delete"] })] })

      hook.openSessionsModal()
      expect(hook.sessionModalActions().find((action) => action.key === "i")?.label).toBe("interrupt")

      modals.input({ name: "i", raw: "i" })
      modals.input({ name: "i", raw: "i" })
      await Promise.resolve()

      expect(appService.dispatch).toHaveBeenCalledWith({ type: "chat.interrupt", sessionId: "chat-running" })
      dispose()
    })
  })

  it("offers Resume, not Interrupt, for a chat whose row admits both while no turn runs", () => {
    createRoot((dispose) => {
      const { hook } = createModal({ sessions: [session({ id: "chat-interrupted", lifecycleState: "active", activity: "idle", admittedActions: ["chat.interrupt", "chat.resume", "session.delete"] })] })

      hook.openSessionsModal()
      expect(hook.sessionModalActions().find((action) => action.key === "r")?.label).toBe("resume")
      expect(hook.sessionModalActions().some((action) => action.key === "i")).toBe(false)
      dispose()
    })
  })

  it("offers neither control for an idle listed row that carries no resume evidence, rather than a wrong Interrupt", () => {
    createRoot((dispose) => {
      const { hook } = createModal({ sessions: [session({ id: "chat-idle-listed", lifecycleState: "active", activity: "idle", admittedActions: ["chat.interrupt", "session.delete"] })] })

      hook.openSessionsModal()
      expect(hook.sessionModalActions().some((action) => action.key === "i")).toBe(false)
      expect(hook.sessionModalActions().some((action) => action.label === "resume")).toBe(false)
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
      expect(hook.sessionModalActions().some((action) => action.key === "i")).toBe(false)
      dispose()
    })
  })

  it("requires the delayed d confirmation before deleting a session", async () => {
    await createRoot(async (dispose) => {
      const selected = session({ id: "delete-me", title: "Delete me" })
      const { hook, modals, appService } = createModal({ sessions: [selected] })

      hook.openSessionsModal()
      modals.input({ name: "d", raw: "d" })
      await Bun.sleep(1)

      expect(hook.modalConfirmDelete()).toBe("delete-me")
      modals.input({ name: "d", raw: "d" })
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

  it("turns printable action-key prefixes into typed filtering when followed by text", () => {
    createRoot((dispose) => {
      const { hook, modals } = createModal({ sessions: [session({ id: "delete", title: "Delete Target" })] })

      hook.openSessionsModal()
      modals.input({ name: "d", raw: "d" })
      modals.input({ name: "e", raw: "e" })

      expect(hook.filterQuery()).toBe("de")
      expect(rowLabels(hook)).toEqual(["delete"])
      dispose()
    })
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

  it("routes editing and paste through separate filter and rename editors", () => {
    createRoot((dispose) => {
      const { hook, modals, appService } = createModal({ sessions: [session({ id: "alpha", title: "Alpha description", shortTitle: "Alpha" })] })

      hook.openSessionsModal()
      modals.input({ name: "n", raw: "n" })
      modals.input({ name: "n", raw: "n" })
      modals.input({ name: "left" })
      expect(modals.paste("X")).toBe(true)

      expect(hook.renameState()?.shortTitle).toBe("AlphXa")
      expect(hook.renameState()?.title).toBe("Alpha description")
      expect(hook.filterQuery()).toBe("")

      modals.input({ name: "enter" })
      expect(appService.dispatch).toHaveBeenCalledWith({ type: "session.rename", sessionId: "alpha", shortTitle: "AlphXa" })
      modals.input({ name: "n", raw: "n" })
      modals.input({ name: "n", raw: "n" })
      modals.input({ name: "tab" })
      modals.input({ name: "a", super: true })
      modals.paste("A description longer than the generated title limit of forty-six characters")
      modals.input({ name: "enter" })
      expect(appService.dispatch).toHaveBeenLastCalledWith({ type: "session.rename", sessionId: "alpha", title: "A description longer than the generated title limit of forty-six characters" })
      modals.input({ name: "n", raw: "n" })
      modals.input({ name: "n", raw: "n" })
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
      modals.input({ name: "n", raw: "n" })
      modals.input({ name: "n", raw: "n" })
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

  it("ordinary text fuzzy-filters sessions and hides date headers", () => {
    createRoot((dispose) => {
      const { hook } = createModal({ sessions: [session({ id: "alpha-id", title: "Alpha task" }), session({ id: "beta-id", title: "Beta task" })] })

      hook.openSessionsModal()
      hook.handleSessionFilter("alpha")

      expect(hook.sessionModalResult().rows.every((row) => row.kind === "session")).toBe(true)
      expect(rowLabels(hook)).toEqual(["alpha-id"])
      expect(hook.sessionModalResult().effectiveHighlightQuery).toBe("alpha")
      expect(hook.sessionModalActions()).toEqual([])
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
        ["d", "delete"],
        ["c", "copy session ID"],
      ])
      dispose()
    })
  })

  it("deletes a corrupt session with the delayed d confirmation", async () => {
    await createRoot(async (dispose) => {
      const { hook, modals, appService } = createModal({
        sessions: [],
        errors: [{ sessionId: "broken", scope: "metadata", reason: "bad created fact" }],
      })

      hook.openSessionsModal()
      modals.input({ name: "d", raw: "d" })
      await Bun.sleep(1)

      expect(hook.modalConfirmDelete()).toBe("broken")
      modals.input({ name: "d", raw: "d" })
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
      modals.input({ name: "d", raw: "d" })
      modals.input({ name: "d", raw: "d" })
      modals.input({ name: "d", raw: "d" })

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
