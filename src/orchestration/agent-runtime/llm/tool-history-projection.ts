import type { ContentBlock, ConversationMessage } from "./types.js";

type AssistantMessage = Extract<ConversationMessage, { kind: "assistant" }>;
type ToolResultMessage = Extract<ConversationMessage, { kind: "toolResult" }>;
type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

const CONTRACT_CHANGED = "A prior operation used a tool contract that is not available in this request. The incompatible invocation is omitted.";

export interface ToolHistoryProjection {
  readonly loweredToolUseIds: readonly string[];
}

interface ProjectToolHistoryInput {
  readonly messages: readonly ConversationMessage[];
  readonly activeRegistrationIds: ReadonlyMap<string, string>;
  historicalRegistrationId(message: AssistantMessage, block: ToolUseBlock): string | undefined;
}

interface ProjectedToolHistory {
  readonly messages: ConversationMessage[];
  readonly projection: ToolHistoryProjection | undefined;
}

/** Projects exact durable tool history into one request's current tool surface.
 * Incompatible invocations become ordinary conversation context, so no
 * provider can mistake old arguments for a callable current contract. */
export function projectToolHistory(input: ProjectToolHistoryInput): ProjectedToolHistory {
  const loweredIds = new Set<string>();
  for (const message of input.messages) {
    if (message.kind !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const historicalRegistrationId = block.registrationId
        ?? input.historicalRegistrationId(message, block);
      const activeRegistrationId = input.activeRegistrationIds.get(block.name);
      if (historicalRegistrationId === undefined || activeRegistrationId === undefined
        || historicalRegistrationId !== activeRegistrationId) loweredIds.add(block.id);
    }
  }
  if (loweredIds.size === 0) return { messages: [...input.messages], projection: undefined };
  return {
    messages: lowerToolHistoryById(input.messages, [...loweredIds]),
    projection: { loweredToolUseIds: [...loweredIds] },
  };
}

/** Presents historical operations as quoted context, preserving their names, IDs, inputs, and results.
 * No native invocation or result block remains, and the source messages are not changed. */
export function projectToolHistoryAsContext(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const ids = new Set(messages.flatMap((message) => message.kind === "assistant" && Array.isArray(message.content)
    ? message.content.flatMap((block) => block.type === "tool_use" ? [block.id] : []) : []));
  return messages.map((message) => message.kind === "assistant"
    ? lowerAssistantCalls(message, ids, true)
    : message.kind === "toolResult" ? neutralResult(message) : message);
}

/** Replays an audited projection over reconstructed durable history. */
export function lowerToolHistoryById(
  messages: readonly ConversationMessage[],
  loweredToolUseIds: readonly string[],
): ConversationMessage[] {
  const loweredIds = new Set(loweredToolUseIds);
  const output: ConversationMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.kind !== "assistant" || !hasLoweredCall(message, loweredIds)) {
      output.push(message);
      continue;
    }

    output.push(lowerAssistantCalls(message, loweredIds));
    const neutralResults: ToolResultMessage[] = [];
    while (true) {
      const result = messages[index + 1];
      if (result?.kind !== "toolResult") break;
      index += 1;
      if (loweredIds.has(result.toolUseId)) neutralResults.push(result);
      else output.push(result);
    }
    output.push(...neutralResults.map(neutralResult));
  }
  return output;
}

function hasLoweredCall(message: AssistantMessage, loweredIds: ReadonlySet<string>): boolean {
  return Array.isArray(message.content)
    && message.content.some((block) => block.type === "tool_use" && loweredIds.has(block.id));
}

function lowerAssistantCalls(message: AssistantMessage, loweredIds: ReadonlySet<string>, contextOnly = false): AssistantMessage {
  if (!Array.isArray(message.content)) return message;
  const content = message.content.map((block): ContentBlock => block.type === "tool_use" && loweredIds.has(block.id)
    ? { type: "text", text: contextOnly
      ? `Earlier operation (context only, not an executable call):\n${JSON.stringify({ id: block.id, name: block.name, input: block.input })}`
      : `Earlier operation ${block.id}: ${CONTRACT_CHANGED}` }
    : block);
  return { ...message, content };
}

function neutralResult(message: ToolResultMessage): Extract<ConversationMessage, { kind: "user" }> {
  const status = message.interrupted
    ? " The operation was interrupted."
    : message.isError
      ? " The operation failed."
      : "";
  return {
    kind: "user",
    origin: "system",
    content: [{ type: "text", text: `Earlier operation ${message.toolUseId} result:${status}` }, ...message.content],
  };
}
