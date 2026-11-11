import { authoredCatalogModelId, canonicalCatalogModelId } from "./model-id.js";

/**
 * Custom access-provider registry.
 *
 * Config-declared OpenAI-compatible providers ([custom_providers.<id>] in
 * flywheel.toml) are the one part of the provider catalog that cannot be a
 * static whitelist module: their identities and model vocabularies exist only
 * in user configuration. This registry is the process-local projection of
 * that config section, installed by the config loader after decode so every
 * realm that reads config gets the same projection. The config file remains
 * the single source of truth; this module only mirrors it for the pure
 * readers (family detection, model info, listing, auth vocabulary) that
 * cannot take a config parameter.
 *
 * Replace semantics: each install overwrites the previous projection. Live
 * consumers cache compositions built from an earlier projection, so a config
 * edit to this section takes full effect on the next start.
 */

export interface CustomProviderDefinition {
  /** Access-provider and credential-store identity, unique across the catalog. */
  readonly id: string;
  readonly displayName: string;
  /** OpenAI-compatible chat-completions base URL, e.g. "http://localhost:8080/v1". */
  readonly baseUrl: string;
  /** The complete model vocabulary this provider serves, as the declared wire spellings. */
  readonly modelIds: ReadonlySet<string>;
  /** models.dev provider key whose entries carry this endpoint's limits and
   *  API-equivalent pricing. Absent: inferred from `id` when a models.dev
   *  key matches, else declared models price at zero. */
  readonly catalogId: string | undefined;
  /** Context window applied to every declared model absent a catalog entry. */
  readonly contextLimit: number;
}

/** The installed definition that declares `modelId`, or undefined. */
export function customProviderOwning(modelId: string): CustomProviderDefinition | undefined {
  const canonical = canonicalCatalogModelId(modelId).modelId;
  for (const definition of installed.values()) {
    if ([...definition.modelIds].some((candidate) => authoredCatalogModelId(candidate).modelId === canonical)) return definition;
  }
  return undefined;
}

/** A [custom_providers] entry the loader refused, kept so auth surfaces can
 *  show the user what is wrong instead of silently hiding the provider. */
export interface CustomProviderRejection {
  readonly id: string;
  readonly reason: string;
}

export interface CustomProviderSlice {
  readonly definitions: readonly CustomProviderDefinition[];
  readonly rejections: readonly CustomProviderRejection[];
}

let installed: ReadonlyMap<string, CustomProviderDefinition> = new Map();
let rejected: readonly CustomProviderRejection[] = [];
let generation = 0;
let fingerprint = "";
const retirementListeners = new Set<(generation: number) => void>();

function projectionFingerprint(definitions: readonly CustomProviderDefinition[], rejections: readonly CustomProviderRejection[]): string {
  return JSON.stringify([
    definitions.map((definition) => [definition.id, definition.displayName, definition.baseUrl, [...definition.modelIds].sort(), definition.catalogId ?? null, definition.contextLimit]),
    rejections.map((rejection) => [rejection.id, rejection.reason]),
  ]);
}

/** Builds an immutable registry candidate without changing the published slice. */
export function buildCustomProviderSlice(definitions: readonly CustomProviderDefinition[], rejections: readonly CustomProviderRejection[] = []): CustomProviderSlice {
  const next = new Map<string, CustomProviderDefinition>();
  for (const definition of definitions) {
    if (next.has(definition.id)) throw new Error(`Duplicate custom provider id: ${definition.id}`);
    next.set(definition.id, Object.freeze({ ...definition, modelIds: new Set(definition.modelIds) }));
  }
  return Object.freeze({
    definitions: Object.freeze([...next.values()]),
    rejections: Object.freeze(rejections.map((rejection) => Object.freeze({ ...rejection }))),
  });
}

/** Publishes a validated replacement, then retires caches from the prior generation. */
export function publishCustomProviderSlice(candidate: CustomProviderSlice): void {
  const nextFingerprint = projectionFingerprint(candidate.definitions, candidate.rejections);
  if (nextFingerprint === fingerprint) return;
  const previousGeneration = generation;
  installed = new Map(candidate.definitions.map((definition) => [definition.id, definition]));
  rejected = candidate.rejections;
  fingerprint = nextFingerprint;
  generation += 1;
  for (const retire of retirementListeners) retire(previousGeneration);
}

export function installCustomProviders(definitions: readonly CustomProviderDefinition[], rejections: readonly CustomProviderRejection[] = []): void {
  publishCustomProviderSlice(buildCustomProviderSlice(definitions, rejections));
}

/** Registers a runtime cache that must drop runtimes from a replaced provider slice. */
export function subscribeCustomProviderRetirement(retire: (generation: number) => void): () => void {
  retirementListeners.add(retire);
  return () => retirementListeners.delete(retire);
}

/** Monotonic identity of the installed projection. Consumers that cache a
 *  derived structure (the composed module snapshot) include it in their cache
 *  key, so a config reload invalidates exactly when the section changed. */
export function customProviderGeneration(): number {
  return generation;
}

export function customProviderRejections(): readonly CustomProviderRejection[] {
  return rejected;
}

export function customProviders(): readonly CustomProviderDefinition[] {
  return [...installed.values()];
}

export function customProviderIds(): readonly string[] {
  return [...installed.keys()];
}

export function customProviderById(id: string): CustomProviderDefinition | undefined {
  return installed.get(id);
}

/** Whether any installed custom provider declares `modelId`. */
export function isCustomProviderModel(modelId: string): boolean {
  return customProviderOwning(modelId) !== undefined;
}

/** Definition-owned reason `provider` cannot serve `modelId`, or undefined. */
export function customProviderModelUnavailableReason(providerId: string, modelId: string): string | undefined {
  const definition = installed.get(providerId);
  if (!definition) return `Unknown custom provider: ${providerId}`;
  const canonical = canonicalCatalogModelId(modelId).modelId;
  return [...definition.modelIds].some((candidate) => authoredCatalogModelId(candidate).modelId === canonical)
    ? undefined
    : `${definition.displayName} serves only the models declared under [custom_providers.${providerId}] in flywheel.toml, not "${modelId}".`;
}
