import { imageOmittedPlaceholder, splitToolOutputParts } from "../../../../infra/llm/tool-output-part-schema.js";
import { healConversation } from "../heal-messages.js";
import { lowerProviderHistory, type ProviderHistoryTarget } from "../provider-history.js";
import { isSameAccessProviderReplay, isSameProviderReplay } from "../messages.js"
import type { ContentBlock, ConversationMessage } from "../types.js";
import { sanitizeSurrogates } from "../sanitize-unicode.js";
import { deterministicMessageId, ProviderIdConversionError, ProviderIdNormalizer, type CanonicalProviderIds } from "./provider-id.js";

interface OpenAIResponsesConversionOptions extends ProviderHistoryTarget {
  supportsImages?: boolean;
  customToolNames?: ReadonlySet<string>;
}


type OpenAIResponseInputItem =
  | { type?: undefined; role: "system" | "developer" | "user"; content: OpenAIResponseContent[] }
  | { type: "message"; role: "user"; content: OpenAIResponseContent[] }
  | { type: "message"; id?: string; role: "assistant"; content: OpenAIResponseContent[]; status: "completed"; phase?: "commentary" | "final_answer" }
  | { type: "reasoning"; id?: string; summary: Array<{ type: "summary_text"; text: string }>; encrypted_content: string }
  | { type: "function_call"; id?: string; call_id: string; name: string; arguments: string }
  | { type: "custom_tool_call"; id?: string; call_id: string; name: string; input: string }
  | { type: "function_call_output" | "custom_tool_call_output"; call_id: string; output: string | OpenAIResponseContent[] };

interface TextSignatureV1 { v: 1; id: string; phase?: "commentary" | "final_answer" }

// Text signatures are Flywheel-authored (openai.ts encodes item id + phase as
// V1 JSON); a present-but-malformed one is writer drift and throws (ARCH-BOUNDARIES-004).
function parseTextSignature(sig: string | undefined): TextSignatureV1 | null {
  if (!sig) return null;
  const parsed: unknown = JSON.parse(sig);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "v" in parsed &&
    parsed.v === 1 &&
    "id" in parsed &&
    typeof parsed.id === "string"
  ) {
    const phase = "phase" in parsed && (parsed.phase === "commentary" || parsed.phase === "final_answer") ? parsed.phase : undefined;
    return { v: 1, id: parsed.id, ...(phase ? { phase } : {}) };
  }
  throw new Error(`malformed openai text signature: ${sig.slice(0, 80)}`);
}

type OpenAIResponseContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" }
  | { type: "output_text"; text: string; annotations: unknown[] };


function userContentBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function convertOpenAIUserContent(content: string | ContentBlock[], options: OpenAIResponsesConversionOptions): OpenAIResponseContent[] {
  const blocks: OpenAIResponseContent[] = [];
  for (const block of userContentBlocks(content)) {
    if (block.type === "text") {
      blocks.push({ type: "input_text", text: sanitizeSurrogates(block.text) });
    } else if (block.type === "image") {
      if (options.supportsImages) {
        blocks.push({ type: "input_image", image_url: `data:${block.mediaType};base64,${block.data}`, detail: "auto" });
      } else {
        // Non-vision models reject image parts; the placeholder tells the
        // model an image was present (same contract as tool-result images).
        blocks.push({ type: "input_text", text: imageOmittedPlaceholder(block.mediaType) });
      }
    }
  }
  return blocks;
}

type AssistantContentBlock = ContentBlock;

/** Replay builds the item from the fields the Responses API accepts as input, never from the provider's output item.
 *  Output items can carry fields that input rejects: the ChatGPT backend refused an echoed empty reasoning `content`
 *  array. Lowering left reasoning only on this target's own turns
 *  (`lowerProviderHistory`); an item without its encrypted content cannot replay and stays out. */
