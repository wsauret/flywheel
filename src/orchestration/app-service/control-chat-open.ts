import type { SessionCatalogRow } from "../../protocol/app-service-types.js"
import { resolveSessionAuthProfile } from "../session/session-auth-profile.js"
import type { ProjectControlClientOptions } from "./project-control-client.js"

interface ControlChatOpenDeps extends Pick<ProjectControlClientOptions, "authProfiles" | "executionCwd" | "executionPaused"> {
  readonly sessions: Pick<ProjectControlClientOptions["state"]["sessions"], "allocateId" | "read" | "createChat">
  /** The row a listing shows, read once the chat exists. */
  readonly catalogRow: (sessionId: string) => Promise<SessionCatalogRow | undefined>
}

/** The control placement's one open of a chat, which `chat.open` and a module's control part share. It writes the
 *  durable chat and answers its catalog row without the executor. A chat opened with a name keeps that name for its
 *  whole life. The client that shows the chat activates it under its own hold, so the open attaches no runner that no
 *  connection would release. Rejects when the chat cannot be created or read back. */
export function createControlChatOpen(deps: ControlChatOpenDeps) {
  return async (chat: { readonly sessionId?: string; readonly name?: string }): Promise<{ readonly sessionId: string; readonly row: SessionCatalogRow }> => {
    // This inspection precedes every await: later default changes cannot
    // change the profile chosen for this click. The chat records the profile
    // that serves it, so an environment selector's choice outlives this
    // process (PI-MODEL-033). Resolution refuses an unavailable profile.
    const { effectiveId: authProfileId } = resolveSessionAuthProfile({}, deps.authProfiles.inspect())
    const sessionId = chat.sessionId ?? deps.sessions.allocateId()
    // A client names its chat so that it can send the open again when the
    // answer was lost with its connection. The chat is the record of the
    // open: a copy finds it and creates nothing. A copy that arrives while
    // the first open creates loses the guarded create, which writes only
    // to a session that does not exist, and then finds that chat.
    const exists = async (): Promise<boolean> => chat.sessionId !== undefined && await deps.sessions.read(sessionId) !== null
    if (!await exists()) {
      await deps.sessions.createChat({
        id: sessionId, conversationId: deps.sessions.allocateId(), name: chat.name ?? "New Chat", ...(chat.name === undefined ? {} : { userNamed: true as const }),
        executionCwd: deps.executionCwd, initialState: deps.executionPaused?.() ? "inactive" : "active", authProfileId,
      }).catch(async (cause: unknown) => { if (!await exists()) throw cause })
    }
    const row = await deps.catalogRow(sessionId)
    if (!row) throw new Error(`Session not found after creation: ${sessionId}`)
    return { sessionId, row }
  }
}
