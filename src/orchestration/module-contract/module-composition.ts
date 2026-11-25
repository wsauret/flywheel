import type { CredentialSlotClassifier } from "../../infra/providers/auth/store/auth-store-types.js"
import type { WebProviderDefinition } from "../../infra/providers/auth/web-providers.js"
import { createAccessProviderSelection, type AccessProviderDefinition, type AccessProviderSelection } from "../../infra/providers/llm/access/access-provider.js"
import { customProviderGeneration, customProviderIds } from "../../infra/providers/llm/custom-provider-registry.js"
import type { SubscriptionUsageReader } from "../../infra/providers/llm/usage/subscription-usage.js"
import { composeModules } from "../../infra/definitions/module-descriptor.js"
import type { AuthProviderStatus } from "../../protocol/auth/auth-status-protocol-types.js"
import { EMPTY_MODULE_IDS, MODULE_IDS } from "../../protocol/runtime/module-ids.js"
import type { RetiredServiceInstallation } from "../app-service/account/installation/account-service-platform.js"
import { credentialSlotClassifier, installedCredentialProviderModules, installedCustomProviderModules, installedModules, validateModuleFactPrefixes, type FirstPartyModule, type FirstPartyModuleComposition, type ModuleId } from "./module-catalog.js"

// The compositions of the installed catalog and the credential vocabulary
// they claim. Both read the catalog that the registries publish
// (module-catalog.ts) and never a registry.

/** The composition one realm's selection enables. Same value as
 *  `composeFirstPartyModules` for the selection's disabled set, so two realms
 *  with one selection share one object. */
export function composeRealmModuleSnapshot(
  state: { readonly moduleIds: readonly string[] },
  modules: readonly FirstPartyModule[] = installedModules(),
): FirstPartyModuleComposition {
  const selected = new Set(state.moduleIds)
  const installed = new Set(modules.map((module) => module.id))
  return composeFirstPartyModules(modules, MODULE_IDS.filter((id) => installed.has(id) && !selected.has(id)))
}

/** One composition value per catalog, disabled set, and custom-provider
 *  generation. The value is the identity every derived cache keys on (provider
 *  clients, request surfaces, tool registries), so equal inputs must return the
 *  same frozen object and a changed `[custom_providers]` section must return a
 *  new one. A composition that throws is not held; the next read retries. */
interface CompositionCache {
  readonly generation: number
  readonly byDisabled: Map<string, FirstPartyModuleComposition>
}

const compositions = new WeakMap<readonly FirstPartyModule[], CompositionCache>()

export function composeFirstPartyModules(
  modules: readonly FirstPartyModule[] = installedModules(),
  disabledModuleIds: readonly ModuleId[] = EMPTY_MODULE_IDS,
): FirstPartyModuleComposition {
  const generation = customProviderGeneration()
  let cache = compositions.get(modules)
  if (cache === undefined || cache.generation !== generation) {
    cache = { generation, byDisabled: new Map() }
    compositions.set(modules, cache)
  }
  // A disabled id the vocabulary knows but this catalog does not install (the
  // development module in a release) names nothing to remove, so it never
  // splits the value.
  const installed = new Set(modules.map((module) => module.id))
  const disabled = [...new Set(disabledModuleIds)].filter((id) => installed.has(id)).sort()
  const key = disabled.join("\0")
  const held = cache.byDisabled.get(key)
  if (held !== undefined) return held
  const composition = composeFirstPartyModulesUncached(modules, disabled)
  const composed = Object.freeze({
    enabledModuleIds: Object.freeze([...composition.enabledModuleIds]),
    backgroundWorkProducerIds: Object.freeze([...composition.backgroundWorkProducerIds]),
    installedContributions: Object.freeze([...composition.installedContributions]),
    contributions: Object.freeze([...composition.contributions]),
    observers: Object.freeze([...composition.observers]),
    gates: Object.freeze([...composition.gates]),
    warnings: Object.freeze([...composition.warnings]),
  })
  cache.byDisabled.set(key, composed)
  return composed
}

function composeFirstPartyModulesUncached(
  modules: readonly FirstPartyModule[],
  disabledModuleIds: readonly ModuleId[],
): FirstPartyModuleComposition {
  validateModuleFactPrefixes(modules)
  // Config-declared custom providers join every composition beside the
  // installed catalog. They carry no toggle in `modules`; the
  // config section's presence is their enablement.
  const composition = composeModules([...modules, ...installedCustomProviderModules()], { disabledModuleIds, warnWhenEmpty: ["providers"] })
  credentialSlotClassifier(composition)
  return composition.contributions.some((contribution) => contribution.domain === "tools")
    ? composition
    : { ...composition, warnings: [...composition.warnings, "No tools contributions are enabled"].sort() }
}

