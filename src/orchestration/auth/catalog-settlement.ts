import { resolveAuthContext, type AuthContext } from "../../infra/auth/auth-context.js"
import type { KeyResolver } from "../../infra/auth/resolve-key.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { AuthCatalogSettlement } from "./auth-actions.js"
import { resolveProviderModelCatalog } from "../config/model-assignment-providers.js"
import { type FirstPartyModuleSnapshot, webAuthProviderDefinitions } from "../modules.js"
import { installedCredentialProviderIds } from "../credential-provider-modules.js"
import { accessProviderAccountKey, credentialIdOf, type AccessProviderAccountIdentity, type AccessProviderDefinition } from "../../infra/llm/access-provider.js"

import { accessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js"
import { credentialSlotClassifier } from "./credential-slot-classifier.js"

export interface CatalogSettlementOptions {
  readonly userDataRoot: string
  readonly resolveKey: KeyResolver
  /** The login command's launch authority, for a provider whose listing runs a local process. */
  readonly launcher?: LauncherScope
  readonly moduleSelection: FirstPartyModuleSnapshot
  readonly signal?: AbortSignal
  readonly resolveAuth?: typeof resolveAuthContext
  readonly resolveCatalog?: typeof resolveProviderModelCatalog
}

/** The credentials of one account and nothing else. A listing contacts every
 *  provider its context names and can refresh an expired OAuth token as it
 *  does, so a login that listed the whole profile would rotate the tokens of
 *  accounts the person did not touch (PI-MODEL-009). */
function accountAuth(auth: AuthContext, definition: AccessProviderDefinition, account: AccessProviderAccountIdentity): AuthContext {
  const credentialId = credentialIdOf(definition)
  const state = auth.providers.get(credentialId)
  const instances = (auth.subscriptionCredentials?.get(account.providerId) ?? [])
    .filter((instance) => account.kind === "subscription" && instance.instanceId === account.instanceId)
  return {
    ...auth,
    providers: new Map(state === undefined ? [] : [[credentialId, state]]),
    subscriptionCredentials: new Map(instances.length === 0 ? [] : [[account.providerId, instances]]),
  }
}

/** Settles the authenticated profile against the configured provider catalog
 *  before a login is reported as a success. Shared by every non-TUI login
 *  entry point (the headless CLI and the editor's login service), so a stored
 *  credential that cannot serve a single model fails the login instead of
 *  surfacing later as an empty picker. The settlement lists only the account
 *  that logged in, and it reads model preferences without writing them,
 *  because a partial listing must never prune the preferences of the
 *  accounts it did not list. */
export function createCatalogSettlement(options: CatalogSettlementOptions): AuthCatalogSettlement {
  return async (account, authDirectory) => {
    const modules = options.moduleSelection()
    if (webAuthProviderDefinitions(modules).some((provider) => provider.id === account.providerId)) return
    const definition = accessProviderRegistry(modules).selection.definitions.find((provider) => provider.id === account.providerId)
    if (!definition) throw new Error(`No enabled model provider exists for ${account.providerId}`)
    const auth = await (options.resolveAuth ?? resolveAuthContext)({ authDir: authDirectory, resolveKey: options.resolveKey, credentialProviderIds: installedCredentialProviderIds(), credentialSlotClassifier: credentialSlotClassifier(modules), definitions: [definition] })
    const resolved = await (options.resolveCatalog ?? resolveProviderModelCatalog)({
      userDataRoot: options.userDataRoot,
      authDirectory: () => authDirectory,
      moduleSelection: options.moduleSelection,
      auth: accountAuth(auth, definition, account),
      signal: options.signal,
      discoveryMode: "fresh",
      preferencePersistence: "read-only",
      ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
    })
    const candidate = resolved.inventoryCandidates.get(accessProviderAccountKey(account))
    if (candidate?.configured !== true
      || !candidate.currentConnection
      || (candidate.outcome?.kind === "unavailable" && candidate.outcome.reason !== "discovery-pending")
      || candidate.inventoryOfferings === null
      || candidate.inventoryOfferings.size === 0) {
      throw new Error(`No usable model catalog is available for ${definition.displayName}`)
    }
  }
}
