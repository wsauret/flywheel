import { createAccessProviderSelection, type AccessProviderDefinition, type AccessProviderId, type ProviderOptInSettingId, type ProviderSettingValues } from "../../../infra/providers/llm/access/access-provider.js"
import type { SubscriptionUsageReader, SubscriptionUsageResetConsumer } from "../../../infra/providers/llm/usage/subscription-usage.js"
import type { ModuleProviderSetting } from "../../../protocol/runtime/module-protocol-types.js"
import type { FirstPartyModuleComposition } from "../../module-contract/module-catalog.js"
import type { FlywheelConfig } from "../schema/schema.js"
import type { RuntimeConfigOwner } from "../runtime-config-owner.js"
import type { AccessProviderFactory } from "../../agent-runtime/llm/routing/client-factory.js"
import type { ProviderAffordabilityFactory } from "../../agent-runtime/llm/routing/provider-affordability.js"
import type { ProviderAllowanceFactory } from "../../agent-runtime/llm/routing/provider-availability-types.js"

/** The numeric settings each enabled provider declares, keyed by provider id. */
export type ProviderSettingDeclarations = ReadonlyMap<AccessProviderId, readonly ModuleProviderSetting[]>

export interface AccessProviderRegistry {
  readonly selection: ReturnType<typeof createAccessProviderSelection>
  readonly factories: ReadonlyMap<AccessProviderId, AccessProviderFactory>
  readonly usageReaders: ReadonlyMap<AccessProviderId, SubscriptionUsageReader>
  readonly resetConsumers: ReadonlyMap<AccessProviderId, SubscriptionUsageResetConsumer>
  readonly affordability: ReadonlyMap<AccessProviderId, ProviderAffordabilityFactory>
  readonly allowance: ReadonlyMap<AccessProviderId, ProviderAllowanceFactory>
  readonly settings: ProviderSettingDeclarations
  readonly composition: FirstPartyModuleComposition
}

/** The numeric settings modules declare for their providers: a module's
 *  `number` settings belong to the provider the same module contributes. */
function providerSettingDeclarations(composition: FirstPartyModuleComposition): ProviderSettingDeclarations {
  const providerByModule = new Map<string, AccessProviderId>()
  for (const contribution of composition.contributions) {
    if (contribution.domain === "providers") providerByModule.set(contribution.module, contribution.id)
  }
  const declarations = new Map<AccessProviderId, ModuleProviderSetting[]>()
  for (const contribution of composition.contributions) {
    if (contribution.domain !== "settings" || contribution.value.control !== "number") continue
    const providerId = providerByModule.get(contribution.module)
    if (providerId === undefined) throw new Error(`Numeric setting ${contribution.id} belongs to a module that contributes no provider`)
    const declared = declarations.get(providerId) ?? []
    declared.push({ ...contribution.value, providerId })
    declarations.set(providerId, declared)
  }
  return declarations
}

/** One provider's settings for a profile: every declared key, the authored
 *  value where the profile states one, the declared default otherwise. */
export function providerSettingValues(declarations: ProviderSettingDeclarations, providerId: AccessProviderId, authored: { readonly [providerId: string]: { readonly [key: string]: number } | undefined } | undefined): ProviderSettingValues {
  const values: { [key: string]: number } = {}
  for (const setting of declarations.get(providerId) ?? []) values[setting.key] = authored?.[providerId]?.[setting.key] ?? setting.defaultValue
  return values
}

/** One profile's provider opt-in settings (PI-MODEL-096). */
export type ProviderOptIns = { readonly [Setting in ProviderOptInSettingId]: boolean }

/** The opt-in settings that `profile` authors, off where it states none. A hand edit of the configuration file turns
 *  a provider on as Settings does. */
export function profileProviderOptIns(profile: FlywheelConfig["profiles"][string] | undefined): ProviderOptIns {
  return { allowGoogleAntigravity: profile?.allow_google_antigravity ?? false }
}

