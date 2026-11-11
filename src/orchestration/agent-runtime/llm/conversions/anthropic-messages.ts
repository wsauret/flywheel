import { imageOmittedPlaceholder } from "../../../../infra/llm/tool-output-part-schema.js";
import { healConversation } from "../heal-messages.js";
import { lowerProviderHistory, type ProviderHistoryTarget } from "../provider-history.js";
import { ProviderRequestValidationError } from "../errors.js";
import { isSameProviderReplay } from "../messages.js"
import type { ContentBlock, ConversationMessage } from "../types.js";
import type { SystemPromptTiers } from "../system-prompt-tiers.js";
import { sanitizeSurrogates } from "../sanitize-unicode.js";
import { assertNever } from "../../../../infra/assert-never.js";
import { ProviderIdConversionError, ProviderIdNormalizer } from "./provider-id.js";

interface UnknownFields { [key: string]: unknown }

interface AnthropicMessagesConversionOptions extends ProviderHistoryTarget {
  systemPrompt?: SystemPromptTiers;
  supportsImages?: boolean;
  cacheRetention?: "none" | "5m" | "1h";
}

/**
 * Who wrote one wire block, read from the canonical entry that it came from while lowering still knows it
 * (ARCH-PROVIDERS-067): the person (also an entry of unknown origin, which no transport may rewrite), other runtime
 * input, an environment or date reminder, the Claude model reminder, another route's model reminder, the shared host's framing, a tool notice,
 * the request-only text, a tool result, or the assistant.
 */
export type BlockOrigin =
  | "person" | "system-input" | "runtime-reminder" | "claude-framing" | "model-framing" | "host-framing" | "tool-notice"
  | "request-context" | "tool-result" | "assistant";

/** One origin for each block of a request's messages, aligned by message and block index. */
export type BlockOrigins = readonly (readonly BlockOrigin[])[];

function originOf(message: Exclude<ConversationMessage, { kind: "system" }>): BlockOrigin {
  switch (message.kind) {
    case "assistant": return "assistant";
    case "toolResult": return "tool-result";
    case "compactionSummary": return "system-input";
    case "user": break;
  }
  if (message.requestOnly === true) return "request-context";
  switch (message.framing) {
    case "reminder": return "runtime-reminder";
    case "claude": return "claude-framing";
    case "model": return "model-framing";
    case "agent-host": return "host-framing";
    case "tool-notice": return "tool-notice";
    case undefined: return message.origin === "system" ? "system-input" : "person";
  }
}

interface AnthropicMessagesRequest {
  system?: AnthropicBlock[];
  messages: AnthropicMessage[];
  /** The origin of each block of `messages`. */
  origins: BlockOrigin[][];
  /** Each canonical tool call id and the id that the request sends for it. */
  wireIds: ReadonlyMap<string, string>;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

type AnthropicToolResultBlock = Array<
  | { type: "text"; text: string; cache_control?: AnthropicCacheControl }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: AnthropicCacheControl }
>;

type AnthropicBlock =
  | { type: "text"; text: string; cache_control?: AnthropicCacheControl }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: AnthropicCacheControl }
  | { type: "tool_result"; tool_use_id: string; content: AnthropicToolResultBlock; is_error?: boolean; cache_control?: AnthropicCacheControl }
  | { type: "tool_use"; id: string; name: string; input: UnknownFields; cache_control?: AnthropicCacheControl }
  | { type: "thinking"; thinking: string; signature: string; cache_control?: AnthropicCacheControl }
  | { type: "redacted_thinking"; data: string; cache_control?: AnthropicCacheControl };

type AnthropicCacheControl = { type: "ephemeral"; ttl?: "1h" };

