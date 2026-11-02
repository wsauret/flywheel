import { canonicalize } from "../../infra/canonical-name.js";
import { buildCustomProviderSlice, installCustomProviders, publishCustomProviderSlice, type CustomProviderDefinition, type CustomProviderRejection, type CustomProviderSlice } from "../../infra/llm/custom-provider-registry.js";
import { catalogCredentialProviderIds } from "../credential-provider-modules.js";
import { modelIdHasTerminalControl } from "../../infra/llm/model-catalog-resolution.js";
import { Log } from "../../infra/log.js";
import type { FlywheelConfig } from "./schema.js";

/** Lowercase, starts with a letter, at most 32 chars: the id doubles as the
 *  access-provider identity and the auth.json credential key. */
const CUSTOM_PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const log = Log.create({ service: "custom-providers" });

const DEFAULT_CONTEXT_LIMIT = 128_000;

/** A validated custom-provider replacement and its boundary warnings. */
export interface CustomProviderConfigCandidate {
  readonly slice: CustomProviderSlice;
  readonly warnings: readonly string[];
}

/** Validates the decoded external section without changing the live registry. */
export function buildCustomProvidersFromConfig(section: FlywheelConfig["custom_providers"]): CustomProviderConfigCandidate {
  const warnings: string[] = [];
  const definitions: CustomProviderDefinition[] = [];
  const rejections: CustomProviderRejection[] = [];
  const claimedModels = new Map<string, string>();
  const reservedIds = new Set(catalogCredentialProviderIds());
  for (const [id, entry] of Object.entries(section).toSorted(([left], [right]) => left.localeCompare(right))) {
    const reject = (reason: string): void => {
      warnings.push(`WARNING: Ignored [custom_providers.${id}]: ${reason}`);
      rejections.push({ id, reason });
    };
    if (!CUSTOM_PROVIDER_ID_RE.test(id)) {
      reject("provider ids must be lowercase, start with a letter, and use only a-z, 0-9, _ or - (max 32 chars).");
      continue;
    }
    if (reservedIds.has(id)) {
      reject(`"${id}" is a first-party provider id.`);
      continue;
    }
    if (!isHttpUrl(entry.base_url)) {
      reject("base_url must be an http(s) URL.");
      continue;
    }
    const modelIds = new Set<string>();
    let invalidModelId = false;
    for (const model of entry.models) {
      if (modelIdHasTerminalControl(model)) {
        reject("model ids must not contain terminal control characters.");
        invalidModelId = true;
        break;
      }
      const canonical = canonicalize(model);
      const owner = claimedModels.get(canonical);
      if (owner) {
        warnings.push(`WARNING: [custom_providers.${id}] model "${model}" is already declared by [custom_providers.${owner}]; the first declaration wins.`);
        continue;
      }
      claimedModels.set(canonical, id);
      modelIds.add(canonical);
    }
    if (invalidModelId) continue;
    if (modelIds.size === 0) {
      reject("it declares no models. List at least one model id in `models`.");
      continue;
    }
    definitions.push({
      id,
      displayName: entry.display_name ?? id,
      baseUrl: entry.base_url.replace(/\/+$/, ""),
      modelIds,
      catalogId: entry.catalog_id,
      contextLimit: entry.context_limit ?? DEFAULT_CONTEXT_LIMIT,
    });
  }
  return { slice: buildCustomProviderSlice(definitions, rejections), warnings };
}

/** Emit only aggregate, fixed-code diagnostics for authored provider config. */
export function logCustomProviderDiagnostics(candidate: CustomProviderConfigCandidate): void {
  if (candidate.slice.rejections.length > 0) log.warn("custom-provider-config-rejected", { code: "custom-provider-config-rejected", count: candidate.slice.rejections.length });
  const warningCount = candidate.warnings.length - candidate.slice.rejections.length;
  if (warningCount > 0) log.warn("custom-provider-config-warning", { code: "custom-provider-config-warning", count: warningCount });
}

/** Publishes a ready candidate. Registry publication retires prior cache identities. */
export function publishCustomProvidersFromConfig(candidate: CustomProviderConfigCandidate): void {
  publishCustomProviderSlice(candidate.slice);
}

export function installCustomProvidersFromConfig(section: FlywheelConfig["custom_providers"], warnings: string[]): void {
  const candidate = buildCustomProvidersFromConfig(section);
  warnings.push(...candidate.warnings);
  installCustomProviders(candidate.slice.definitions, candidate.slice.rejections);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
