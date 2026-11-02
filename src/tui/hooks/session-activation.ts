import type { SessionCatalogRow, RuntimeClient } from "../../protocol/app-service-types.js"
import { resolveSessionRoute, type SessionRoute } from "../../protocol/client/held-session-details.js"
import { parseSessionLink } from "../../protocol/client/session-links.js"
import { errorMessage } from "../../infra/error-message.js"
import { discardIfTransientForeground } from "./background-foreground.js"
import type { DraftCache } from "./create-draft-cache.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"
import type { ChildPlaces } from "./create-child-viewer-opener.js"

interface SessionActivatorDeps {
  signals: Pick<ShellSignals, "foregroundId" | "setForegroundId">
  draftCache: Pick<DraftCache, "hasDraft">
  appService: Pick<RuntimeClient, "dispatch">
  openSessionTab: (sessionId: string) => void
  closeSessionTab: (sessionId: string) => void
  isTransientSessionTab: (sessionId: string) => boolean
  showToast: ShellServices["showToast"]
  dismissModalStack?: () => void
}

export type SessionActivationResult = { readonly ok: true } | { readonly ok: false; readonly error?: string }

interface SessionActivatorByIdDeps {
  rows: () => readonly SessionCatalogRow[]
  appService: Pick<RuntimeClient, "query">
  activateSession: (session: SessionCatalogRow) => Promise<SessionActivationResult>
  openChild: ChildPlaces["openChild"]
  seedSessionCatalogRow: (row: SessionCatalogRow) => void
  showToast: ShellServices["showToast"]
}

/** A session's route through the shared resolver: a listed chat from its
 *  catalog row, every other link through a passive detail read, which the
 *  runtime holds nothing for. */
export function readSessionRoute(
  client: Pick<RuntimeClient, "query">,
  rows: readonly SessionCatalogRow[],
  sessionId: string,
): Promise<SessionRoute | undefined> {
  return resolveSessionRoute(async (id) => rows.find((row) => row.id === id) ?? (await client.query({ type: "sessionDetail", sessionId: id })).view?.row, sessionId)
}

/** Opens a session named by id, as a transcript link or a search hit names
 *  it. A listed session activates from its catalog row. Anything else is
 *  read through `sessionDetail`: a child (never listed, ARCH-PROTOCOL-048) opens over
 *  its root chat, a subagent in its viewer and a workflow as its full-size
 *  card, with the agent that `agent` names over the card; a listed session
 *  whose row has not reached this window activates from the row its detail
 *  carries, and only a session the runtime no longer has is reported. */
export function createSessionActivatorById(deps: SessionActivatorByIdDeps): (sessionId: string) => Promise<void> {
  return async function activateSessionById(sessionId: string): Promise<void> {
    const route = await readSessionRoute(deps.appService, deps.rows(), sessionId)
    if (!route) {
      deps.showToast({ message: `Session ${sessionId} no longer exists`, variant: "error" })
      return
    }
    const { root, children } = route
    if (!deps.rows().some((row) => row.id === root.id)) deps.seedSessionCatalogRow(root)
    const result = await deps.activateSession(root)
    if (!result.ok) {
      if (result.error) deps.showToast({ message: `Open failed for ${root.title || root.id}: ${result.error}`, variant: "error" })
      return
    }
    for (const child of children) deps.openChild(child)
  }
}

interface LinkNavigatorDeps {
  readonly openSession: (sessionId: string) => Promise<void>
  /** Offers a link no session claims to the module clients. */
  readonly openModuleUri: (uri: string) => Promise<boolean>
  readonly showToast: ShellServices["showToast"]
}

/** Follows a link a person activated, such as a subagent row or a transcript
 *  link. No caller waits on a followed link, so this is where an open that
 *  fails, such as a detail read that times out while the runtime is busy, is
 *  reported to the person instead of escaping as an unhandled rejection. */
export function createLinkNavigator(deps: LinkNavigatorDeps): (uri: string) => void {
  return function navigateUri(uri: string): void {
    const link = parseSessionLink(uri)
    const opening = link ? deps.openSession(link.sessionId) : deps.openModuleUri(uri)
    void opening.catch((cause: unknown) => {
      deps.showToast({ message: `Open failed for ${link?.sessionId ?? uri}: ${errorMessage(cause)}`, variant: "error" })
    })
  }
}

/** Selects a listed session and replaces the prior empty New Chat tab only when the runtime confirms its removal. */
export function createSessionActivator(deps: SessionActivatorDeps): (session: SessionCatalogRow) => Promise<SessionActivationResult> {
  return async function selectSession(session: SessionCatalogRow): Promise<SessionActivationResult> {
    deps.dismissModalStack?.()
    const previousForegroundId = deps.signals.foregroundId()
    deps.openSessionTab(session.id)
    deps.signals.setForegroundId(session.id)
    if (previousForegroundId !== session.id && previousForegroundId && deps.isTransientSessionTab(previousForegroundId)) {
      await discardIfTransientForeground(deps, previousForegroundId)
    }
    return { ok: true }
  }
}
