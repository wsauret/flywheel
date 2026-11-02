import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { createRoot } from "solid-js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSessionManager, type SessionManager } from "../../../../src/orchestration/session/manager.js"
import type { DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"

import { useSessionModal } from "../../../../src/tui/hooks/use-session-modal.js"
import { createSignals } from "../hooks/_session-modal-fixtures.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

const { createActiveSessionDelete } = await import("../../../../src/tui/hooks/create-modals.js")
const TMP_ROOT = path.join(os.tmpdir(), `flywheel-session-modal-delete-${process.pid}`)

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function sessionDir(baseDir: string, sessionId: string): string {
  return path.join(baseDir, ".flywheel", "sessions", sessionId)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return
    await Bun.sleep(5)
  }
}

function frontendSession(session: DurableSessionCatalogRow): SessionCatalogRow {
  return {
    id: session.id,
    kind: "chat",
    title: session.label || session.name || session.id,
    ...(session.shortLabel !== undefined ? { shortTitle: session.shortLabel } : {}),
    lifecycleState: session.lifecycleState,
    notices: [],
    inputMode: { kind: "chat" },
    lastUpdated: session.lastUpdated,
    executionCwd: session.executionCwd,
    totalsLoading: true,
    ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.childSessionIds !== undefined ? { childSessionIds: session.childSessionIds } : {}),
  }
}

async function frontendSessions(manager: SessionManager): Promise<SessionCatalogRow[]> {
  return (await manager.listMetadata()).sessions.filter((session) => session.kind === "chat").map(frontendSession)
}

function appService(manager: SessionManager) {
  const service = { dispatch: runtimeDispatch({ "session.delete": async (command) => {
    const plan = await manager.admitDeletion(command.sessionId)
    for (const target of plan.targets) await manager.finalizeDeletionTarget(target)
    return { ok: true }
  } }) }
  spyOn(service, "dispatch")
  return service
}

afterEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe("useSessionModal delete", () => {
  it("removes the session folder when deleting an inactive modal row", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const baseDir = makeTmpDir()
        const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
        const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store: eventStore })
        const sessionId = await manager.createChat({ name: "Delete Me" })
        await manager.updateLifecycleState(sessionId, "inactive")

        const modal = createModalStack()
        const service = appService(manager)
        const sessions = await frontendSessions(manager)
        const hook = useSessionModal({
          modal,
          renderModal: () => "mock-element",
          signals: createSignals(),
          appService: service,
          showToast: mock(() => {}),
          sessions: () => sessions,
          sessionCatalogErrors: () => [],
          seedSessionCatalogRow: () => {},
          clipboard: { copy: async () => {}, readImage: async () => null },
          activateSession: mock(async () => ({ ok: true as const })),
          activateSessionById: mock(async () => {}),
          deleteActiveSession: mock(async () => {}),
        })

        hook.openSessionsModal()
        // First press schedules the shortcut, the repeat confirms it (arming
        // the delete confirmation), and the third press deletes.
        modal.input({ name: "d", raw: "d" })
        modal.input({ name: "d", raw: "d" })
        modal.input({ name: "d", raw: "d" })
        await waitFor(() => !fs.existsSync(sessionDir(baseDir, sessionId)))

        expect(service.dispatch).toHaveBeenCalledWith({ type: "session.delete", sessionId })
        expect(fs.existsSync(sessionDir(baseDir, sessionId))).toBe(false)
        expect((await manager.listMetadata()).sessions.find((session) => session.id === sessionId)).toBeUndefined()
        eventStore.close()
        dispose()
        resolve()
      })
    })
  })

  it("removes the foreground session folder through the modal delete callback", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const baseDir = makeTmpDir()
        const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
        const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store: eventStore })
        const sessionId = await manager.createChat({ name: "Active" })
        const service = appService(manager)
        const deleteActiveSession = mock(async (id: string) => {
          const result = await service.dispatch({ type: "session.delete", sessionId: id })
          if (!result.ok) throw new Error("delete failed")
        })

        const modals2 = createModalStack()
        const sessions = await frontendSessions(manager)
        const hook = useSessionModal({
          modal: modals2,
          renderModal: () => "mock-element",
          signals: createSignals({}, sessionId),
          appService: service,
          showToast: mock(() => {}),
          sessions: () => sessions,
          sessionCatalogErrors: () => [],
          seedSessionCatalogRow: () => {},
          clipboard: { copy: async () => {}, readImage: async () => null },
          activateSession: mock(async () => ({ ok: true as const })),
          activateSessionById: mock(async () => {}),
          deleteActiveSession,
        })

        hook.openSessionsModal()
        // Schedule, confirm-arm, then delete: see the inactive-row test above.
        modals2.input({ name: "d", raw: "d" })
        modals2.input({ name: "d", raw: "d" })
        modals2.input({ name: "d", raw: "d" })
        await waitFor(() => !fs.existsSync(sessionDir(baseDir, sessionId)))

        expect(deleteActiveSession).toHaveBeenCalledWith(sessionId)
        expect(fs.existsSync(sessionDir(baseDir, sessionId))).toBe(false)
        expect(modals2.stack.length).toBe(1)
        eventStore.close()
        dispose()
        resolve()
      })
    })
  })
})

