import type { CredentialSlotClassifier } from "../infra/auth/auth-store-types.js"
import type { WebProviderDefinition } from "../infra/auth/web-providers.js"
import { createAccessProviderSelection, type AccessProviderDefinition, type AccessProviderSelection } from "../infra/llm/access-provider.js"
import { customProviderGeneration, customProviderIds } from "../infra/llm/custom-provider-registry.js"
import type { SubscriptionUsageReader } from "../infra/llm/subscription-usage.js"
import type { AuthProviderStatus } from "../protocol/auth-status-protocol-types.js"
import { credentialSlotClassifier } from "./auth/credential-slot-classifier.js"
import { customProviderModules } from "./custom-provider-modules.js"
import { installedCredentialProviderModules, publishShippedCredentialProviders } from "./module-catalog.js"
import type { FirstPartyModule, FirstPartyModuleComposition } from "./modules.js"
import { anthropicApiModule } from "./modules/provider-anthropic-api/module.js"
import { chatgptModule } from "./modules/provider-chatgpt/module.js"
import { claudeAgentSdkModule } from "./modules/provider-claude-agent-sdk/module.js"
import { deepseekModule } from "./modules/provider-deepseek/module.js"
import { githubCopilotModule } from "./modules/provider-github-copilot/module.js"
import { googleApiModule } from "./modules/provider-google-api/module.js"
import { googleVertexModule } from "./modules/provider-google-vertex/module.js"
import { openaiApiModule } from "./modules/provider-openai-api/module.js"
import { opencodeGoModule } from "./modules/provider-opencode-go/module.js"
import { openrouterModule } from "./modules/provider-openrouter/module.js"
import { supergrokModule } from "./modules/provider-supergrok/module.js"
import { webExaModule } from "./modules/web-exa.js"

/** Every shipped module that claims a credential provider id: each access
 *  provider and each web auth provider. The module registry composes this
 *  tuple into the whole catalog. Auth reads this registry alone, so a login
 *  loads the provider definitions and never a tool or another module. */
export const CREDENTIAL_PROVIDER_MODULES = [anthropicApiModule, chatgptModule, claudeAgentSdkModule, deepseekModule, githubCopilotModule, googleApiModule, googleVertexModule, openaiApiModule, opencodeGoModule, openrouterModule, supergrokModule, webExaModule] as const satisfies readonly FirstPartyModule[]
publishShippedCredentialProviders(CREDENTIAL_PROVIDER_MODULES)

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
  const modules = [...installedCredentialProviderModules(), ...customProviderModules()]
  const contributions = modules
    .flatMap((module) => module.contributions.map((contribution) => ({ ...contribution, module: module.id })))
    .toSorted((left, right) => left.id.localeCompare(right.id))
  // A composition admits only an available module's provider definition.
  const available = new Set(modules.filter((module) => module.availability.kind === "available").map((module) => module.id))
  const definitions = contributions.flatMap((contribution) => contribution.domain === "providers" && available.has(contribution.module) ? [contribution.value.definition] : [])
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
