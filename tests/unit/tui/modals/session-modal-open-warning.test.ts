import { afterEach, describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSessionManager, type SessionManager } from "../../../../src/orchestration/session/manager.js"
import type { DurableSessionCatalogError, DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"
import { useSessionModal } from "../../../../src/tui/hooks/use-session-modal.js"
import { createSignals } from "../hooks/_session-modal-fixtures.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"

const TMP_ROOT = path.join(os.tmpdir(), `flywheel-session-modal-open-warning-${process.pid}`)

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return dir
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

afterEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

async function openSessionAndCollectToasts(sessionCatalogErrors: (sessionId: string) => DurableSessionCatalogError[]): Promise<Array<{ message: string; variant: string }>> {
  return new Promise((resolve) => {
    createRoot(async (dispose) => {
      const baseDir = makeTmpDir()
      const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
      const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store: eventStore })
      const sessionId = await manager.createChat({ name: "Open Me" })
      await manager.updateLifecycleState(sessionId, "inactive")
      const sessions = await frontendSessions(manager)
      const toasts: Array<{ message: string; variant: string }> = []
      const activateSession = mock(async () => ({ ok: true as const }))

      const modal = createModalStack()
      const hook = useSessionModal({
        modal,
        renderModal: () => "mock-element",
        signals: createSignals(),
        appService: { dispatch: async () => { throw new Error("unexpected mutation") } },
        showToast: (opts) => { toasts.push(opts) },
        sessions: () => sessions,
        sessionCatalogErrors: () => sessionCatalogErrors(sessionId),
        clipboard: { copy: async () => {}, readImage: async () => null },
            activateSession,
        activateSessionById: mock(async () => {}),
        closeChat: async () => {},
        deleteActiveSession: mock(async () => {}),
      })

      hook.openSessionsModal()
      modal.input({ name: "return" })
      await waitFor(() => activateSession.mock.calls.length > 0)
      await Bun.sleep(5)

      eventStore.close()
      dispose()
      resolve(toasts)
    })
  })
}

describe("useSessionModal open warning", () => {
  it("toasts a warning when the opened session has degraded list details", async () => {
    const toasts = await openSessionAndCollectToasts((sessionId) => [
      { sessionId, scope: "budget", reason: "bad event" },
    ])
    expect(toasts).toEqual([
      { message: "Some details for this session couldn't be loaded", variant: "warning" },
    ])
  })

})