function marker(options: AnthropicMessagesConversionOptions): AnthropicCacheControl {
  return options.cacheRetention === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

function contentBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function convertAnthropicUserContent(content: string | ContentBlock[], options: AnthropicMessagesConversionOptions): AnthropicBlock[] {
  const supportsImages = options.supportsImages !== false;
  const blocks: AnthropicBlock[] = [];
  for (const block of contentBlocks(content)) {
    if (block.type === "text") {
      const text = sanitizeSurrogates(block.text);
      if (text.trim()) blocks.push({ type: "text", text });
    }
    if (block.type === "image") {
      // Non-vision models reject image parts; the placeholder tells the model
      // an image was present (same contract as the other converters).
      if (supportsImages) blocks.push({ type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } });
      else blocks.push({ type: "text", text: imageOmittedPlaceholder(block.mediaType) });
    }
  }
  return blocks;
}

function convertAnthropicAssistantContent(
  message: Extract<ConversationMessage, { kind: "assistant" }>,
  options: AnthropicMessagesConversionOptions,
  wireIds: ReadonlyMap<string, string>,
): AnthropicBlock[] {
  const replay = isSameProviderReplay(message, options);
  const content: AnthropicBlock[] = [];
  for (const block of contentBlocks(message.content)) {
    if (block.type === "text") {
      const text = sanitizeSurrogates(block.text);
      if (text.trim()) content.push({ type: "text", text });
    }
    // Lowering left deliberation only on this target's own turns (`lowerProviderHistory`). A thinking block replays
    // only with its signature: a redacted block keeps a display placeholder as its text and the provider's opaque data
    // as its signature (anthropic.ts). A block without one cannot replay and stays out.
    if (block.type === "thinking" && replay && block.signature) {
      content.push(block.redacted
        ? { type: "redacted_thinking", data: block.signature }
        : { type: "thinking", thinking: sanitizeSurrogates(block.thinking), signature: block.signature });
    }
    if (block.type === "tool_use") {
      const id = wireIds.get(block.id);
      if (!id) throw new ProviderIdConversionError(`missing provider ID mapping for tool call: ${block.id}`);
      content.push({ type: "tool_use", id, name: block.name, input: block.input });
    }
  }
  return content;
}

/** The wire blocks of one tool result, each with the index of the canonical part that it carries. A text part that is
 *  only whitespace sends no block, and an image becomes a text placeholder for a model without image input. The
 *  converter and the content-refusal locator both read this one rule, so a wire part index always maps back to the
 *  canonical part that it came from. */
export function anthropicToolResultParts(
  message: Extract<ConversationMessage, { kind: "toolResult" }>,
  supportsImages: boolean,
): { partIndex: number; block: AnthropicToolResultBlock[number] }[] {
  return message.content.flatMap((part, partIndex): { partIndex: number; block: AnthropicToolResultBlock[number] }[] => {
    switch (part.type) {
      case "text": {
        const text = sanitizeSurrogates(part.text);
        return text.trim() ? [{ partIndex, block: { type: "text", text } }] : [];
      }
      case "image":
        return [{ partIndex, block: supportsImages
          ? { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } }
          : { type: "text", text: imageOmittedPlaceholder(part.mediaType) } }];
      default:
        return assertNever(part);
    }
  });
}

function convertAnthropicToolResult(
  message: Extract<ConversationMessage, { kind: "toolResult" }>,
  options: AnthropicMessagesConversionOptions,
  wireIds: ReadonlyMap<string, string>,
): AnthropicBlock {
  const toolUseId = wireIds.get(message.toolUseId);
  if (!toolUseId) throw new ProviderIdConversionError(`missing provider ID mapping for tool result: ${message.toolUseId}`);
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: anthropicToolResultParts(message, options.supportsImages !== false).map(({ block }) => block),
    ...(message.isError ? { is_error: true } : {}),
  };
}

