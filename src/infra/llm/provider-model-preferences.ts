import type { AccessProviderAccountIdentity, AccessProviderId } from "./access-provider.js";

export interface ProviderModelDeltas {
  readonly enabled: ReadonlySet<string>;
  readonly disabled: ReadonlySet<string>;
}

export interface ProviderModelCatalog {
  readonly catalog: ReadonlySet<string>;
  readonly curatedDefault: ReadonlySet<string>;
}

export interface ResolvedProviderModels extends ProviderModelCatalog, ProviderModelDeltas {
  readonly effective: ReadonlySet<string>;
}

export function transitionProviderAutoEnableNewModels(
  current: ProviderModelDeltas,
  effective: ReadonlySet<string>,
  catalog: ReadonlySet<string>,
  autoEnableNewModels: boolean,
): ProviderModelDeltas {
  const enabled = new Set(current.enabled);
  const disabled = new Set(current.disabled);
  for (const modelId of catalog) {
    enabled.delete(modelId);
    disabled.delete(modelId);
    if (effective.has(modelId)) {
      if (!autoEnableNewModels || current.enabled.has(modelId)) enabled.add(modelId);
    } else {
      disabled.add(modelId);
    }
  }
  return { enabled, disabled };
}

/** Derives provider-wide picker and admission sets from exact account state. */
export function deriveProviderModelPreferences(
  providers: ReadonlyMap<AccessProviderId, ProviderModelCatalog>,
  accounts: Iterable<readonly [AccessProviderAccountIdentity, ResolvedProviderModels]>,
): Map<AccessProviderId, ResolvedProviderModels> {
  const byProvider = new Map<AccessProviderId, ResolvedProviderModels[]>();
  for (const [account, models] of accounts) {
    const entries = byProvider.get(account.providerId) ?? [];
    entries.push(models);
    byProvider.set(account.providerId, entries);
  }
  return new Map([...providers].map(([providerId, provider]) => {
    const exact = byProvider.get(providerId) ?? [];
    return [providerId, {
      ...provider,
      enabled: new Set(exact.flatMap((models) => [...models.enabled])),
      disabled: new Set<string>(),
      effective: new Set(exact.flatMap((models) => [...models.effective])),
    }];
  }));
}

/** Resolves one exact account without allowing another account's delta to affect it. */
export function resolveAccountProviderModelPreferences(
  catalog: ReadonlySet<string>,
  curatedDefault: ReadonlySet<string>,
  preference: ProviderModelDeltas | undefined,
  autoEnableNewModels: boolean,
): ResolvedProviderModels {
  const delta = preference ?? { enabled: new Set<string>(), disabled: new Set<string>() };
  const effective = new Set(autoEnableNewModels ? curatedDefault : []);
  for (const model of delta.enabled) if (catalog.has(model)) effective.add(model);
  for (const model of delta.disabled) effective.delete(model);
  return { catalog, curatedDefault, enabled: delta.enabled, disabled: delta.disabled, effective };
}
