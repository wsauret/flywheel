import type { CatalogSourceRow } from "../../../infra/llm/model-catalog-resolution.js";
import type { CatalogJsonValue } from "../../../infra/llm/catalog-model-offering.js";
import type { ModelPricing, ProviderReasoningEffort } from "../../../infra/llm/models.js";
import { providerModelInfo } from "../../../infra/llm/provider-model-info.js";

// Copilot model eligibility and endpoint dispatch, decided by Copilot's own
// `/models` listing. Each listed model states the wire endpoints it is served
// on (`supported_endpoints`): `claude-*` over Anthropic's `/v1/messages`,
// most OpenAI models over `/responses`, the rest over `/chat/completions`.

type CopilotEndpoint = "anthropic-messages" | "openai-responses" | "chat-completions";

/** Wire endpoints in preference order: the native Anthropic protocol first,
 *  the Responses API next, plain chat completions last. Unknown endpoint
 *  names (websocket variants, embeddings) are ignored. */
const ENDPOINT_PREFERENCE: readonly (readonly [string, CopilotEndpoint])[] = [
  ["/v1/messages", "anthropic-messages"],
  ["/responses", "openai-responses"],
  ["/chat/completions", "chat-completions"],
];

interface UnknownFields {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is UnknownFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogJsonValue(value: unknown): value is CatalogJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(catalogJsonValue);
  return isRecord(value) && Object.values(value).every(catalogJsonValue);
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizePriceTier(raw: unknown): CatalogJsonValue | undefined {
  if (!isRecord(raw)) return undefined;
  const inputPrice = nonNegativeNumber(raw.input_price);
  const cachePrice = nonNegativeNumber(raw.cache_price);
  const outputPrice = nonNegativeNumber(raw.output_price);
  if (inputPrice === undefined || cachePrice === undefined || outputPrice === undefined) return undefined;
  if ("context_max" in raw) {
    const contextMax = positiveNumber(raw.context_max);
    return contextMax === undefined ? undefined : { inputPrice, cachePrice, outputPrice, contextMax };
  }
  return { inputPrice, cachePrice, outputPrice };
}

function normalizeTokenPrices(raw: unknown): CatalogJsonValue | undefined {
  if (!isRecord(raw)) return undefined;
  const batchSize = positiveNumber(raw.batch_size);
  const defaultTier = normalizePriceTier(raw.default);
  if (batchSize === undefined || defaultTier === undefined) return undefined;
  if ("long_context" in raw) {
    const longContext = normalizePriceTier(raw.long_context);
    return longContext === undefined ? undefined : { batchSize, default: defaultTier, longContext };
  }
  return { batchSize, default: defaultTier };
}

/** Normalizes the Copilot model-listing fields used by routing and affordability. */
export function normalizeCopilotCatalogRow(row: unknown): CatalogSourceRow | undefined {
  if (!isRecord(row) || typeof row.id !== "string" || row.id.length === 0) return undefined;
  const endpoints = Array.isArray(row.supported_endpoints)
    ? row.supported_endpoints.filter((endpoint): endpoint is string => ENDPOINT_PREFERENCE.some(([wire]) => endpoint === wire)).slice(0, 16)
    : [];
  if (endpoints.length === 0) return undefined;

  let billing: CatalogJsonValue | undefined;
  if (isRecord(row.billing)) {
    const multiplier = nonNegativeNumber(row.billing.multiplier);
    const tokenPrices = normalizeTokenPrices(row.billing.token_prices);
    if (multiplier !== undefined || tokenPrices !== undefined) {
      billing = {
        ...(multiplier === undefined ? {} : { multiplier }),
        ...(tokenPrices === undefined ? {} : { tokenPrices }),
      };
    }
  }
  const metadata = {
    ...(typeof row.object === "string" ? { object: row.object } : {}),
    supportedEndpoints: endpoints,
    ...(isRecord(row.capabilities) && catalogJsonValue(row.capabilities) ? { capabilities: row.capabilities } : {}),
    ...(billing === undefined ? {} : { billing }),
  } satisfies CatalogJsonValue;
  const transport = ENDPOINT_PREFERENCE.find(([wire]) => endpoints.includes(wire))?.[1];
  if (transport === undefined) return undefined;
  const capabilities = isRecord(row.capabilities) ? row.capabilities : undefined;
  const limits = capabilities !== undefined && isRecord(capabilities.limits) ? capabilities.limits : undefined;
  const supports = capabilities !== undefined && isRecord(capabilities.supports) ? capabilities.supports : undefined;
  const efforts = providerEfforts(supports?.reasoning_effort_levels);
  const contextLimit = positiveInteger(limits?.max_context_window_tokens);
  const outputLimit = positiveInteger(limits?.max_output_tokens);
  const pricing = copilotPricing(billing, row.id);
  return {
    modelId: row.id,
    wireModelId: row.id,
    metadata,
    transport,
    resolvedMetadata: providerModelInfo({
      provider: "github-copilot",
      id: row.id,
      ...(typeof row.name === "string" ? { name: row.name } : {}),
      ...(typeof supports?.reasoning === "boolean" || efforts !== undefined ? { reasoning: supports?.reasoning === true || efforts !== undefined } : {}),
      ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
      ...(typeof supports?.vision === "boolean" ? { attachment: supports.vision } : {}),
      ...(contextLimit === undefined ? {} : { contextLimit }),
      ...(outputLimit === undefined ? {} : { outputLimit }),
      ...(pricing === undefined ? {} : { pricing }),
      ...(typeof supports?.vision === "boolean" ? { modalities: { input: supports.vision ? ["text", "image"] : ["text"], output: ["text"] } } : {}),
    }),
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function providerEfforts(value: unknown): readonly ProviderReasoningEffort[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const efforts = value.filter((item): item is ProviderReasoningEffort =>
    item === "none" || item === "minimal" || item === "low" || item === "medium"
    || item === "high" || item === "xhigh" || item === "max" || item === "ultra");
  return efforts;
}

function copilotPricing(billing: CatalogJsonValue | undefined, model: string): ModelPricing | undefined {
  if (!isRecord(billing) || !isRecord(billing.tokenPrices)) return undefined;
  const tokenPrices = billing.tokenPrices;
  const batchSize = positiveNumber(tokenPrices.batchSize);
  const standard = isRecord(tokenPrices.default) ? tokenPrices.default : undefined;
  if (batchSize === undefined || standard === undefined) return undefined;
  const input = nonNegativeNumber(standard.inputPrice);
  const cacheRead = nonNegativeNumber(standard.cachePrice);
  const output = nonNegativeNumber(standard.outputPrice);
  if (input === undefined || cacheRead === undefined || output === undefined) return undefined;
  const scale = 1_000_000 / batchSize;
  const long = isRecord(tokenPrices.longContext) ? tokenPrices.longContext : undefined;
  const threshold = long === undefined ? undefined : positiveNumber(standard.contextMax);
  const highInput = long === undefined ? undefined : nonNegativeNumber(long.inputPrice);
  const highCache = long === undefined ? undefined : nonNegativeNumber(long.cachePrice);
  const highOutput = long === undefined ? undefined : nonNegativeNumber(long.outputPrice);
  return {
    status: "available",
    rateCard: {
      input: input * scale,
      cacheRead: cacheRead * scale,
      output: output * scale,
      ...(threshold === undefined || highInput === undefined || highCache === undefined || highOutput === undefined ? {} : {
        highContext: {
          threshold,
          input: highInput * scale,
          cacheRead: highCache * scale,
          output: highOutput * scale,
        },
      }),
    },
    provenance: { source: "provider-api", provider: "github-copilot", model },
  };
}
