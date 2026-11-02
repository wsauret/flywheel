import type { ConversationEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types";

/** Entry builders for conversation-tree tests. Timestamps increase per call;
 *  resetTimestamps restarts them so each test sees the same sequence. */
let nowCounter = 0;

export function resetTimestamps(): void {
  nowCounter = 0;
}

export function nextTimestamp(): string {
  nowCounter += 1;
  return new Date(2026, 4, 21, 0, 0, 0, nowCounter).toISOString();
}

export function message(parentId: string | null, id: string, role: "user" | "assistant", text: string, incomplete?: true): ConversationEntry {
  return {
    kind: "message", id, parentId, timestamp: nextTimestamp(),
    message: role === "assistant" && incomplete === true ? { kind: role, content: text, incomplete } : { kind: role, content: text },
  };
}

export function compaction(parentId: string, id: string, sourceLeafId: string, retainedMessages: { kind: "user"; content: string }[] = [], summary = "compressed earlier turns"): ConversationEntry {
  return { kind: "compaction", id, parentId, timestamp: nextTimestamp(), summary, retainedMessages, sourceLeafId, tokensBefore: 999, tokensAfter: 9 };
}

export function systemNotice(parentId: string | null, id: string, text: string): ConversationEntry {
  return { kind: "message", id, parentId, timestamp: nextTimestamp(), message: { kind: "system", content: text } };
}
