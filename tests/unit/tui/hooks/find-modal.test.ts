import { describe, expect, it, mock } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import type { TranscriptSearchResult } from "../../../../src/protocol/transcript-protocol-types.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { useFindModal } from "../../../../src/tui/hooks/use-find-modal.js"
import { session } from "./_session-modal-fixtures.js"

const row = (id: string, title: string): SessionCatalogRow => session({ id, title })

function createHarness() {
  const [sessions] = createSignal<readonly SessionCatalogRow[]>([row("s1", "Alpha"), row("s2", "Beta")])
  const modal = createModalStack()
  const answers: TranscriptSearchResult = { hits: [
    { sessionId: "s2", sessionTitle: "Beta", entryId: "e9", role: "assistant", snippet: "the [kafka] pipeline" },
    { sessionId: "s1", entryId: "e1", role: "user", snippet: "deploy [kafka]" },
  ], total: 2, page: 1, pageSize: 20 }
  const query = mock(async () => answers)
  const activateSession = mock(async () => ({ ok: true as const }))
  const showToast = mock(() => {})
  const hook = createRoot(() => useFindModal({
    modal,
    renderModal: () => null,
    appService: { query },
    sessions,
    foregroundSessionId: () => "s1",
    activateSession,
    showToast,
  }))
  return { hook, modal, query, activateSession, showToast }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("useFindModal", () => {
  it("opens with a query, searches the foreground chat, and opens the hit's session on return", async () => {
    const { hook, modal, query, activateSession } = createHarness()
    hook.openFindModal("kafka")
    expect(modal.stack).toHaveLength(1)
    await settle()
    expect(query).toHaveBeenCalledWith({ type: "transcriptSearch", request: { query: "kafka", page: 1, sessionId: "s1" } })
    expect(hook.hits().length).toBe(2)
    expect(hook.total()).toBe(2)
    expect(hook.hitSession(hook.hits()[0]!)?.title).toBe("Beta")

    hook.openRow(0)
    await settle()
    expect(activateSession).toHaveBeenCalledWith(expect.objectContaining({ id: "s2" }))
    expect(modal.stack).toHaveLength(0)
  })

})