/** The providers that a profile keeps off: each one whose `profileOptIn` setting the profile has not turned on. */
export function turnedOffProviders(definitions: readonly Pick<AccessProviderDefinition, "id" | "profileOptIn">[], optIns: ProviderOptIns): ReadonlySet<AccessProviderId> {
  return new Set(definitions.flatMap(({ id, profileOptIn }) => profileOptIn === undefined || optIns[profileOptIn.setting] ? [] : [id]))
}

/** The providers that each profile keeps off now, read from the live configuration and module selection. */
export function profileTurnedOffProviders(moduleSelection: () => FirstPartyModuleComposition, runtimeConfig: Pick<RuntimeConfigOwner, "snapshot">): (profileId: string) => ReadonlySet<AccessProviderId> {
  return (profileId) => turnedOffProviders(accessProviderRegistry(moduleSelection()).selection.definitions, profileProviderOptIns(runtimeConfig.snapshot().config.profiles[profileId]))
}

/** Calls `changed` once for each profile whose turned-off providers differ after a change of the profiles config, such
 *  as a person turning Google Antigravity on or off (ARCH-PROVIDERS-088). Returns the unsubscribe. */
export function onProviderOptInChange(runtimeConfig: Pick<RuntimeConfigOwner, "snapshot" | "subscribe">, moduleSelection: () => FirstPartyModuleComposition, changed: (profileId: string) => void): () => Promise<void> {
  // A profile that the file does not author keeps every opt-in provider off, so its key is that of an empty overlay.
  const key = (profiles: FlywheelConfig["profiles"], profileId: string) => [...turnedOffProviders(accessProviderRegistry(moduleSelection()).selection.definitions, profileProviderOptIns(profiles[profileId]))].join("\u0000")
  let previous = runtimeConfig.snapshot().config.profiles
  return runtimeConfig.subscribe("profiles", ({ config }) => {
    const before = previous
    previous = config.profiles
    for (const profileId of new Set([...Object.keys(before), ...Object.keys(config.profiles)])) if (key(before, profileId) !== key(config.profiles, profileId)) changed(profileId)
  })
}

const accessProviderRegistries = new WeakMap<FirstPartyModuleComposition, AccessProviderRegistry>()

/** Binds one enabled module snapshot into the sole provider planning and construction authority. */
export function accessProviderRegistry(composition: FirstPartyModuleComposition): AccessProviderRegistry {
  const cached = accessProviderRegistries.get(composition)
  if (cached) return cached
  const entries = composition.contributions.filter((contribution) => contribution.domain === "providers")
  const definitions: AccessProviderDefinition[] = []
  const factories = new Map<AccessProviderId, AccessProviderFactory>()
  const usageReaders = new Map<AccessProviderId, SubscriptionUsageReader>()
  const resetConsumers = new Map<AccessProviderId, SubscriptionUsageResetConsumer>()
  const affordability = new Map<AccessProviderId, ProviderAffordabilityFactory>()
  const allowance = new Map<AccessProviderId, ProviderAllowanceFactory>()
  for (const entry of entries) {
    const { definition, createClient, usageReader, resetConsumer, affordability: providerAffordability, allowance: providerAllowance } = entry.value
    if (definition.id !== entry.id) throw new Error(`Provider contribution ${entry.id} contains definition ${definition.id}`)
    if (factories.has(definition.id)) throw new Error(`Duplicate provider contribution: ${definition.id}`)
    definitions.push(definition)
    factories.set(definition.id, createClient)
    if (usageReader !== undefined) usageReaders.set(definition.id, usageReader)
    if (resetConsumer !== undefined) resetConsumers.set(definition.id, resetConsumer)
    if (providerAffordability !== undefined) {
      if (affordability.has(definition.id)) throw new Error(`Duplicate provider affordability contribution: ${definition.id}`)
      affordability.set(definition.id, providerAffordability)
    }
    if (providerAllowance !== undefined) allowance.set(definition.id, providerAllowance)
  }
  const registry = { composition, selection: createAccessProviderSelection(definitions), factories, usageReaders, resetConsumers, affordability, allowance, settings: providerSettingDeclarations(composition) }
  accessProviderRegistries.set(composition, registry)
  return registry
}
