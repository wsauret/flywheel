import { isProgressUpdate } from "../../../../infra/llm/anthropic-narration.js";
import type { LlmToolOutputPart } from "../../../../infra/llm/tool-output-part-schema.js";
import { originOf } from "../../../agent-runtime/llm/block-origin.js";
import type { ProviderHistoryTarget } from "../../../agent-runtime/llm/provider-history.js";
import { renderSystemPrompt, SYSTEM_PROMPT_SEPARATOR, type SystemPromptTiers } from "../../../agent-runtime/llm/system-prompt-tiers.js";
import type { ContentBlock, ConversationMessage } from "../../../agent-runtime/llm/types.js";

/**
 * Flywheel history as the text that an Antigravity engine session reads in its system text
 * (`_meta.antigravity.systemPrompt.append`), because the engine accepts no structured history (PI-MODEL-062).
 *
 * Each message renders alone and in history order, so the text of a history is a prefix of the text of every history
 * that extends it, and the cached prefix stays stable (the system prompt renders first, stable tier first). A user
 * entry names who wrote it from the canonical entry's fields (`originOf`, ARCH-PROVIDERS-067), never from its bytes, so
 * a runtime reminder stays a reminder and a person's text that looks like one stays the person's text. Private
 * reasoning never renders, also when this route produced it; a progress update, which the agent said to its person,
 * renders as the agent's text.
 */

const HISTORY_HEADING = [
  "# Conversation so far",
  "",
  "The messages of this conversation before the current request, as text, oldest first. Each <message> is one message; on a user message, `origin` says who wrote it: `person` is your person, every other origin is the Flywheel runtime. <tool_call> is a tool call that you made, and <tool_result> is its result. In the text of an entry, `&lt;` stands for `<` and `&amp;` for `&`. Continue this conversation as the same agent.",
].join("\n");

/** Where an image stood: the text cannot carry it, so the entry says that it was there. */
function imageReference(mediaType: string): string {
  return `[image: ${mediaType}, not shown in this text history]`;
}

/** Content text in which no message can open or close an entry: the `<` of each tag of this rendering's vocabulary
 *  becomes `&lt;`, after each `&` that would read as one of the two escapes becomes `&amp;`, so the text reads back
 *  exactly and two different texts never render the same. Every other byte stays as it is, so code stays readable. */
function body(text: string): string {
  return text.replaceAll(/&(?=amp;|lt;)/g, "&amp;").replaceAll(/<(\/?)(message|tool_call|tool_result)\b/g, "&lt;$1$2");
}

function attribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function element(tag: string, attributes: string, text: string): string {
  return `<${tag}${attributes}>\n${text}\n</${tag}>`;
}

function userPart(part: ContentBlock | LlmToolOutputPart): string | undefined {
  switch (part.type) {
    case "text": return body(part.text);
    case "image": return imageReference(part.mediaType);
    default: return undefined;
  }
}

function assistantPart(part: ContentBlock): string | undefined {
  switch (part.type) {
    case "text": return body(part.text);
    case "thinking": return isProgressUpdate(part) ? body(part.thinking) : undefined;
    case "reasoning": return undefined;
    case "tool_use": return element("tool_call", ` id="${attribute(part.id)}" name="${attribute(part.name)}"`, body(JSON.stringify(part.input)));
    case "image": return imageReference(part.mediaType);
  }
}

function parts(content: string | readonly ContentBlock[], render: (part: ContentBlock) => string | undefined): string[] {
  return typeof content === "string" ? [body(content)] : content.flatMap((part) => render(part) ?? []);
}

function resultStatus(message: Extract<ConversationMessage, { kind: "toolResult" }>): string {
  if (message.interrupted === true) return ` status="interrupted"`;
  if (message.blocked === true) return ` status="blocked"`;
  return message.isError === true ? ` status="error"` : "";
}

/** The text of one message, or the empty text for a message that a model never reads as history: a system entry, or
 *  an assistant turn that holds only private reasoning. */
export function renderMessage(message: ConversationMessage): string {
  switch (message.kind) {
    case "system": return "";
    case "assistant": {
      const text = parts(message.content, assistantPart);
      return text.length === 0 ? "" : element("message", ` role="assistant"`, text.join("\n"));
    }
    case "toolResult":
      return element("tool_result", ` id="${attribute(message.toolUseId)}"${resultStatus(message)}`, message.content.flatMap((part) => userPart(part) ?? []).join("\n"));
    case "user":
    case "compactionSummary":
      return element("message", ` role="user" origin="${originOf(message)}"`, parts(message.content, userPart).join("\n"));
  }
}

/** The text of `messages`, in order; the empty text when none renders. */
export function renderMessages(messages: readonly ConversationMessage[]): string {
  return messages.map(renderMessage).filter((text) => text.length > 0).join("\n\n");
}

/** The append of one engine session, or its size when it is over the cap. */
export type AppendText =
  | { readonly kind: "text"; readonly text: string; readonly bytes: number }
  | { readonly kind: "over-cap"; readonly bytes: number; readonly byteCap: number };

/**
 * The system text that opens an engine session: the whole system prompt in tier order, then `history` as text. A
 * caller lowers `history` for this route first (`lowerProviderHistory`), which leaves out the framing that the serving
 * model does not read. The result is `over-cap` when its UTF-8 size exceeds `byteCap`, the largest append that the
 * serving model accepts, because the engine fails every prompt of a session whose system text is over its budget.
 */
export function renderAppend(input: { readonly systemPrompt: SystemPromptTiers; readonly history: readonly ConversationMessage[]; readonly byteCap: number }): AppendText {
  const history = renderMessages(input.history);
  const text = [renderSystemPrompt(input.systemPrompt), history.length === 0 ? "" : `${HISTORY_HEADING}\n\n${history}`]
    .filter((part) => part.length > 0)
    .join(SYSTEM_PROMPT_SEPARATOR);
  const bytes = Buffer.byteLength(text, "utf8");
  return bytes > input.byteCap ? { kind: "over-cap", bytes, byteCap: input.byteCap } : { kind: "text", text, bytes };
}

/** The history target of a request that this rendering serves: the route's own identity, read as text, so the
 *  lowering withholds every native deliberation block, also of the route's own turns, and records each one
 *  (ARCH-CONTEXT-010). */
export function textHistoryTarget(identity: Omit<ProviderHistoryTarget, "sharedHost" | "readsHistoryAsText">): ProviderHistoryTarget {
  return { ...identity, sharedHost: false, readsHistoryAsText: true };
}