export function toAnthropicMessagesRequest(options: AnthropicMessagesConversionOptions, rawHistory: ConversationMessage[]): AnthropicMessagesRequest {
  const history = lowerProviderHistory(healConversation(rawHistory), options);
  const wireIds = collectAnthropicWireIds(history, options);
  const { messages, origins } = projectAnthropicMessages(options, history, wireIds);
  const cachingDisabled = options.cacheRetention === "none";
  const finalMessages = cachingDisabled ? messages : withCacheControl(messages, options);
  assertAnthropicToolProtocol(finalMessages);
  const system = convertSystemPrompt(options, cachingDisabled);
  return {
    ...(system.length > 0 ? { system } : {}),
    messages: finalMessages,
    origins,
    wireIds,
  };
}

/** One text block per non-empty prompt tier. With caching on, the stable and
 *  the session block each end a cache breakpoint, so every session of a project
 *  reads the stable tier from cache and every conversation of a session also
 *  reads the session tier. The conversation block has no breakpoint of its own:
 *  the breakpoint on the last user message covers it. Together with the last
 *  tool and the last user message this uses all four Anthropic breakpoints. */
function convertSystemPrompt(options: AnthropicMessagesConversionOptions, cachingDisabled: boolean): AnthropicBlock[] {
  if (!options.systemPrompt) return [];
  const { stable, session, conversation } = options.systemPrompt;
  const marked = !cachingDisabled;
  return ([[stable, marked], [session, marked], [conversation, false]] as const)
    .filter(([tier]) => tier.length > 0)
    .map(([tier, breakpoint]) => {
      const text = sanitizeSurrogates(tier);
      return breakpoint ? { type: "text", text, cache_control: marker(options) } : { type: "text", text };
    });
}

function collectAnthropicWireIds(
  history: readonly ConversationMessage[],
  options: AnthropicMessagesConversionOptions,
): Map<string, string> {
  const normalizer = new ProviderIdNormalizer();
  const wireIds = new Map<string, string>();
  for (const message of history) {
    if (message.kind !== "assistant" || typeof message.content === "string") continue;
    const native = isSameProviderReplay(message, options);
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      if (wireIds.has(block.id)) throw new ProviderIdConversionError(`duplicate canonical tool call ID: ${block.id}`);
      wireIds.set(block.id, normalizer.normalize(block.id, undefined, native).callId);
    }
  }
  return wireIds;
}

/** Every run of consecutive user messages travels as one wire user message,
 *  with its blocks joined in canonical order and no text added. The Claude engine
 *  sends user input this way, so every Anthropic path, native and Agent SDK,
 *  shows the model the same message boundary. A message that converts to no
 *  blocks leaves the run unbroken. Each block's origin is the origin of its entry (`BlockOrigin`). */
function projectAnthropicMessages(
  options: AnthropicMessagesConversionOptions,
  history: readonly ConversationMessage[],
  wireIds: ReadonlyMap<string, string>,
): Pick<AnthropicMessagesRequest, "messages" | "origins"> {
  const messages: AnthropicMessage[] = [];
  const origins: BlockOrigin[][] = [];
  for (const message of history) {
    if (message.kind === "system") continue;
    const converted = message.kind === "toolResult"
      ? { role: "user" as const, content: [convertAnthropicToolResult(message, options, wireIds)] }
      : convertAnthropicMessage(message, options, wireIds);
    if (!converted) continue;
    const blockOrigins = converted.content.map(() => originOf(message));
    const previous = messages.at(-1);
    if (converted.role === "user" && previous?.role === "user") {
      previous.content.push(...converted.content);
      origins.at(-1)?.push(...blockOrigins);
    } else {
      messages.push(converted);
      origins.push(blockOrigins);
    }
  }
  return { messages, origins };
}

function convertAnthropicMessage(
  message: Extract<ConversationMessage, { kind: "user" | "assistant" | "compactionSummary" }>,
  options: AnthropicMessagesConversionOptions,
  wireIds: ReadonlyMap<string, string>,
): AnthropicMessage | undefined {
  if (message.kind !== "assistant") {
    const content = convertAnthropicUserContent(message.content, options);
    return content.length > 0 ? { role: "user", content } : undefined;
  }
  const content = convertAnthropicAssistantContent(message, options, wireIds);
  return content.length > 0 ? { role: "assistant", content } : undefined;
}

