import type {
  ChatCompletionContentPartImage,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions.js";
import type { AccessProviderId } from "../../../infra/llm/access-provider.js";
import { imageOmittedPlaceholder, splitToolOutputParts } from "../../../infra/llm/tool-output-part-schema.js";
import { healConversation } from "./heal-messages.js";
import { lowerProviderHistory, type ProviderHistoryTarget } from "./provider-history.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";
import type { ContentBlock, ConversationMessage, ToolChoice } from "./types.js";

interface UnknownFields { [key: string]: unknown }

export function mapChatCompletionsToolChoice(
  choice: ToolChoice | undefined,
): ChatCompletionCreateParamsStreaming["tool_choice"] | undefined {
  if (!choice) return undefined;
  if (choice === "auto") return "auto";
  if (choice === "any") return "required";
  if (choice === "none") return "none";
  return { type: "function", function: { name: choice.name } };
}

/** Reasoning delta fields the chat-completions adapter captures. A thinking
 *  block whose signature names one of these fields replays on that field. */
export const CHAT_COMPLETIONS_REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

function isReasoningFieldSignature(signature: string | undefined): signature is (typeof CHAT_COMPLETIONS_REASONING_FIELDS)[number] {
  return CHAT_COMPLETIONS_REASONING_FIELDS.some((field) => field === signature);
}

function contentBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

/** Converts canonical history to chat-completions messages for `target`. A model that
 *  declares `interleavedReasoningField` (models.dev `interleaved.field`)
 *  receives that field on every assistant message, empty when the turn
 *  produced no reasoning: DeepSeek thinking mode rejects a tool-call chain in
 *  which one assistant message omits it. Models without the declaration never
 *  receive a reasoning field they did not stream. */
export function toChatCompletionsMessages(
  rawHistory: ConversationMessage[],
  supportsImages: boolean,
  target: ProviderHistoryTarget,
  interleavedReasoningField?: string,
): ChatCompletionMessageParam[] {
  const { accessProvider } = target;
  // Heal inside the converter so every caller gets the pre-send invariant
  // pass, matching the other three provider converters.
  const history = lowerProviderHistory(healConversation(rawHistory), target);
  const requiredReasoningField = isReasoningFieldSignature(interleavedReasoningField) ? interleavedReasoningField : undefined;
  const out: ChatCompletionMessageParam[] = [];
  let index = 0;
  while (index < history.length) {
    const current = history[index];
    if (!current) break;
    if (current.kind === "system") {
      // Transcript-only notice: skipped from the wire, matching the Anthropic
      // and Responses conversions. The system prompt travels separately in
      // options.systemPrompt (openai-completions.ts).
      index += 1;
      continue;
    }
    if (current.kind === "user" || current.kind === "compactionSummary") {
      out.push(convertUserMessage(current.content, supportsImages));
    } else if (current.kind === "toolResult") {
      // Consume the whole run of consecutive tool results, then attach their
      // images as one labeled user message so the contiguous tool-message
      // block stays intact (pi `openai-completions.ts:1195-1263`;
      // providers reject interleaved user messages between tool results).
      index = appendToolResultRun(out, history, index, supportsImages, accessProvider);
      continue;
    } else {
      const assistant = convertAssistantMessage(current, accessProvider, requiredReasoningField);
      if (assistant) out.push(assistant);
    }
    index += 1;
  }
  return out;
}

/** Converts history[start..] tool results until the run ends. Returns the
 *  index of the first message after the run. */
function appendToolResultRun(
  out: ChatCompletionMessageParam[],
  history: ConversationMessage[],
  start: number,
  supportsImages: boolean,
  accessProvider: AccessProviderId,
): number {
  const images: ChatCompletionContentPartImage[] = [];
  let index = start;
  while (index < history.length) {
    const message = history[index];
    if (message?.kind !== "toolResult") break;
    const split = splitToolOutputParts(message.content, supportsImages);
    const text = sanitizeSurrogates([split.text, ...split.omittedImagePlaceholders].filter(Boolean).join("\n"));
    // Some providers reject empty tool content; mirror pi's
    // placeholders (`openai-completions.ts:1210-1212`).
    const content = text.length > 0 ? text : split.images.length > 0 ? "(see attached image)" : "(no tool output)";
    out.push({ role: "tool", tool_call_id: normalizeToolCallId(message.toolUseId, accessProvider), content });
    for (const part of split.images) {
      images.push({ type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.data}` } });
    }
    index += 1;
  }
  if (images.length > 0) {
    out.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...images] });
  }
  return index;
}

function convertUserMessage(
  content: string | ContentBlock[],
  supportsImages: boolean,
): ChatCompletionMessageParam {
  const blocks = contentBlocks(content);
  const onlyText = blocks.every((b) => b.type === "text");
  if (onlyText) {
    return { role: "user", content: sanitizeSurrogates(blocks.map((b) => (b.type === "text" ? b.text : "")).join("")) };
  }
  const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push({ type: "text", text: sanitizeSurrogates(block.text) });
    else if (block.type === "image") {
      // Non-vision models reject image parts; the placeholder tells the model
      // an image was present (same contract as the other converters).
      if (supportsImages) parts.push({ type: "image_url", image_url: { url: `data:${block.mediaType};base64,${block.data}` } });
      else parts.push({ type: "text", text: imageOmittedPlaceholder(block.mediaType) });
    }
  }
  return { role: "user", content: parts };
}

/** Returns undefined for an assistant message with nothing to send: several
 *  providers reject assistant messages that carry neither content nor
 *  tool_calls (aborted turns produce them; pi
 *  `openai-completions.ts:1182-1193`). */
function convertAssistantMessage(
  message: Extract<ConversationMessage, { kind: "assistant" }>,
  accessProvider: AccessProviderId,
  requiredReasoningField: (typeof CHAT_COMPLETIONS_REASONING_FIELDS)[number] | undefined,
): ChatCompletionMessageParam | undefined {
  const textBlocks: string[] = [];
  const toolCalls: NonNullable<Extract<ChatCompletionMessageParam, { role: "assistant" }>["tool_calls"]> = [];
  const reasoningDetails: UnknownFields[] = [];
  const reasoningReplay = new Map<string, string[]>();
  for (const block of contentBlocks(message.content)) {
    if (block.type === "text") textBlocks.push(sanitizeSurrogates(block.text));
    else if (block.type === "thinking" && block.thinking && !block.redacted && isReasoningFieldSignature(block.signature)) {
      // Lowering left thinking only on this target's own turns (`lowerProviderHistory`). Thinking captured on this
      // API carries its reasoning field name as the signature and replays on that field (pi
      // `openai-completions.ts:1120-1127`); any other thinking cannot replay here and stays out.
      const bucket = reasoningReplay.get(block.signature) ?? [];
      bucket.push(sanitizeSurrogates(block.thinking));
      reasoningReplay.set(block.signature, bucket);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: normalizeToolCallId(block.providerCallId ?? block.id, accessProvider),
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
      const detail = parseEncryptedReasoningDetail(block.thoughtSignature);
      if (detail) reasoningDetails.push(detail);
    }
  }
  const text = textBlocks.join("");
  if (!text && toolCalls.length === 0 && reasoningReplay.size === 0) return undefined;
  if (requiredReasoningField && !reasoningReplay.has(requiredReasoningField)) reasoningReplay.set(requiredReasoningField, []);
  return {
    role: "assistant",
    ...(text ? { content: text } : { content: null }),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...Object.fromEntries([...reasoningReplay].map(([field, chunks]) => [field, chunks.join("\n")])),
    // OpenRouter rejects a tool-result continuation for a reasoning turn unless
    // the assistant message replays the encrypted reasoning bound to its tool
    // calls (pi `openai-completions.ts:1161-1173`). The SDK's
    // assistant param does not declare this OpenRouter extension field.
    ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
  };
}

/** Parses a tool_use block's `thoughtSignature` back into the OpenRouter
 *  encrypted-reasoning detail it serialized from. Lowering leaves a signature
 *  only on this target's own turns, and a signature that is no JSON reasoning
 *  detail is skipped, not an error. */
function parseEncryptedReasoningDetail(signature: string | undefined): UnknownFields | undefined {
  if (!signature || !signature.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(signature);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    // SAFETY: narrowed to a non-null, non-array object above; Record is the
    // structural read view of parsed JSON.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: JSON object shape was checked before reading extension fields
    const detail = parsed as UnknownFields;
    return detail.type === "reasoning.encrypted" ? detail : undefined;
  } catch {
    return undefined;
  }
}

function normalizeToolCallId(id: string, accessProvider: AccessProviderId): string {
  return accessProvider === "openai_api" ? id.slice(0, 40) : id;
}

interface ChatCompletionsCacheControl {
  type: "ephemeral";
  ttl?: string;
}

/** Marks the Anthropic prompt-cache breakpoints on a chat-completions request
 *  for anthropic/ models served through OpenRouter: system prompt, last tool,
 *  and last conversation message, mirroring the native Anthropic adapter's
 *  breakpoints. Without the markers no cache is ever created or read.
 *  Adapted from pi `openai-completions.ts:894-996`. */
export function applyAnthropicCacheControl(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[] | undefined,
  cacheControl: ChatCompletionsCacheControl,
): void {
  addCacheControlToSystemPrompt(messages, cacheControl);
  addCacheControlToLastTool(tools, cacheControl);
  addCacheControlToLastConversationMessage(messages, cacheControl);
}

function addCacheControlToSystemPrompt(messages: ChatCompletionMessageParam[], cacheControl: ChatCompletionsCacheControl): void {
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      addCacheControlToTextContent(message, cacheControl);
      return;
    }
  }
}

function addCacheControlToLastConversationMessage(messages: ChatCompletionMessageParam[], cacheControl: ChatCompletionsCacheControl): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") continue;
    if (addCacheControlToTextContent(message, cacheControl)) return;
  }
}

function addCacheControlToLastTool(tools: ChatCompletionTool[] | undefined, cacheControl: ChatCompletionsCacheControl): void {
  const lastTool = tools?.at(-1);
  if (!lastTool) return;
  // SAFETY: cache_control is the Anthropic-via-OpenRouter extension field the
  // SDK's ChatCompletionTool does not declare; the write is the whole point.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: OpenRouter adds cache_control to the SDK tool shape
  (lastTool as ChatCompletionTool & { cache_control?: ChatCompletionsCacheControl }).cache_control = cacheControl;
}

/** Marks the last text part of the message, converting a plain-string content
 *  into a one-part array (the form that carries `cache_control` on the wire).
 *  Returns false when the message has no non-empty text to mark. */
function addCacheControlToTextContent(
  message: ChatCompletionMessageParam,
  cacheControl: ChatCompletionsCacheControl,
): boolean {
  const content = message.content;
  if (typeof content === "string") {
    if (content.length === 0) return false;
    const textPart = { type: "text", text: content, cache_control: cacheControl } as const;
    message.content = [textPart];
    return true;
  }
  if (!Array.isArray(content)) return false;
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (part?.type === "text") {
      // SAFETY: same extension-field write as above.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: OpenRouter adds cache_control to the SDK text part
      (part as { cache_control?: ChatCompletionsCacheControl }).cache_control = cacheControl;
      return true;
    }
  }
  return false;
}
