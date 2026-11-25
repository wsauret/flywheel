import {
  applyProviderExtraBody,
  OPENAI_RESPONSES_RESERVED_BODY_KEYS,
  resolveOpenAIServiceTier,
  type OpenAIReasoningSummary,
  type ProviderRequestOptions,
} from "../../../../../infra/providers/llm/access/provider-options.js";
import { supportsParallelToolCalls } from "../../../../../infra/providers/llm/models/model-compat.js";

export interface UnknownFields { [key: string]: unknown }

function isRecord<Value>(value: Value): value is Value & UnknownFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function openAIReasoningSummary(
  providerOptions: ProviderRequestOptions | undefined,
): Exclude<OpenAIReasoningSummary, "off"> | undefined {
  const summary = providerOptions?.openai?.reasoning_summary ?? "auto";
  return summary === "off" ? undefined : summary;
}


export function applyOpenAIResponsesOptions(
  params: UnknownFields,
  input: {
    model: string;
    hasTools: boolean;
    isChatGPT?: boolean;
    providerOptions: ProviderRequestOptions | undefined;
  },
): void {
  const options = input.providerOptions?.openai;
  // ChatGPT path (ChatGPT backend): send `parallel_tool_calls: true` and
  // `tool_choice: "auto"` on every request, the wire shape that the backend
  // expects. Explicit tool_choice set by the caller (via
  // `StreamOptions.toolChoice` and `buildOpenAIParams`) wins over the default "auto".
  if (input.isChatGPT) {
    if (options?.parallel_tool_calls !== false) params.parallel_tool_calls = true;
    if (input.hasTools && params.tool_choice === undefined) params.tool_choice = "auto";
  } else if (input.hasTools && options?.parallel_tool_calls !== false && supportsParallelToolCalls(input.model)) {
    // OpenAI API path: o-series models (o1, o3, o4-mini) reject
    // `parallel_tool_calls`. gpt-5 + non-reasoning models accept it.
    params.parallel_tool_calls = true;
  }

  // `text.verbosity` defaults to "low" only on the ChatGPT subscription path.
  // On plain OpenAI API path, omit so the API default ("medium") applies
  // unless the user explicitly opts in via `providerOptions.openai.text_verbosity`.
  const verbosity = options?.text_verbosity ?? (input.isChatGPT ? "low" : undefined);
  if (verbosity) {
    params.text = { ...(isRecord(params.text) ? params.text : {}), verbosity };
  }

  const serviceTier = resolveOpenAIServiceTier(input.providerOptions);
  if (serviceTier !== undefined) {
    params.service_tier = serviceTier;
  }

  applyProviderExtraBody(params, options?.extra_body, OPENAI_RESPONSES_RESERVED_BODY_KEYS);
}
