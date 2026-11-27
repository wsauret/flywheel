import type { KeyResolver } from "../../../../infra/providers/auth/resolve-key.js"
import { openExternalUrl } from "../../../../infra/substrate/output/notify/open-external-url.js"
import type { OperationLogger } from "../../../../infra/diagnostics/operation-log.js"
import type { LauncherScope } from "../../../../infra/process-supervisor.js"
import { providerLoginFlow } from "../../../auth/auth-actions.js"
import type { ModulePolicy } from "../../../config/policy/module-policy.js"
import { composeRealmModuleSnapshot } from "../../../module-contract/module-composition.js"
import type { FirstPartyModuleComposition } from "../../../module-contract/module-catalog.js"
import { accessProviderRegistry, profileProviderOptIns } from "../../../config/models/access-provider-registry.js"
import type { RuntimeConfigOwner } from "../../../config/runtime-config-owner.js"
import { createAuthLoginService, type AuthLoginService } from "./auth-login-service.js"
import type { AuthRuntime } from "../auth-runtime.js"

/** Binds client login operations to their admitted composition and owned auth profiles. */
export function composeAuthLogin(options: {
  readonly auth: AuthRuntime
  readonly resolveKey: KeyResolver
  readonly launcher: LauncherScope
  readonly admit: ModulePolicy["admit"]
  readonly runtimeConfig: Pick<RuntimeConfigOwner, "snapshot" | "subscribe" | "mutateProfileBoolean">
  readonly moduleSelection: () => FirstPartyModuleComposition
  readonly log: OperationLogger
}): AuthLoginService {
  const { auth, runtimeConfig } = options
  return createAuthLoginService({
    resolveKey: options.resolveKey,
    launcher: options.launcher,
    openBrowser: (url) => openExternalUrl(options.launcher, url),
    admit: options.admit,
    log: options.log,
    resolveProfile: (profileId) => profileId === undefined ? auth.activeProfile() : auth.resolveOwnedProfile(profileId),
    resolveLoginProfile: auth.resolveLoginProfile,
    refresh: (profileId) => auth.refresh(profileId),
    publishNotice: (notice, target) => target.question
      ? auth.publishLoginNotice(notice)
      : auth.publishProfileNotice(target.profileId, notice),
    settleCatalog: (grant) => {
      const composition = composeRealmModuleSnapshot(grant)
      return (account, directory, signal) => auth.settleCatalog(account, directory, signal, composition)
    },
    providers: async (grant, directory) => {
      const profile = auth.resolveLoginProfile(directory)
      return profile === undefined ? [] : auth.authStatusProjection.view(profile, undefined, composeRealmModuleSnapshot(grant)).providers
    },
    loginFlows: providerLoginFlow,
    optIn: (providerId, profileId) => {
      const optIn = accessProviderRegistry(options.moduleSelection()).selection.definitions.find(({ id }) => id === providerId)?.profileOptIn
      if (optIn === undefined || profileProviderOptIns(runtimeConfig.snapshot().config.profiles[profileId])[optIn.setting]) return undefined
      return {
        warning: optIn.warning,
        turnOn: async () => {
          const result = await runtimeConfig.mutateProfileBoolean(optIn.setting, profileId, false, true)
          if (!result.ok) throw new Error(`The setting was not changed: ${result.error.message}`)
        },
      }
    },
    watchOptIns: (changed) => runtimeConfig.subscribe("profiles", changed),
  })
}
