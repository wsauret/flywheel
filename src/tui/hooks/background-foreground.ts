import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { DraftCache } from "./create-draft-cache.js"
import type { ShellServices } from "./shell-state.js"

interface DiscardTransientDeps {
  draftCache: Pick<DraftCache, "hasDraft">
  appService: Pick<RuntimeClient, "dispatch">
  showToast: ShellServices["showToast"]
  closeSessionTab: (sessionId: string) => void
  isTransientSessionTab: (sessionId: string) => boolean
}

/** Discard a transient chat session with no transcript content or local draft.
 *  Runtime owns the store/durable checks; the TUI only knows whether it has a
 *  local draft, so it suppresses the request when a draft exists. Durable
 *  cleanup and local tab removal only: the caller owns navigation. */
export async function discardIfTransientForeground(
  deps: DiscardTransientDeps,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId || deps.draftCache.hasDraft(sessionId)) return

  const closeLocalTab = deps.isTransientSessionTab(sessionId)
  const result = await deps.appService.dispatch({ type: "session.discard_transient", sessionId })
  if (result.ok && result.sessionRemoved && closeLocalTab) deps.closeSessionTab(sessionId)
  if (!result.ok) deps.showToast({ message: result.error, variant: "error" })
}

