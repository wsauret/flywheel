import type { AccessProviderId } from "../../../infra/llm/access-provider.js";
import type { RefusedPart } from "../../../infra/llm/content-repair.js";
import { Log } from "../../../infra/log.js";
import type { ContentBlock, ConversationMessage } from "./types.js";

type AssistantMessage = Extract<ConversationMessage, { kind: "assistant" }>;
type ToolResultMessage = Extract<ConversationMessage, { kind: "toolResult" }>;
type DecisionMessage = Extract<ConversationMessage, { kind: "system" }> & { contentRepair: NonNullable<Extract<ConversationMessage, { kind: "system" }>["contentRepair"]> };
interface Withheld { readonly partIndex: number; readonly partKind: "text" | "image"; readonly note: string }
interface Refusal { readonly reason: string; readonly part?: RefusedPart }

const log = Log.create({ service: "content-repair" });

/** Applies every recorded content-repair decision in `messages` to a provider-only view; canonical entries stay
 *  unchanged. Returns `messages` itself when no decision applies; otherwise a new array that reuses every message
 *  object the decisions do not touch. Pure: linear in the history.
 *
 *  A withhold replaces the named tool result part, when it still exists with the recorded kind, by the decision's
 *  note; the decision stays a system message, which the converters remove. A remove drops the named tool calls,
 *  an assistant message left with no block, and their results, and puts the decision's note in place of the
 *  decision as a system-origin user message. */
export function applyContentRepairs(messages: readonly ConversationMessage[]): readonly ConversationMessage[] {
  const withheld = new Map<string, Withheld[]>();
  const removed = new Set<string>();
  for (const message of messages) {
    if (!isDecision(message)) continue;
    const repair = message.contentRepair;
    if (repair.kind === "withhold") {
      const parts = withheld.get(repair.toolUseId) ?? [];
      parts.push({ partIndex: repair.partIndex, partKind: repair.partKind, note: message.content });
      withheld.set(repair.toolUseId, parts);
    } else for (const id of repair.toolUseIds) removed.add(id);
  }
  if (withheld.size === 0 && removed.size === 0) return messages;

  const repaired: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.kind === "toolResult") {
      if (removed.has(message.toolUseId)) continue;
      const parts = withheld.get(message.toolUseId);
      repaired.push(parts ? withhold(message, parts) : message);
    } else if (message.kind === "assistant") {
      const kept = removed.size === 0 ? message : withoutCalls(message, removed);
      if (kept) repaired.push(kept);
    } else if (isDecision(message) && message.contentRepair.kind === "remove") {
      repaired.push({ kind: "user", origin: "system", content: message.content });
    } else repaired.push(message);
  }
  return repaired;
}

/** The decision for one provider content refusal against the loop history, or undefined when the run must end
 *  with the provider's error. Writes one INFO record per refusal with the decision's kind and the refusal's
 *  shape, never its content; otherwise linear in the history.
 *
 *  A removal after the newest assistant message means the last-resort retry was already refused, so nothing is
 *  planned. A located part that is not yet withheld is withheld. Otherwise the tool calls of the newest assistant
 *  message are removed, when it has any. The decision's `content` is its note: the transcript notice and the
 *  text the model receives. */
export function repairContentRefusal(history: readonly ConversationMessage[], refusal: Refusal, accessProvider: AccessProviderId): DecisionMessage | undefined {
  const { part } = refusal;
  const decision = planContentRepair(history, refusal);
  const repair = decision?.contentRepair;
  log.info("content refusal repair", {
    decision: repair?.kind ?? "unrepaired", accessProvider, located: part !== undefined,
    ...(part ? { partKind: part.kind } : {}), ...(repair?.kind === "remove" ? { removedCalls: repair.toolUseIds.length } : {}),
  });
  return decision;
}

function planContentRepair(history: readonly ConversationMessage[], refusal: Refusal): DecisionMessage | undefined {
  const newest = history.findLastIndex((message) => message.kind === "assistant");
  if (history.slice(newest + 1).some((message) => isDecision(message) && message.contentRepair.kind === "remove")) return undefined;

  const { part, reason } = refusal;
  if (part && !history.some((message) => isDecision(message) && message.contentRepair.kind === "withhold"
    && message.contentRepair.toolUseId === part.toolUseId && message.contentRepair.partIndex === part.partIndex)) {
    // SAFETY: the refused request was built from this history, which pairs every tool result with its call.
    const call = history.flatMap(toolCalls).find((block) => block.id === part.toolUseId)!;
    return {
      kind: "system",
      content: `[Flywheel withheld this ${part.kind} from the result of ${describeCall(call)} because the provider refused it: ${reason}]`,
      contentRepair: { kind: "withhold", toolUseId: part.toolUseId, partIndex: part.partIndex, partKind: part.kind },
    };
  }

  const newestAssistant = history[newest];
  const removed = newestAssistant === undefined ? [] : toolCalls(newestAssistant);
  if (removed.length === 0) return undefined;
  return {
    kind: "system",
    content: `Flywheel removed your most recent tool calls (${removed.map(describeCall).join("; ")}) and their results from this conversation, because the provider refused the request that contained them: ${/[.!?]$/.test(reason) ? reason : `${reason}.`} Running them again would repeat the refusal. Do not run them again; continue the task without their results, or tell the person that you cannot continue without them.`,
    contentRepair: { kind: "remove", toolUseIds: removed.map((block) => block.id) },
  };
}

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

function toolCalls(message: ConversationMessage): ToolUseBlock[] {
  if (message.kind !== "assistant" || typeof message.content === "string") return [];
  return message.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
}

function describeCall(call: ToolUseBlock): string {
  return `${call.name} ${JSON.stringify(call.input)}`;
}

function isDecision(message: ConversationMessage): message is DecisionMessage {
  return message.kind === "system" && message.contentRepair !== undefined;
}

function withhold(message: ToolResultMessage, parts: readonly Withheld[]): ToolResultMessage {
  let content: ToolResultMessage["content"] | undefined;
  for (const { partIndex, partKind, note } of parts) {
    if (message.content[partIndex]?.type !== partKind) continue;
    content ??= [...message.content];
    content[partIndex] = { type: "text", text: note };
  }
  return content ? { ...message, content } : message;
}

/** Returns the message unchanged when it names no removed call, and undefined when no block remains. */
function withoutCalls(message: AssistantMessage, removed: ReadonlySet<string>): AssistantMessage | undefined {
  if (typeof message.content === "string") return message;
  const isRemoved = (block: ContentBlock) => block.type === "tool_use" && removed.has(block.id);
  if (!message.content.some(isRemoved)) return message;
  const content = message.content.filter((block) => !isRemoved(block));
  return content.length === 0 ? undefined : { ...message, content };
}