function withCacheControl(messages: AnthropicMessage[], options: AnthropicMessagesConversionOptions): AnthropicMessage[] {
  // pi `anthropic.ts:1135-1156`: mark cache_control on the
  // last user message only. With tools-last and the two system tiers that is
  // the 4th of Anthropic's 4 cache breakpoints; none is spare. Marking both
  // trailing user messages used all 4 but paid 2× cache_creation_input_tokens
  // per turn (every turn the previous rolling anchor gets re-written).
  let lastUserIndex = -1;
  let target: AnthropicMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "user") { lastUserIndex = i; target = message; break; }
  }
  if (!target) return messages;
  const cacheControl = marker(options);
  const lastBlockIndex = target.content.length - 1;
  const markedContent = target.content.map((block, j) =>
    j === lastBlockIndex ? { ...block, cache_control: cacheControl } : block
  );
  return messages.map((message, i) => i === lastUserIndex ? { ...message, content: markedContent } : message);
}

function assertAnthropicToolProtocol(messages: readonly AnthropicMessage[]): void {
  let pending: { assistantIndex: number; toolUseIds: ReadonlySet<string> } | null = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    const toolUseIds = message.content.filter((block) => block.type === "tool_use").map((block) => block.id);
    const toolResultIds = message.content.filter((block) => block.type === "tool_result").map((block) => block.tool_use_id);

    if (message.role === "assistant") {
      if (pending) {
        throw protocolError(`assistant message ${pending.assistantIndex} has tool_use blocks without an immediate user tool_result message`);
      }
      assertNoDuplicateIds("assistant", index, "tool_use", toolUseIds);
      if (toolUseIds.length > 0) pending = { assistantIndex: index, toolUseIds: new Set(toolUseIds) };
      continue;
    }

    if (toolUseIds.length > 0) {
      throw protocolError(`user message ${index} contains tool_use blocks`);
    }

    if (!pending) {
      if (toolResultIds.length > 0) {
        throw protocolError(`user message ${index} contains tool_result blocks without a preceding assistant tool_use message`);
      }
      continue;
    }

    if (toolResultIds.length === 0) {
      throw protocolError(`assistant message ${pending.assistantIndex} tool_use blocks are followed by user message ${index} without tool_result blocks`);
    }
    // Anthropic accepts user content after the tool results, never before them.
    if (message.content.slice(0, toolResultIds.length).some((block) => block.type !== "tool_result")) {
      throw protocolError(`user message ${index} places other content before its tool_result blocks after assistant message ${pending.assistantIndex}`);
    }
    assertNoDuplicateIds("user", index, "tool_result", toolResultIds);
    assertMatchingToolResults(index, pending.assistantIndex, pending.toolUseIds, toolResultIds);
    pending = null;
  }

  if (pending) {
    throw protocolError(`assistant message ${pending.assistantIndex} ends the request with unresolved tool_use blocks`);
  }
}

function assertNoDuplicateIds(role: string, messageIndex: number, blockType: string, ids: readonly string[]): void {
  if (new Set(ids).size === ids.length) return;
  throw protocolError(`${role} message ${messageIndex} contains duplicate ${blockType} ids`);
}

function assertMatchingToolResults(
  userIndex: number,
  assistantIndex: number,
  expectedIds: ReadonlySet<string>,
  actualIds: readonly string[],
): void {
  const actual = new Set(actualIds);
  const missing = [...expectedIds].filter((id) => !actual.has(id));
  const unexpected = [...actual].filter((id) => !expectedIds.has(id));
  if (missing.length === 0 && unexpected.length === 0) return;
  throw protocolError(
    `user message ${userIndex} tool_result ids do not match assistant message ${assistantIndex} tool_use ids; missing=[${missing.join(",")}], unexpected=[${unexpected.join(",")}]`,
  );
}

function protocolError(issue: string): ProviderRequestValidationError {
  return new ProviderRequestValidationError("Anthropic", issue);
}
