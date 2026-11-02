import type { ConversationMessage, ContentBlock } from "../../agent-runtime/llm/types.js";

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;
type ToolResultMessage = Extract<ConversationMessage, { kind: "toolResult" }>;

function toolUseBlocks(message: ConversationMessage): ToolUseBlock[] {
  return message.kind === "assistant" && Array.isArray(message.content)
    ? message.content.filter((block): block is ToolUseBlock => block.type === "tool_use")
    : [];
}

/** Lower recovered tool history to provider-valid messages without inventing or
 * dropping evidence. It yields once per exchange; one exchange stays native. */
export function* repairToolAdjacencyWork(messages: readonly ConversationMessage[], protectedToolUseIds: ReadonlySet<string> = new Set()): Generator<void, ConversationMessage[]> {
  const lowered: ConversationMessage[] = [];
  let index = 0;
  while (index < messages.length) {
    yield;
    const message = messages[index];
    if (!message) break;

    if (message.kind === "toolResult") {
      const run = collectToolResultRun(messages, index);
      lowered.push(toolHistoryGap("orphan tool results", run.results));
      index = run.nextIndex;
      continue;
    }

    const uses = toolUseBlocks(message);
    if (uses.length === 0) {
      lowered.push(message)
      index += 1
      continue
    }

    const run = collectToolResultRun(messages, index + 1);
    const expectedIds = uses.map((use) => use.id);
    const actualIds = run.results.map((result) => result.toolUseId);
    if (isCompleteUniquePair(expectedIds, actualIds) || isProtectedIncompletePair(expectedIds, actualIds, protectedToolUseIds)) {
      lowered.push(message, ...run.results);
    } else {
      lowered.push(toolHistoryGap("incomplete, duplicate, or mismatched tool exchange", [message, ...run.results]));
    }
    index = run.nextIndex;
  }
  return lowered;
}

function collectToolResultRun(messages: readonly ConversationMessage[], start: number) {
  const results: ToolResultMessage[] = [];
  let nextIndex = start;
  while (nextIndex < messages.length) {
    const message = messages[nextIndex];
    if (!message || message.kind !== "toolResult") break;
    results.push(message);
    nextIndex += 1;
  }
  return { results, nextIndex };
}

function isCompleteUniquePair(expectedIds: readonly string[], actualIds: readonly string[]): boolean {
  if (new Set(expectedIds).size !== expectedIds.length || new Set(actualIds).size !== actualIds.length) return false;
  if (expectedIds.length !== actualIds.length) return false;
  const actual = new Set(actualIds);
  return expectedIds.every((id) => actual.has(id));
}

function isProtectedIncompletePair(expectedIds: readonly string[], actualIds: readonly string[], protectedToolUseIds: ReadonlySet<string>): boolean {
  if (new Set(expectedIds).size !== expectedIds.length || new Set(actualIds).size !== actualIds.length) return false;
  const expected = new Set(expectedIds);
  if (actualIds.some((id) => !expected.has(id))) return false;
  const missing = expectedIds.filter((id) => !actualIds.includes(id));
  return missing.length > 0 && missing.every((id) => protectedToolUseIds.has(id));
}

function toolHistoryGap(reason: string, evidence: readonly ConversationMessage[]): ConversationMessage {
  return {
    kind: "user",
    origin: "system",
    content: `<conversationHistoryGap reason=${JSON.stringify(reason)}>${JSON.stringify(evidence)}</conversationHistoryGap>`,
  };
}
