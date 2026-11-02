import type { CatalogLimits, CatalogSourceRow } from "../../src/infra/llm/model-catalog-resolution.js";

export interface TestCatalogRow {
  readonly id?: string;
  readonly endpoint?: string;
}

export interface MutableModelsDevModel {
  id: string;
  [field: string]: unknown;
}

export interface MutableModelsDevProvider {
  id?: string;
  name: string;
  models: { [modelId: string]: MutableModelsDevModel };
  [field: string]: unknown;
}

export interface MutableModelsDevProviders {
  [providerId: string]: MutableModelsDevProvider;
}

export interface MutableCombinedModelsDevDocument {
  models: { [identity: string]: MutableModelsDevModel };
  providers: MutableModelsDevProviders;
}

export const TEST_CATALOG_LIMITS: CatalogLimits = {
  responseBytes: 2 * 1024 * 1024,
  canonicalRows: 3,
  modelIdLength: 32,
  durableBytes: 4096,
};

export function canonicalTestRow(value: unknown): CatalogSourceRow | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const id = "id" in value ? value.id : undefined;
  const endpoint = "endpoint" in value ? value.endpoint : undefined;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (endpoint !== undefined && typeof endpoint !== "string") return undefined;
  return { modelId: id, wireModelId: id, metadata: endpoint === undefined ? null : { endpoint } };
}

export function modelsDevDocument(modelOverrides: { [field: string]: unknown } = {}): MutableModelsDevProviders {
  const providers = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => {
      const id = index === 0 ? "anthropic" : `provider-${index}`;
      const modelId = index === 0 ? "claude-3-5-sonnet" : `model-${index}`;
      return [id, { name: id, models: { [modelId]: { id: modelId, ...modelOverrides } } }];
    }),
  );
  return providers;
}

export function modelsDevJson(modelOverrides: { [field: string]: unknown } = {}): string {
  return JSON.stringify(modelsDevDocument(modelOverrides));
}

export function combinedModelsDevDocument(modelOverrides: { [field: string]: unknown } = {}): MutableCombinedModelsDevDocument {
  return combinedModelsDevProviders(modelsDevDocument(modelOverrides));
}

export function combinedModelsDevProviders(providers: MutableModelsDevProviders): MutableCombinedModelsDevDocument {
  const models = Object.fromEntries(Object.entries(providers).flatMap(([providerId, provider]) => {
    const rows = provider.models;
    return Object.values(rows).flatMap((row) => {
      const id = `${providerId}/${row.id}`;
      return [[id, { ...row, id }]];
    });
  }));
  return { models, providers };
}

export function combinedModelsDevJson(modelOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify(combinedModelsDevDocument(modelOverrides));
}
