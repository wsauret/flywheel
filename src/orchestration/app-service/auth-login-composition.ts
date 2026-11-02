import type { KeyResolver } from "../../infra/auth/resolve-key.js"
import { openExternalUrl } from "../../infra/open-external-url.js"
import type { OperationLogger } from "../../infra/operation-log.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import { providerLoginFlow } from "../auth/auth-actions.js"
import type { ModulePolicy } from "../config/module-policy.js"
import { composeRealmModuleSnapshot } from "../modules.js"
import { createAuthLoginService, type AuthLoginService } from "./auth-login-service.js"
import type { AuthRuntime } from "./auth-runtime.js"

/** Binds client login operations to their admitted composition and owned auth profiles. */
export function composeAuthLogin(options: {
  readonly auth: AuthRuntime
  readonly resolveKey: KeyResolver
  readonly launcher: LauncherScope
  readonly admit: ModulePolicy["admit"]
  readonly log: OperationLogger
}): AuthLoginService {
  const { auth } = options
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
  })
}