describe("active session delete fallback", () => {
  function harness(initialTabs: readonly string[], dispatch: () => Promise<{ ok: true }> = async () => ({ ok: true as const })) {
    const state = { tabs: [...initialTabs], foregroundId: initialTabs[0], foregroundRevision: 0 }
    const switched: string[] = []
    let freshChats = 0
    const deleteActiveSession = createActiveSessionDelete({
      appService: { dispatch: runtimeDispatch({ "session.delete": dispatch }) },
      signals: { foregroundRevision: () => state.foregroundRevision },
      tabs: () => state.tabs.map((id) => ({ kind: "session" as const, id, title: id, isForeground: id === state.foregroundId, isBusy: false, isBlocked: false })),
      closeSessionTab: (id) => { state.tabs = state.tabs.filter((tab) => tab !== id) },
      switchForeground: async (id) => {
        switched.push(id)
        state.foregroundId = id
        state.foregroundRevision += 1
      },
      startChat: async () => { freshChats += 1; return { kind: "foregrounded", sessionId: "fresh" } },
    })
    const selectTab = (id: string): void => {
      state.foregroundId = id
      state.foregroundRevision += 1
    }
    return { deleteActiveSession, state, switched, selectTab, freshChats: () => freshChats }
  }

  it("derives the fallback from the tab list that survives the delete", async () => {
    const h = harness(["a", "b", "c"])

    await h.deleteActiveSession("a")

    expect(h.state.tabs).toEqual(["b", "c"])
    expect(h.switched).toEqual(["b"])
  })

  it("starts a fresh chat when the delete leaves no tab", async () => {
    const h = harness(["only"])

    await h.deleteActiveSession("only")

    expect(h.switched).toEqual([])
    expect(h.freshChats()).toBe(1)
  })

  it("leaves the user's own tab selection alone, including A to B to A", async () => {
    const pending = Promise.withResolvers<{ ok: true }>()
    const h = harness(["a", "b", "c"], () => pending.promise)

    const deletion = h.deleteActiveSession("a")
    h.selectTab("c")
    h.selectTab("b")
    h.selectTab("c")
    pending.resolve({ ok: true })
    await deletion

    expect(h.state.tabs).toEqual(["b", "c"])
    expect(h.switched).toEqual([])
    expect(h.state.foregroundId).toBe("c")
  })
  it("excludes the deleted session while its catalog row still projects into tabs", async () => {
    const tabs = ["a", "b", "c"]
    const switched: string[] = []
    const deleteActiveSession = createActiveSessionDelete({
      appService: { dispatch: runtimeDispatch({ "session.delete": async () => ({ ok: true }) }) },
      signals: { foregroundRevision: () => 0 },
      tabs: () => tabs.map((id) => ({ kind: "session" as const, id, title: id, isForeground: id === "a", isBusy: false, isBlocked: false })),
      closeSessionTab: () => {},
      switchForeground: async (id) => { switched.push(id) },
      startChat: async () => ({ kind: "foregrounded", sessionId: "fresh" }),
    })

    await deleteActiveSession("a")

    expect(switched).toEqual(["b"])
  })

})