export function webAuthProviderDefinitions(composition: FirstPartyModuleComposition): readonly (WebProviderDefinition & Pick<AuthProviderStatus, "group">)[] {
  return composition.contributions
    .filter((contribution) => contribution.domain === "webAuthProviders")
    .map((contribution) => {
      if (contribution.id !== contribution.value.id) throw new Error(`Web auth contribution ${contribution.id} contains definition ${contribution.value.id}`)
      return contribution.value
    })
}

/** Every service registration a module retired, for the account service installer to remove. */
export function retiredServiceInstallations(composition: FirstPartyModuleComposition = composeFirstPartyModules()): readonly RetiredServiceInstallation[] {
  return composition.contributions
    .filter((contribution) => contribution.domain === "accountServices")
    .flatMap((contribution) => contribution.value.retiredInstallation ? [contribution.value.retiredInstallation] : [])
}

interface CredentialVocabulary {
  readonly generation: number
  readonly contributions: FirstPartyModuleComposition["installedContributions"]
  readonly selection: AccessProviderSelection
  readonly classifySlot: CredentialSlotClassifier
}
let vocabulary: CredentialVocabulary | undefined

/** The installed claims with every [custom_providers] entry, which a
 *  composition of the whole catalog also contains. Built per custom-provider
 *  generation, because the custom half exists only after config load and
 *  changes when the section changes. */
function credentialVocabulary(): CredentialVocabulary {
  const generation = customProviderGeneration()
  if (vocabulary?.generation === generation) return vocabulary
  const modules = [...installedCredentialProviderModules(), ...installedCustomProviderModules()]
  const contributions = modules
    .flatMap((module) => module.contributions.map((contribution) => ({ ...contribution, module: module.id })))
    .toSorted((left, right) => left.id.localeCompare(right.id))
  const definitions = contributions.flatMap((contribution) => contribution.domain === "providers" ? [contribution.value.definition] : [])
  vocabulary = { generation, contributions, selection: createAccessProviderSelection(definitions), classifySlot: credentialSlotClassifier({ installedContributions: contributions }) }
  return vocabulary
}

function catalogIds(domain: "providers" | "webAuthProviders"): readonly string[] {
  return installedCredentialProviderModules().flatMap((module) => module.contributions.flatMap((contribution) => contribution.domain === domain ? [contribution.id] : []))
}

/** Credential ids the installed catalog claims, which a [custom_providers]
 *  entry may not take. */
export function catalogCredentialProviderIds(): readonly string[] {
  return [...catalogIds("providers"), ...catalogIds("webAuthProviders")]
}

/** Live credential vocabulary: the installed catalog plus every provider a
 *  [custom_providers] config entry installed. A function, not a constant,
 *  because the custom half exists only after config load. */
export function installedCredentialProviderIds(): readonly string[] {
  return [...catalogCredentialProviderIds(), ...customProviderIds()]
}

/** Live access-provider vocabulary for the availability authority: the
 *  catalog's access ids plus the installed [custom_providers] entries. */
export function installedAccessProviderIds(): readonly string[] {
  return [...catalogIds("providers"), ...customProviderIds()]
}

/** Selection over every installed access-provider definition, also of a module
 *  that is off, and every [custom_providers] entry. A stored credential and an
 *  external login outlive their module's admission, so auth normalization and
 *  the account actions read this complete set. */
export function installedAccessProviderSelection(): AccessProviderSelection {
  return credentialVocabulary().selection
}

export function installedAccessProviderDefinitions(): readonly AccessProviderDefinition[] {
  return installedAccessProviderSelection().definitions
}

/** The usage reader of one installed access provider, also of a module that is off. */
export function installedUsageReader(providerId: string): SubscriptionUsageReader | undefined {
  return credentialVocabulary().contributions.flatMap((contribution) => contribution.domain === "providers" && contribution.id === providerId ? [contribution.value.usageReader] : [])[0]
}

/** Every installed web auth provider, also of a module that is off. */
export function installedWebAuthProviderDefinitions(): readonly (WebProviderDefinition & Pick<AuthProviderStatus, "group">)[] {
  return credentialVocabulary().contributions.flatMap((contribution) => contribution.domain === "webAuthProviders" ? [contribution.value] : [])
}

/** Classifies a retained credential from every installed claim, independent of
 *  provider admission. */
export function installedCredentialSlotClassifier(): CredentialSlotClassifier {
  return credentialVocabulary().classifySlot
}