function convertReasoningBlock(
  block: Extract<AssistantContentBlock, { type: "reasoning" }>,
  replay: boolean,
): OpenAIResponseInputItem | undefined {
  return replay && block.encrypted_content
    ? { type: "reasoning", id: block.id, summary: block.summary ?? [], encrypted_content: block.encrypted_content }
    : undefined;
}

function convertTextBlock(
  block: Extract<AssistantContentBlock, { type: "text" }>,
  replay: boolean,
  fallbackId: string,
): OpenAIResponseInputItem {
  const sigV1 = replay ? parseTextSignature(block.signature) : null;
  // Phase belongs to the message item, where the provider emits it and where
  // replay must put it back. The ChatGPT backend rejects a phase inside a
  // content part with "input.content is not supported".
  return {
    type: "message",
    id: sigV1?.id ?? fallbackId,
    role: "assistant",
    content: [{ type: "output_text", text: sanitizeSurrogates(block.text), annotations: [] }],
    status: "completed",
    ...(sigV1?.phase ? { phase: sigV1.phase } : {}),
  };
}

function convertToolUseBlock(
  block: Extract<AssistantContentBlock, { type: "tool_use" }>,
  ids: CanonicalProviderIds,
  replayNativeIds: boolean,
  isDifferentModel: boolean,
): OpenAIResponseInputItem {
  const itemId = replayNativeIds && isDifferentModel ? undefined : ids.itemId;
  if (ids.wireKind === "custom") {
    const input = typeof block.input.input === "string" ? block.input.input : JSON.stringify(block.input);
    return { type: "custom_tool_call", id: itemId, call_id: ids.callId, name: block.name, input: sanitizeSurrogates(input) };
  }
  return { type: "function_call", id: itemId, call_id: ids.callId, name: block.name, arguments: JSON.stringify(block.input) };
}

function convertOpenAIAssistantBlocks(message: Extract<ConversationMessage, { kind: "assistant" }>, options: OpenAIResponsesConversionOptions, wireIds: ReadonlyMap<string, CanonicalProviderIds>, messageIndex: number): OpenAIResponseInputItem[] {
  const replay = isSameProviderReplay(message, options);
  const replayNativeIds = isSameAccessProviderReplay(message, options);
  const isDifferentModel = message.provider === options.provider
    && message.api === options.api
    && message.model !== options.model;
  const items: OpenAIResponseInputItem[] = [];
  // A reasoning item may only replay when a same-turn item follows it: OpenAI
  // rejects an assistant turn whose final item is a bare reasoning item with a
  // permanent 400, and aborted interleaved turns produce exactly that shape
  // (text or tool_use, then a thinking block the abort cut off). Buffer
  // reasoning items until a follower arrives; trailing orphans stay out, as
  // reasoning never travels as text. Upstream runtime instead drops the whole
  // aborted turn (`transform-messages.ts:193-196`); this keeps the partial.
  let pendingReasoning: OpenAIResponseInputItem[] = [];
  const push = (item: OpenAIResponseInputItem): void => {
    if (item.type === "reasoning") {
      pendingReasoning.push(item);
      return;
    }
    items.push(...pendingReasoning, item);
    pendingReasoning = [];
  };
  for (const block of userContentBlocks(message.content)) {
    if (block.type === "text") {
      push(convertTextBlock(block, replay, deterministicMessageId(`${messageIndex}:${items.length}:${block.text}`)));
    } else if (block.type === "reasoning") {
      const reasoning = convertReasoningBlock(block, replay);
      if (reasoning) push(reasoning);
    } else if (block.type === "tool_use") {
      const ids = wireIds.get(block.id);
      if (!ids) throw new ProviderIdConversionError(`missing provider ID mapping for tool call: ${block.id}`);
      push(convertToolUseBlock(block, ids, replayNativeIds, isDifferentModel));
    }
  }
  return items;
}

