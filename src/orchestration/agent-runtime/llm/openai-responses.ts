import type { AccessProviderId } from "../../../infra/llm/access-provider.js";
import type { ModelInfo } from "../../../infra/llm/models.js";
import { buildOpenAIResponseInput, createOpenAITools, resolveOpenAISystemPrompt } from "./openai-adapter-helpers.js";
import { OPENAI_RESPONSES_TOOL_PRESENTATION } from "./provider-description.js";
import { buildOpenAIParams } from "./openai-helpers.js";
import { immutablePreparedRequest, resolveCacheRetention, type PreparedProviderRequest, type StreamOptions } from "./types.js";

type OpenAIResponseParams = ReturnType<typeof buildOpenAIParams>;

export type PreparedOpenAIResponsesRequest = PreparedProviderRequest<"openai-responses", OpenAIResponseParams>;

/** Prepares the complete Responses request without constructing a transport client. */
export function prepareOpenAIResponsesRequest(input: {
  accessProvider: AccessProviderId;
  model: string;
  info: ModelInfo;
  isChatGPT: boolean;
  options: StreamOptions;
}): PreparedOpenAIResponsesRequest {
  const { accessProvider, model, info, isChatGPT } = input;
  const options = { ...input.options, cacheRetention: resolveCacheRetention(accessProvider, input.options) };
  const systemPrompt = resolveOpenAISystemPrompt({
    messages: options.messages,
    systemPrompt: options.systemPrompt,
    isChatGPT,
  });
  const messages = buildOpenAIResponseInput({
    messages: options.messages,
    accessProvider,
    model,
    supportsImages: info.modalities.input.includes("image"),
    tools: options.tools,
  });
  const tools = createOpenAITools(options.tools, OPENAI_RESPONSES_TOOL_PRESENTATION);
  const params = buildOpenAIParams(
    model,
    messages,
    systemPrompt,
    tools,
    isChatGPT,
    options.reasoningEffort ?? "medium",
    info,
    options,
    accessProvider,
  );
  return immutablePreparedRequest<PreparedOpenAIResponsesRequest>({
    endpoint: "openai-responses",
    params,
    systemPrompt,
    messages: params.input,
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
