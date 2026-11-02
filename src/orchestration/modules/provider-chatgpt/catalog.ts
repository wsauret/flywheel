import { Redacted } from "effect";
import { CHATGPT_BACKEND_API_BASE } from "../../../infra/auth/openai-auth-types.js";
import type { CatalogDiscovery, CatalogJsonValue, ModelCatalogContribution } from "../../../infra/llm/model-catalog-resolution.js";
import { fetchCatalog } from "../../../infra/llm/model-listing.js";
import type { ProviderReasoningEffort } from "../../../infra/llm/models.js";
import { providerModelInfo } from "../../../infra/llm/provider-model-info.js";
import { currentOpenAiStandardPricing, openAiPricingFromMetadata, openAiPricingMetadata, refreshOpenAiStandardPricing } from "../../../infra/llm/openai-pricing.js";

const MODELS_URL = `${CHATGPT_BACKEND_API_BASE}/models`;
const CLIENT_VERSION = "1.0.0";
const MAX_INPUT_MODALITIES = 16;
const MAX_INPUT_MODALITY_LENGTH = 64;

interface ChatGptCatalogRow {
  readonly slug: string;
  readonly display_name?: string;
  readonly context_window?: number;
  readonly max_context_window?: number;
  readonly input_modalities?: readonly string[];
  readonly supported_reasoning_levels?: readonly { readonly effort: ProviderReasoningEffort }[];
  readonly tool_mode?: string;
  readonly standard_pricing?: CatalogJsonValue;
}

interface ChatGptCatalogBoundary {
  readonly [key: string]: unknown;
}

function isChatGptCatalogBoundary(value: unknown): value is ChatGptCatalogBoundary {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractChatGptRows(body: unknown): readonly ChatGptCatalogRow[] {
  if (!isChatGptCatalogBoundary(body) || !Array.isArray(body.models)) throw new TypeError("ChatGPT model list must contain a models array");
  return body.models.map((model) => {
    if (!isChatGptCatalogBoundary(model) || typeof model.slug !== "string" || model.slug.length === 0) throw new TypeError("ChatGPT model rows must have non-empty slugs");
    const modalities = model.input_modalities;
    if (modalities !== undefined && (!Array.isArray(modalities) || modalities.length > MAX_INPUT_MODALITIES
      || modalities.some((modality) => typeof modality !== "string" || modality.length === 0 || modality.length > MAX_INPUT_MODALITY_LENGTH))) {
      throw new TypeError("ChatGPT input modalities exceed the supported bounds");
    }
    const contextWindow = positiveInteger(model.context_window);
    const maxContextWindow = positiveInteger(model.max_context_window);
    const levels = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels.flatMap((level) => {
          if (!isChatGptCatalogBoundary(level)) return [];
          const effort = providerEffort(level.effort);
          return effort === undefined ? [] : [{ effort }];
        })
      : undefined;
    return {
      slug: model.slug,
      ...(typeof model.display_name === "string" && model.display_name.length > 0 ? { display_name: model.display_name } : {}),
      ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
      ...(maxContextWindow === undefined ? {} : { max_context_window: maxContextWindow }),
      ...(modalities === undefined ? {} : { input_modalities: modalities }),
      ...(levels === undefined ? {} : { supported_reasoning_levels: levels }),
      ...(typeof model.tool_mode === "string" && model.tool_mode.length > 0 ? { tool_mode: model.tool_mode } : {}),
    };
  });
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function providerEffort(value: unknown): ProviderReasoningEffort | undefined {
  return value === "none" || value === "minimal" || value === "low" || value === "medium"
    || value === "high" || value === "xhigh" || value === "max" || value === "ultra" ? value : undefined;
}

export const CHATGPT_CATALOG = {
  extractRows: extractChatGptRows,
} as const satisfies Pick<ModelCatalogContribution, "extractRows">;

/** Fetches and classifies the ChatGPT backend model list for one admitted account. */
export async function fetchChatGPTModels(
  accessToken: Redacted.Redacted<string>,
  accountId: string | undefined,
  signal: AbortSignal,
  contribution: Pick<ModelCatalogContribution, "limits" | "extractRows">,
): Promise<CatalogDiscovery> {
  const headers = {
    authorization: `Bearer ${Redacted.value(accessToken)}`,
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
  };
  void refreshOpenAiStandardPricing();
  const discovery = await fetchCatalog(`${MODELS_URL}?client_version=${CLIENT_VERSION}`, headers, contribution, signal);
  const pricing = currentOpenAiStandardPricing();
  if (discovery.kind !== "rows" || pricing.size === 0) return discovery;
  return {
    kind: "rows",
    rows: discovery.rows.map((row) => isChatGptCatalogBoundary(row) && typeof row.slug === "string"
      ? { ...row, ...(openAiPricingMetadata(row.slug, pricing) === undefined ? {} : { standard_pricing: openAiPricingMetadata(row.slug, pricing) }) }
      : row),
  };
}

export function canonicalizeChatGptRow(row: unknown): { modelId: string; wireModelId: string; metadata: CatalogJsonValue; resolvedMetadata: ReturnType<typeof providerModelInfo> } | undefined {
  if (!isChatGptCatalogBoundary(row) || typeof row.slug !== "string" || row.slug.length === 0) return undefined;
  const modalities = Array.isArray(row.input_modalities) && row.input_modalities.every((modality): modality is string => typeof modality === "string") ? row.input_modalities : undefined;
  const efforts = Array.isArray(row.supported_reasoning_levels)
    ? row.supported_reasoning_levels.flatMap((level) => isChatGptCatalogBoundary(level) ? [providerEffort(level.effort)].filter((effort): effort is ProviderReasoningEffort => effort !== undefined) : [])
    : undefined;
  const contextWindow = positiveInteger(row.context_window);
  const maxContextWindow = positiveInteger(row.max_context_window);
  const pricing = openAiPricingFromMetadata(row.standard_pricing, row.slug);
  const metadata = {
    ...(typeof row.display_name === "string" ? { display_name: row.display_name } : {}),
    ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
    ...(maxContextWindow === undefined ? {} : { max_context_window: maxContextWindow }),
    ...(modalities === undefined ? {} : { input_modalities: modalities }),
    ...(efforts === undefined ? {} : { supported_reasoning_levels: efforts }),
    ...(typeof row.tool_mode === "string" ? { tool_mode: row.tool_mode } : {}),
  };
  return {
    modelId: row.slug,
    wireModelId: row.slug,
    metadata,
    resolvedMetadata: providerModelInfo({
      provider: "openai",
      id: row.slug,
      ...(typeof row.display_name === "string" ? { name: row.display_name } : {}),
      ...(efforts === undefined ? {} : { reasoning: efforts.length > 0 }),
      ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
      ...(typeof row.tool_mode === "string" ? { toolCall: true } : {}),
      ...(modalities === undefined ? {} : { attachment: modalities.includes("image") }),
      ...(maxContextWindow === undefined ? {} : { contextLimit: maxContextWindow }),
      ...(pricing === undefined ? {} : { pricing }),
      ...(modalities === undefined ? {} : { modalities: { input: modalities, output: ["text"] } }),
    }),
  }
}
