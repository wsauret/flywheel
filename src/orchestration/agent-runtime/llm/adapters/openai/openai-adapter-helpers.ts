import type { ResponseCreateParamsStreaming, ResponseInput } from "openai/resources/responses/responses.js";
import type { AccessProviderId } from "../../../../../infra/llm/access/access-provider.js";
import { toOpenAIResponsesRequestInput, type ReasoningEffortUpdates } from "../../conversions/openai-responses.js";
import type { ReasoningEffort } from "../../../../../infra/llm/models/models.js";
import { sanitizeSurrogates } from "../../history/sanitize-unicode.js";
import { extractSystemPrompt } from "./openai-helpers.js";
import { renderSystemPrompt, type SystemPromptTiers } from "../../system-prompt-tiers.js";
import { OPENAI_RESPONSES_TOOL_PRESENTATION } from "../../provider-description.js";
import type { ConversationMessage, StreamOptions, ToolPresentation } from "../../types.js";
import type { ProviderHistoryTarget } from "../../history/provider-history.js";

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

/** The system prompt of a Responses request. Sanitized like every other outbound string: an unpaired surrogate in
 *  the prompt fails the whole request. */
export function resolveOpenAISystemPrompt(options: {
  messages: ConversationMessage[];
  systemPrompt?: SystemPromptTiers;
}): string {
  return sanitizeSurrogates((options.systemPrompt && renderSystemPrompt(options.systemPrompt)) || extractSystemPrompt(options.messages));
}

/** The replay identity that a Responses adapter stamps on its turns and lowers history for. */
export function openAIResponsesTarget(accessProvider: AccessProviderId, model: string): ProviderHistoryTarget {
  return { accessProvider, provider: "openai", api: "openai-responses", model, sharedHost: false };
}

/** The input of a Responses request, the same input without the system prompt, and the request-level effort. */
interface OpenAIResponseInput {
  readonly input: ResponseInput;
  readonly history: ResponseInput;
  readonly reasoningEffort: ReasoningEffort | undefined;
}

/**
 * The input of a Responses request: the system prompt as the first item, with the developer role (ARCH-PROVIDERS-084),
 * then the history. With `effortUpdates`, a change of effort inside the conversation is an appended configuration
 * update and `reasoningEffort` is the conversation's baseline (ARCH-CONTEXT-041); without it `reasoningEffort` is
 * undefined and the request runs at its own effort. `history` is the input without the system prompt.
 */
export function buildOpenAIResponseInput(options: {
  systemPrompt: string;
  messages: ConversationMessage[];
  accessProvider: AccessProviderId;
  model: string;
  supportsImages: boolean;
  tools: StreamOptions["tools"];
  effortUpdates?: ReasoningEffortUpdates;
}): OpenAIResponseInput {
  const converted = toOpenAIResponsesRequestInput(
    {
      ...openAIResponsesTarget(options.accessProvider, options.model),
      supportsImages: options.supportsImages,
      customToolNames: new Set(options.tools.filter((tool) => tool.wire?.kind === "custom").map((tool) => tool.name)),
    },
    options.messages,
    options.effortUpdates,
  );
  // SAFETY: the converter returns our canonical OpenAIResponseInputItem[] (the hand-built Responses-input union in
  // conversions/openai-responses.ts), which is structurally a wire-compatible subset of the SDK's ResponseInputItem
  // union, except that a `configuration_update` effort is a models.dev wire tier, which can lead the SDK's effort union.
  // The converter is the single producer of these items; the cast crosses our canonical shape into the SDK input type
  // at the one adapter boundary.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: convert the canonical response input union to the SDK wire union
  const history = converted.input as ResponseInput;
  const developer: ResponseInput = options.systemPrompt ? [{ role: "developer", content: [{ type: "input_text", text: options.systemPrompt }] }] : [];
  return { input: [...developer, ...history], history, reasoningEffort: converted.reasoningEffort };
}
