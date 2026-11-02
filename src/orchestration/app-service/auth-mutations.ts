import { errorMessage } from "../../infra/error-message.js"
import { startupTrace } from "../../infra/startup-trace.js"
import type { FrontendMutation, MutationResult } from "../../protocol/app-service-types.js"
import type { FlywheelAppServiceDeps } from "./app-service.js"

/** The auth mutations: profile refresh and settlement, protocol logins, account
 *  disconnect and rename, and profile management. Split from the dispatcher
 *  because they share two optional services and one shape of failure, and the
 *  dispatcher reads better as a table of domains than as a wall of branches.
 *  Returns nothing for a mutation that is not an auth mutation. */
export type AuthMutation = Extract<FrontendMutation, { type: `auth.${string}` }>

export function isAuthMutation(mutation: FrontendMutation): mutation is AuthMutation {
  return mutation.type.startsWith("auth.")
}

export async function dispatchAuthMutation(deps: Pick<FlywheelAppServiceDeps, "authProfileSelection" | "authLogin" | "scheduleCatalogRefresh">, mutation: AuthMutation): Promise<MutationResult<FrontendMutation>> {
  if (mutation.type === "auth.catalog.refresh") {
    if (!deps.scheduleCatalogRefresh) return { ok: false, error: "Catalog discovery is unavailable" }
    await deps.scheduleCatalogRefresh(mutation.scope)
    return { ok: true }
  }
  if (mutation.type === "auth.refresh") {
    await deps.authProfileSelection?.settle(mutation.profileId, mutation.operationId)
    startupTrace(`app-service dispatch ${mutation.type} done`)
    return { ok: true }
  }
  // Every client's login, disconnect, and rename runs here, in the runtime
  // that owns the credentials, and reports what the client must show.
  if (mutation.type === "auth.login.cancel") { await deps.authLogin?.cancel(undefined, mutation); return { ok: true } }
  if (mutation.type === "auth.login.decline") { await deps.authLogin?.decline(mutation.providerId, mutation.loginQuestionId); return { ok: true } }
  if (mutation.type === "auth.login.complete") {
    if (!deps.authLogin?.completeBrowserLogin(mutation.operationId, mutation.input)) {
      return { ok: false, error: "This browser login is no longer active." }
    }
    return { ok: true }
  }
  if (mutation.type === "auth.account.disconnect" || mutation.type === "auth.account.rename") {
    if (!deps.authLogin) return { ok: false, error: "This runtime does not manage provider accounts." }
    try {
      if (mutation.type === "auth.account.disconnect") await deps.authLogin.disconnect(mutation)
      else await deps.authLogin.rename(mutation)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }
  if (mutation.type === "auth.login" || mutation.type === "auth.login.answer") {
    if (!deps.authLogin) return { kind: "unsupported", providerId: mutation.providerId, detail: "This runtime cannot connect providers over the protocol." }
    return mutation.type === "auth.login"
      ? await deps.authLogin.login(mutation)
      : await deps.authLogin.answerPrompt(mutation.providerId, mutation.operationId, mutation.answer)
  }
  if (mutation.type === "auth.profile.create" || mutation.type === "auth.profile.select" || mutation.type === "auth.profile.rename" || mutation.type === "auth.profile.delete" || mutation.type === "auth.profile.bind_current_project" || mutation.type === "auth.profile.unbind_current_project") {
    const profiles = deps.authProfileSelection
    if (!profiles) return { ok: false, error: "Auth profile management is unavailable" }
    try {
      if (
        (mutation.type === "auth.profile.create" || mutation.type === "auth.profile.select")
        && mutation.scope.kind !== "session"
      ) {
        await deps.authLogin?.cancel("Authentication stopped because the auth profile changed.")
      }
      const result = await profiles.mutate(mutation)
      startupTrace(`app-service dispatch ${mutation.type} done`)
      return result
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }
  const unhandled: never = mutation
  throw new Error(`Auth mutation has no handler: ${JSON.stringify(unhandled)}`)
}
