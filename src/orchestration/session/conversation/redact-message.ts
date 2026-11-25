import { redactDeep, redactSecrets } from "../../../infra/redact-secrets.js";
import type { LlmToolOutputPart } from "../../../infra/providers/llm/tool-output-part-schema.js";
import type { ContentBlock, ConversationMessage } from "../../../infra/providers/llm/conversation/conversation-message.js";

interface ToolInput {
  [key: string]: unknown;
}

// Single redaction boundary for the canonical conversation funnel. Every
// message that reaches the durable history sink or the provider
// prompt (the messages array) is appended through the agent loop's pushMessage, so masking the
// canonical ConversationMessage here masks tool results, subagent notifications,
// assistant echoes, and injected messages with no per-producer redaction. The append
// boundary is the redaction point (ARCH-BOUNDARIES-010).
//
// Policy (provenance, not message kind, is the discriminator): NEVER redact
// genuinely human-typed chat input - a user who deliberately pastes a secret
// must have it reach the model and the durable tree verbatim. ALWAYS redact
// PRODUCED content: assistant output, tool results, system messages, compaction
// summaries, and SYSTEM-INJECTED user-role messages (subagent/background
// completion notifications, nudges, budget/cutoff prompts). `humanTyped` is true
// only for a user-kind message whose origin is a real human keystroke; every
// other producer leaves it false so the message is masked.
export function redactMessage(message: ConversationMessage, humanTyped: boolean): ConversationMessage {
  switch (message.kind) {
    case "user":
      // The masked branch doubles as the provenance stamp: every system-produced
      // user-role message is marked origin "system" so the durable tree records
      // that it was not a human keystroke (transcript projection hides ordinary plumbing).
      return humanTyped ? message : {
        kind: "user",
        content: redactContent(message.content),
        origin: "system",
        ...(message.backgroundNotificationIds?.length ? { backgroundNotificationIds: message.backgroundNotificationIds } : {}),
        ...(message.replyRequired === true ? { replyRequired: true } : {}),
        ...(message.runtimeNotice === true ? { runtimeNotice: true } : {}),
        ...(message.framing ? { framing: message.framing } : {}),
      };
    case "assistant":
      return { ...message, content: redactContent(message.content) };
    case "system":
      return { kind: "system", content: redactSecrets(message.content), ...(message.contentRepair ? { contentRepair: message.contentRepair } : {}) };
    case "compactionSummary":
      return { kind: "compactionSummary", content: redactSecrets(message.content) };
    case "toolResult":
      return { ...message, content: message.content.map(redactOutputPart) };
  }
}

function redactContent(content: string | ContentBlock[]): string | ContentBlock[] {
  if (typeof content === "string") return redactSecrets(content);
  return content.map(redactBlock);
}

export function redactBlock(block: ContentBlock): ContentBlock {
  switch (block.type) {
    case "text":
      return { ...block, text: redactSecrets(block.text) };
    case "tool_use":
      // Egress boundary for tool-call ARGUMENTS: a secret the model writes into
      // a tool input (e.g. `curl -H 'Authorization: Bearer sk-...'`) reaches the
      // durable tree, the provider prompt, and the recall FTS index. Deep-walk
      // the structured input so secret-bearing string leaves are masked while
      // structure and non-string scalars are preserved. The writer always sets
      // SAFETY: redactDeep preserves object structure, so an object input maps
      // to an object; tool_use.input is internal data the writer types as ToolInput.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: redactDeep returns unknown after recursively preserving the object input shape
      return { ...block, input: redactDeep(block.input) as ToolInput };
    // image data is binary. thinking/reasoning are model reasoning, not tool
    // output: Anthropic validates the thinking `signature` against the original
    // thinking CONTENT, so rewriting the text would break same-provider replay.
    // reasoning carries opaque ciphertext plus a provider-synthesized summary.
    // None is a tool-output-secret egress path, so all pass through unchanged.
    case "image":
    case "thinking":
    case "reasoning":
      return block;
  }
}

function redactOutputPart(part: LlmToolOutputPart): LlmToolOutputPart {
  // Only text parts carry tool stdout/handoff prose; image parts are binary.
  return part.type === "text" ? { ...part, text: redactSecrets(part.text) } : part;
}
