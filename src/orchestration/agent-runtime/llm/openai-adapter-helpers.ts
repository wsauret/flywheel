import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { AccessProviderId } from "../../../infra/llm/access-provider.js";
import { toOpenAIResponsesInput } from "./conversions/openai-responses.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";
import { extractSystemPrompt } from "./openai-helpers.js";
import { renderSystemPrompt, type SystemPromptTiers } from "./system-prompt-tiers.js";
import { OPENAI_RESPONSES_TOOL_PRESENTATION } from "./provider-description.js";
import type { ConversationMessage, StreamOptions, ToolPresentation } from "./types.js";
import type { ProviderHistoryTarget } from "./provider-history.js";

interface ServiceTierTracker {
  setRequested(tier: string | undefined): void;
  setObserved(tier: string | undefined): void;
  multiplier(model: string): number;
}

/** `substituteDefaultTier` is a ChatGPT-backend quirk: it reports
 *  `service_tier: "default"` for requests it billed at the requested tier, so
 *  the requested tier wins there. On the API-key path a "default" response
 *  means OpenAI actually served (and bills) the standard tier - a flex request
 *  that fell back must not be priced at the flex discount. */
export function createServiceTierTracker(substituteDefaultTier = false): ServiceTierTracker {
  let observed: string | undefined;
  let requested: string | undefined;
  return {
    setRequested(tier) {
      requested = tier;
    },
    setObserved(tier) {
      observed = tier;
    },
    multiplier(model) {
      const effective = substituteDefaultTier && observed === "default" && requested ? requested : observed;
      if (effective === "flex") return 0.5;
      // "fast" is OpenAI's rename of priority processing; same pricing.
      if (effective === "priority" || effective === "fast") return model === "gpt-5.5" ? 2.5 : 2; // provider-model-literal-allow: payload -- OpenAI service-tier billing response compatibility
      return 1;
    },
  };
}

export function createOpenAITools(
  tools: StreamOptions["tools"],
  presentation: ToolPresentation = OPENAI_RESPONSES_TOOL_PRESENTATION,
): ResponseCreateParamsStreaming["tools"] {
  return tools.map((tool) => {
    const descriptor = presentation.present(tool);
    return descriptor.kind === "custom"
      ? {
          type: "custom" as const,
          name: tool.name,
          description: descriptor.description,
          format: descriptor.inputFormat,
        }
      : {
          type: "function" as const,
          name: tool.name,
          description: descriptor.description,
          parameters: descriptor.inputFormat,
          strict: false,
        };
  });
}

export function resolveOpenAISystemPrompt(options: {
  messages: ConversationMessage[];
  systemPrompt?: SystemPromptTiers;
  isChatGPT: boolean;
}): string {
  // The ChatGPT/ChatGPT backend 400s on empty `instructions`, so the fallback string
  // is a wire requirement when no prompt is present, not an invented persona; every
  // other backend accepts "" and gets it. Sanitized like every other outbound
  // string: an unpaired surrogate in instructions 400s the whole request
  // (pi `openai-responses-shared.ts:176-179`).
  return sanitizeSurrogates(
    (options.systemPrompt && renderSystemPrompt(options.systemPrompt))
    || extractSystemPrompt(options.messages)
    || (options.isChatGPT ? "You are a helpful assistant." : ""),
  );
}

/** The replay identity that a Responses adapter stamps on its turns and lowers history for. */
export function openAIResponsesTarget(accessProvider: AccessProviderId, model: string): ProviderHistoryTarget {
  return { accessProvider, provider: "openai", api: "openai-responses", model, sharedHost: false };
}

export function buildOpenAIResponseInput(options: {
  messages: ConversationMessage[];
  accessProvider: AccessProviderId;
  model: string;
  supportsImages: boolean;
  tools: StreamOptions["tools"];
}): ResponseCreateParamsStreaming["input"] {
  // SAFETY: toOpenAIResponsesInput returns our canonical OpenAIResponseInputItem[]
  // (the hand-built Responses-input union in conversions/openai-responses.ts), which is
  // structurally a wire-compatible subset of the SDK's ResponseInputItem union. The
  // converter is the single producer of these items; the cast crosses our canonical
  // shape into the SDK input parameter type at the one adapter boundary.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: convert the canonical response input union to the SDK wire union
  return toOpenAIResponsesInput(
    {
      ...openAIResponsesTarget(options.accessProvider, options.model),
      supportsImages: options.supportsImages,
      customToolNames: new Set(options.tools.filter((tool) => tool.wire?.kind === "custom").map((tool) => tool.name)),
    },
    options.messages,
  ) as ResponseCreateParamsStreaming["input"];
}
