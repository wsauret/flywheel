import { Schema } from "effect";
import { getToolDisplay } from "../../src/infra/tools/tool-display-registry.js";
import { parseConversationTreeFact } from "../../src/orchestration/session/conversation/conversation-facts.js";

const Source = Schema.Struct({ source: Schema.String, sessionId: Schema.optionalKey(Schema.String), type: Schema.String });
const Row = Schema.Struct({
  position: Schema.Int, type: Schema.String, version: Schema.Int, actor: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
});

/** Read root assistant text and tool leading text after the challenge position. Exclude users, thinking, and tool results. */
export function challengeConversationEvidence(jsonl: string, sessionId: string, afterPosition = 0) {
  let position = afterPosition;
  const text: string[] = [];
  try {
    for (const line of jsonl.split("\n").filter(value => value.trim())) {
      const value: unknown = JSON.parse(line);
      const source = Schema.decodeUnknownSync(Source)(value);
      if (source.source !== "store" || source.sessionId !== sessionId || source.type !== "chat.entries.appended") continue;
      const row = Schema.decodeUnknownSync(Row)(value);
      position = Math.max(position, row.position);
      if (row.position <= afterPosition) continue;
      const fact = parseConversationTreeFact({ type: row.type, version: row.version, actor: row.actor, payload: row.payload });
      if (fact.type !== "chat.entries.appended") continue;
      for (const entry of fact.payload.entries) {
        if (entry.kind !== "message" || entry.message.kind !== "assistant") continue;
        if (typeof entry.message.content === "string") {
          text.push(entry.message.content);
          continue;
        }
        for (const block of entry.message.content) {
          if (block.type === "text") text.push(block.text);
          else if (block.type === "tool_use") {
            const leadingText = getToolDisplay(block.name).leadingText?.(block.input);
            if (leadingText) text.push(leadingText);
          }
        }
      }
    }
  } catch {
    throw new Error("subject challenge reply evidence failed validation");
  }
  return { position, text: text.join("\n\n") };
}
