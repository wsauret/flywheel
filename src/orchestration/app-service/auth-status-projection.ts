import { credentialProviderDisplayName, getAuthStatusWithDiagnostics, rejectedCustomProviderStatusId } from "../auth/auth-actions.js"
import type { AuthProfileResolution } from "../auth/auth-profile-manager.js"
import { customProviderRejections } from "../../infra/llm/custom-provider-registry.js"
import { accessProviderAccountKey, type AccessProviderCandidate } from "../../infra/llm/access-provider.js"
import type { ProviderModelEligibilityState, ProviderModelInventoryCandidate } from "./provider-model-preference-service.js"
import type { AuthFileAttention, AuthOperationNotice, AuthProviderStatus, RuntimeAuthStatusScope, RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import { webAuthProviderDefinitions, type FirstPartyModuleComposition, type FirstPartyModuleSnapshot } from "../modules.js"
import { installedAccessProviderDefinitions, installedCredentialProviderIds } from "../credential-provider-modules.js"
import { loadAuthStoreWithDiagnostics } from "../../infra/auth/auth-store.js"
import type { SubscriptionSpendConsentView } from "../../protocol/subscription-spend-consent-protocol-types.js"
import { subscriptionSpendAccountCorrelationId } from "../../protocol/subscription-spend-consent-protocol-types.js"
import { createAuthConditionOwner, type AuthConditionOwner } from "../auth/auth-condition-owner.js"
import { accountSecretFile } from "../../infra/paths.js"
import { lockedJsonStorePath } from "../../infra/auth/locked-json-store.js"
import { accessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js"
import { credentialSlotClassifier } from "../auth/credential-slot-classifier.js"

/** Reads the auth view. A reading has no effect beyond the condition owner's
 *  observation; the attention a view shows is stated by the auth attention
 *  publisher when a publication offers it. */
export interface AuthStatusProjection {
  /** Session views read during this projection's lifetime can still hold an auth cursor, even when their runners are inactive. */
  readonly observedSessionIds: ReadonlySet<string>
  /** An admitted operation supplies its captured composition through its notice. */
  snapshot(scope?: RuntimeAuthStatusScope, notice?: AuthOperationNotice, composition?: FirstPartyModuleComposition): Promise<RuntimeAuthView>
  /** The view of one already-resolved profile. It reads the profile's auth
   *  files, so a caller publishing many scopes computes it once per profile. */
  view(profile: AuthProfileResolution, notice?: AuthOperationNotice, composition?: FirstPartyModuleComposition): RuntimeAuthView
  replace(profile: AuthProfileResolution): RuntimeAuthView
}

export interface AuthStatusProjectionDeps {
  readonly initialProfile: AuthProfileResolution
  readonly moduleSelection: FirstPartyModuleSnapshot
  /** Resolves the profile directory for the requested server scope. */
  readonly resolveProfile?: (scope: RuntimeAuthStatusScope, defaults: AuthProfileResolution) => Promise<AuthProfileResolution>
  /** Matches a provider-owned login directory to an existing account profile without acquiring it. */
  readonly resolveLoginProfile?: (authDir: string) => AuthProfileResolution | undefined
  readonly eligibilityState?: (profileId: string) => ProviderModelEligibilityState | undefined
  readonly subscriptionSpendConsent: (profileId: string) => SubscriptionSpendConsentView
  readonly conditions?: AuthConditionOwner
}

export function createAuthStatusProjection(deps: AuthStatusProjectionDeps): AuthStatusProjection {
  let current = deps.initialProfile
  const observedSessionIds = new Set<string>()
  const conditions = deps.conditions ?? createAuthConditionOwner()
  return {
    observedSessionIds,
    async snapshot(scope = { kind: "defaults" }, notice?: AuthOperationNotice, composition?: FirstPartyModuleComposition): Promise<RuntimeAuthView> {
      if (scope.kind === "session") observedSessionIds.add(scope.sessionId)
      return project(await deps.resolveProfile?.(scope, current) ?? current, notice, composition)
    },
    view: project,
    replace(profile) {
      current = profile
      return project(profile)
    },
  }

  function project(profile: AuthProfileResolution, notice?: AuthOperationNotice, composition = deps.moduleSelection()): RuntimeAuthView {
    const registry = accessProviderRegistry(composition)
    const metadata = new Map<string, Pick<AuthProviderStatus, "group" | "loginMethod" | "loginProgram" | "statusRank" | "keyPrefix"> & { readonly displayName?: string }>()
    const servable = new Set<string>()
    for (const definition of registry.selection.definitions) {
      // An external login runs its program's browser flow, which reports the URL it prints and takes a pasted code.
      const loginMethod = definition.auth.kind === "api_key"
        ? "api-key"
        : definition.auth.kind === "external" || definition.auth.flow === "browser" ? "browser-auth" : "device-code"
      const keyPrefix = definition.auth.kind === "api_key" ? definition.auth.keyPrefix?.prefix : undefined
      const loginProgram = definition.auth.kind === "external" ? definition.auth.program : undefined
      metadata.set(definition.id, { group: "model", loginMethod, statusRank: definition.auth.statusRank, ...(loginProgram === undefined ? {} : { loginProgram }), ...(keyPrefix === undefined ? {} : { keyPrefix }) })
      servable.add(definition.id)
    }
    // Keep rejected config entries visible even though they have no module
    // definition. Without a definition they are never a serving candidate.
    for (const rejection of customProviderRejections()) {
      metadata.set(rejectedCustomProviderStatusId(rejection.id), { group: "model", loginMethod: "api-key", statusRank: 50, displayName: `[custom_providers.${rejection.id}] (rejected)` })
    }
    for (const definition of webAuthProviderDefinitions(composition)) {
      metadata.set(definition.id, { group: definition.group, loginMethod: "api-key", statusRank: 0 })
    }
    const credentialSlot = credentialSlotClassifier(composition)
    const load = loadAuthStoreWithDiagnostics(profile.directory, installedCredentialProviderIds(), credentialSlot, false)
    const status = getAuthStatusWithDiagnostics(profile.directory, load)
    conditions.observeLoad(profile.directory, load)
    const currentConditions = conditions.snapshot(profile.directory)
    const eligibility = deps.eligibilityState?.(profile.id)
    const providers: readonly AuthProviderStatus[] = status.providers.flatMap((provider) => {
      const providerMetadata = metadata.get(provider.providerId)
      if (providerMetadata === undefined) return []
      const displayName = providerMetadata.displayName ?? credentialProviderDisplayName(provider.providerId)
      const kind = credentialSlot(provider.providerId) === "subscription" ? "subscription" : providerMetadata.group === "model" ? "singleton" : "connect"
      const singletonCandidate: AccessProviderCandidate | undefined = kind === "singleton" && servable.has(provider.providerId)
        ? { kind: "singleton", providerId: provider.providerId, spendMode: registry.selection.spendMode(provider.providerId) }
        : undefined
      const singletonEligibility = singletonCandidate === undefined ? undefined : eligibility?.inventoryCandidates.get(accessProviderAccountKey(singletonCandidate))
      const singletonFreeRoutes = singletonEligibility === undefined ? undefined : freeRoutesStatus(singletonEligibility, eligibility?.revision)
      const configured = provider.source === "stored_key" || provider.source === "oauth"
      return [{
        providerId: provider.providerId,
        kind,
        source: provider.source,
        expired: provider.expired ?? false,
        configured,
        ...(singletonEligibility === undefined || singletonCandidate === undefined ? {} : {
          catalog: singletonEligibility.catalog,
          servingCandidate: singletonCandidate,
          ...(singletonFreeRoutes === undefined ? {} : { freeRoutes: singletonFreeRoutes }),
        }),
        modelCapable: providerMetadata.group === "model",
        displayName,
        ...providerMetadata,
        accounts: provider.accounts.map((account, index) => {
          const candidate: AccessProviderCandidate = { kind: "subscription", providerId: provider.providerId, instanceId: account.instanceId, spendMode: "included" }
          const candidateEligibility = eligibility?.inventoryCandidates.get(accessProviderAccountKey(candidate))
          const accountFreeRoutes = candidateEligibility === undefined ? undefined : freeRoutesStatus(candidateEligibility, eligibility?.revision)
          return {
            instanceId: account.instanceId,
            accountCorrelationId: subscriptionSpendAccountCorrelationId(profile.id, provider.providerId, account.instanceId),
            identity: account.identity,
            ...(account.label === undefined ? {} : { label: account.label }),
            ...(account.enterpriseDomain === undefined ? {} : { enterpriseDomain: account.enterpriseDomain }),
            displayLabel: account.label || account.identity || account.enterpriseDomain || `${displayName} ${index + 1}`,
            ...(account.plan === undefined ? {} : { plan: account.plan }),
            ...(account.attention !== undefined ? { attention: account.attention }
              : candidateEligibility?.idleFreePlan !== undefined ? { attention: { kind: "free-plan" as const, message: freePlanAttention(displayName) } } : {}),
            expired: account.expired,
            source: account.source,
            configured: true,
            ...(candidateEligibility === undefined ? {} : {
              catalog: candidateEligibility.catalog,
              servingCandidate: candidate,
              ...(accountFreeRoutes === undefined ? {} : { freeRoutes: accountFreeRoutes }),
            }),
          }
        }),
        ...(provider.detail === undefined ? {} : { detail: provider.detail }),
        ...(provider.keyHint === undefined ? {} : { keyHint: provider.keyHint }),
        ...(currentConditions.some((condition) => condition.kind === "malformed" && condition.scope === "provider" && condition.providerId === provider.providerId)
          ? { attention: { kind: "malformed" as const, message: "Stored authentication data is malformed." } }
          : provider.attention === undefined ? {} : { attention: provider.attention }),
      }]
    })
    const fileCondition = currentConditions.find((condition) => condition.scope === "file")
    const fileAttention: AuthFileAttention | undefined = fileCondition === undefined
      ? undefined
      : fileCondition.kind === "malformed"
        ? { kind: "malformed", path: fileCondition.path, message: "The authentication file is malformed." }
        : {
            kind: fileCondition.category,
            path: fileCondition.path,
            message: fileCondition.category === "oversized"
              ? "The authentication file is too large to read."
              : "The authentication file path is unsafe.",
          }
    return {
      loginQuestions: installedAccessProviderDefinitions().flatMap((definition) => definition.auth.kind !== "external" ? [] : definition.auth.loginQuestions().flatMap((question) => {
        if (question.phase !== "asking") return []
        const target = deps.resolveLoginProfile?.(question.authDir) ?? (current.directory === question.authDir ? current : undefined)
        return target === undefined ? [] : [{
          questionId: question.id,
          providerId: definition.id,
          instanceId: question.account.accountId,
          profileId: target.id,
          profileDisplayName: target.displayName,
          providerDisplayName: definition.displayName,
          accountDisplayName: question.account.identity,
        }]
      })),
      autoEnableNewModels: { enabled: eligibility?.autoEnableNewModels ?? true, eligibilityRevision: eligibility?.revision ?? 0 },
      warnings: status.diagnostics.filter((diagnostic) => diagnostic.kind === "unknown_provider").map((diagnostic) => diagnostic.message),
      providers,
      authFilePath: lockedJsonStorePath(accountSecretFile(profile.directory, "auth.json")),
      profile: {
        id: profile.id,
        displayName: profile.displayName,
        source: profile.source,
        availableProfiles: [...profile.availableProfiles].sort((left, right) => left.id.localeCompare(right.id)),
        ...(profile.projectBinding !== undefined ? { projectBinding: profile.projectBinding } : {}),
      },
      subscriptionSpendConsent: deps.subscriptionSpendConsent(profile.id),
      ...(fileAttention === undefined ? {} : { fileAttention }),
      ...(notice === undefined ? {} : notice.kind === "progress" ? { progress: notice } : notice.kind === "confirmation" ? { confirmation: notice } : { settlement: notice }),
    }
  }
}

function freeRoutesStatus(candidate: ProviderModelInventoryCandidate, eligibilityRevision: number | undefined): { readonly enabled: boolean; readonly eligibilityRevision: number } | undefined {
  if (eligibilityRevision === undefined || ![...candidate.inventoryOfferings?.values() ?? []].some((offerings) => offerings.some(({ routeKind }) => routeKind === "free"))) return undefined
  return { enabled: candidate.preferFreeRoutes === true, eligibilityRevision }
}

/** Why a free-plan account beside another account of its provider does not serve, and how the person makes it serve
 *  (PI-MODEL-038). */
function freePlanAttention(providerDisplayName: string): string {
  return `This free-plan account does not serve while the profile holds another ${providerDisplayName} account, because only paid accounts rotate. Disconnect it, or keep it as the only ${providerDisplayName} account.`
}
