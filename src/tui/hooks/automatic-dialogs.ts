import { createEffect, untrack } from "solid-js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import { providerSetup } from "../../protocol/client/provider-setup.js"

/** Allows automatic auth and paid-use presentation unless verification opts out.
 * This process-only override does not change authentication or recorded consent.
 * Set FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS=0 to exercise automatic dialog behavior. */
export function automaticDialogsEnabled(): boolean {
  return process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS !== "1"
}

/** Offers provider setup once per shell without replacing an occupied editor. */
export function useAutomaticAuth(deps: {
  readonly auth: () => RuntimeAuthView | undefined
  readonly overlayOpen: () => boolean
  readonly open: () => void
}): void {
  let presented = false
  createEffect(() => {
    const setup = providerSetup(deps.auth())
    const occupied = deps.overlayOpen()
    if (presented || !automaticDialogsEnabled() || occupied || setup !== "none") return
    presented = true
    untrack(deps.open)
  })
}
