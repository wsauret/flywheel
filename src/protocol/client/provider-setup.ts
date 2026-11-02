import type { AuthProviderStatus } from "../auth-status-protocol-types.js"
import { runtimeCallPolicies } from "../runtime-client-deadlines.js"

/** Whether a chat send can reach any model provider, as the auth view states
 *  it. "loading" means the client has no auth view yet, so it cannot tell
 *  "no provider" from "some provider". */
export type ProviderSetup = "loading" | "none" | "usable"

/** The one rule every client uses to decide a chat send and its provider
 *  setup screen. A model provider is usable when it holds a credential that
 *  can serve now. A provider never set up, one whose key the provider
 *  rejected, and one whose login expired all count as none: each needs the
 *  person in provider setup, so each gets that one remedy. Web providers
 *  serve search, not turns. */
export function providerSetup(auth: { readonly providers: readonly Pick<AuthProviderStatus, "group" | "source" | "expired">[] } | undefined): ProviderSetup {
  if (auth === undefined) return "loading"
  return auth.providers.some((provider) => provider.group === "model" && (provider.source === "stored_key" || provider.source === "oauth") && !provider.expired)
    ? "usable"
    : "none"
}

/** The words every client uses when the rule answers "none". They stay true
 *  for each reason a provider is not usable: never set up, a rejected key,
 *  or an expired login. Each client adds its own remedy. */
export const NO_PROVIDER_READY = "No model provider is ready"

const authSnapshotPolicy = runtimeCallPolicies.authStatusSnapshot

/** The longest a send waits for the auth view: the deadline of the auth
 *  snapshot read. Past it, that read has failed, so waiting longer cannot
 *  help. The send then goes on, and the runtime's own failure names the
 *  remedy when no provider is set up. */
export const PROVIDER_SETUP_WAIT_MS = authSnapshotPolicy.deadlineMs

/** The provider setup a send is decided by. A known setup answers at once.
 *  While the view is loading, the send waits for `known`, which settles when
 *  the client receives the auth view, for at most `waitMs`. A setup that is
 *  still "loading" then means "send". `known` receives a signal that aborts
 *  when the wait ends, so it can release what it holds. */
export async function settledProviderSetup(
  current: () => ProviderSetup,
  known: (signal: AbortSignal) => Promise<void>,
  waitMs: number = PROVIDER_SETUP_WAIT_MS,
): Promise<ProviderSetup> {
  if (current() !== "loading") return current()
  const done = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const elapsed = new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs) })
  try {
    await Promise.race([known(done.signal), elapsed])
  } finally {
    clearTimeout(timer)
    done.abort()
  }
  return current()
}
