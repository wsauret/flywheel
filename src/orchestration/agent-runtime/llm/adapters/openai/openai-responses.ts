import type { AccessProviderId } from "../../../../../infra/llm/access-provider.js";
import type { ModelInfo } from "../../../../../infra/llm/models.js";
import { buildOpenAIResponseInput, createOpenAITools, resolveOpenAISystemPrompt } from "./openai-adapter-helpers.js";
import { OPENAI_RESPONSES_TOOL_PRESENTATION } from "../../provider-description.js";
import { buildOpenAIParams, openAIWireReasoningEffort } from "./openai-helpers.js";
import { supportsReasoningEffortUpdates } from "../../model-compat.js";
import { immutablePreparedRequest, resolveCacheRetention, type PreparedProviderRequest, type StreamOptions } from "../../types.js";

type OpenAIResponseParams = ReturnType<typeof buildOpenAIParams>;

export type PreparedOpenAIResponsesRequest = PreparedProviderRequest<"openai-responses", OpenAIResponseParams>;

/** Prepares the complete Responses request without constructing a transport client. `messages` holds the input
 *  without the system prompt, which `systemPrompt` holds and the input carries as its first item. */
export function prepareOpenAIResponsesRequest(input: {
  accessProvider: AccessProviderId;
  model: string;
  info: ModelInfo;
  isChatGPT: boolean;
  options: StreamOptions;
}): PreparedOpenAIResponsesRequest {
  const { accessProvider, model, info, isChatGPT } = input;
  const effort = input.options.reasoningEffort ?? "medium";
  const options = { ...input.options, reasoningEffort: effort, cacheRetention: resolveCacheRetention(accessProvider, input.options) };
  const systemPrompt = resolveOpenAISystemPrompt({ messages: options.messages, systemPrompt: options.systemPrompt });
  // Only OpenAI's own routes take an appended effort update; another route that serves the same model runs at the
  // request's effort.
  const takesEffortUpdates = info.reasoning && (accessProvider === "openai_api" || accessProvider === "chatgpt") && supportsReasoningEffortUpdates(model);
  const prepared = buildOpenAIResponseInput({
    systemPrompt,
    messages: options.messages,
    accessProvider,
    model,
    supportsImages: info.modalities.input.includes("image"),
    tools: options.tools,
    ...(takesEffortUpdates ? { effortUpdates: { current: effort, wireEffort: (requested) => openAIWireReasoningEffort(requested, info) } } : {}),
  });
  const tools = createOpenAITools(options.tools, OPENAI_RESPONSES_TOOL_PRESENTATION);
  const params = buildOpenAIParams(
    model,
    prepared.input,
    tools,
    isChatGPT,
    prepared.reasoningEffort ?? effort,
    info,
    options,
    accessProvider,
  );
  return immutablePreparedRequest<PreparedOpenAIResponsesRequest>({
    endpoint: "openai-responses",
    params,
    systemPrompt,
    messages: prepared.history,
    tools: params.tools,
    providerOptions: options.providerOptions,
    cacheRetention: options.cacheRetention,
    tokenClasses: {
      estimatedPromptTokens: options.estimatedContextTokens,
      cacheRetention: options.cacheRetention,
    },
    outputCap: params.max_output_tokens ?? undefined,
  });
}