function collectWireCallIds(
  history: readonly ConversationMessage[],
  options: OpenAIResponsesConversionOptions,
): Map<string, CanonicalProviderIds> {
  const normalizer = new ProviderIdNormalizer();
  const wireIds = new Map<string, CanonicalProviderIds>();
  const rawProviderCallIds = new Set<string>();
  const canonicalToolIds = new Set<string>();
  for (const message of history) {
    if (message.kind !== "assistant" || typeof message.content === "string") continue;
    const replayNativeIds = isSameAccessProviderReplay(message, options);
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      if (canonicalToolIds.has(block.id)) throw new ProviderIdConversionError(`duplicate canonical tool call ID: ${block.id}`);
      canonicalToolIds.add(block.id);
      const rawCallId = replayNativeIds ? block.providerCallId ?? block.id : block.id;
      if (rawProviderCallIds.has(rawCallId)) throw new ProviderIdConversionError(`duplicate provider call ID: ${rawCallId}`);
      rawProviderCallIds.add(rawCallId);
      const presentedWireKind = options.customToolNames?.has(block.name) ? "custom" : "function";
      wireIds.set(block.id, normalizer.normalize(rawCallId, block.providerItemId, replayNativeIds, presentedWireKind));
    }
  }
  return wireIds;
}

function assertUniqueInputItemIds(input: readonly OpenAIResponseInputItem[]): void {
  const ids = new Set<string>();
  for (const item of input) {
    if (!("id" in item) || typeof item.id !== "string") continue;
    if (ids.has(item.id)) throw new ProviderIdConversionError(`duplicate OpenAI input item ID: ${item.id}`);
    ids.add(item.id);
  }
}

export function toOpenAIResponsesInput(options: OpenAIResponsesConversionOptions, rawHistory: ConversationMessage[]): OpenAIResponseInputItem[] {
  const history = lowerProviderHistory(healConversation(rawHistory), options);
  const wireCallIds = collectWireCallIds(history, options);
  // Instructions travel in the top-level `instructions` request field, never
  // as a system/developer input item; system messages are skipped below.
  const input: OpenAIResponseInputItem[] = [];
  for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
    const message = history[messageIndex];
    if (!message || message.kind === "system") continue;
    if (message.kind === "user" || message.kind === "compactionSummary") {
      const content = convertOpenAIUserContent(message.content, options);
      if (content.length) input.push({ role: "user", content });
      continue;
    }
    if (message.kind === "toolResult") {
      appendOpenAIToolResult(input, message, options, wireCallIds);
      continue;
    }
    input.push(...convertOpenAIAssistantBlocks(message, options, wireCallIds, messageIndex));
  }

  assertUniqueInputItemIds(input);
  return input;
}

function appendOpenAIToolResult(
  input: OpenAIResponseInputItem[],
  message: Extract<ConversationMessage, { kind: "toolResult" }>,
  options: OpenAIResponsesConversionOptions,
  wireCallIds: ReadonlyMap<string, CanonicalProviderIds>,
): void {
  const split = splitToolOutputParts(message.content, options.supportsImages !== false);
  const textChunks = split.text ? [split.text] : [];
  if (split.omittedImagePlaceholders.length > 0) textChunks.push(...split.omittedImagePlaceholders);
  const text = sanitizeSurrogates(textChunks.join("\n"));
  const output: string | OpenAIResponseContent[] = split.images.length > 0
    ? [
        ...(text ? [{ type: "input_text" as const, text }] : []),
        ...split.images.map((part) => ({ type: "input_image" as const, image_url: `data:${part.mediaType};base64,${part.data}`, detail: "auto" as const })),
      ]
    : text || "(no tool output)";
  const ids = wireCallIds.get(message.toolUseId);
  if (!ids) throw new ProviderIdConversionError(`missing provider ID mapping for tool result: ${message.toolUseId}`);
  input.push({ type: ids.wireKind === "custom" ? "custom_tool_call_output" : "function_call_output", call_id: ids.callId, output });
}
