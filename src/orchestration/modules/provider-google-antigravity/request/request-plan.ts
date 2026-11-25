import type { ReasoningEffort } from "../../../../infra/providers/llm/models/models.js";
import type { SystemPromptTiers } from "../../../agent-runtime/llm/system-prompt-tiers.js";
import type { ConversationMessage } from "../../../../infra/providers/llm/conversation/conversation-message.js";
import { renderAppend, renderMessages } from "./history-text.js";
import { messageFingerprint, systemPromptHash, type SessionView, type SyntheticPrompt } from "./session-view.js";

type UserMessage = Extract<ConversationMessage, { kind: "user" }>;
type ToolResultMessage = Extract<ConversationMessage, { kind: "toolResult" }>;

/** The prompt that a rotation sends when its tail is a tool result: the call and its result are in the append, and the
 *  model continues from them. */
export const CONTINUATION_PROMPT = "Continue from the last tool result.";

/** The prompt that a rotation sends when the request's new input is too large for one prompt: the input is the last
 *  part of the append, and the model replies to it. */
export const REPLY_PROMPT = "Reply to the last message of the conversation.";

/** One Flywheel request as the plan reads it. */
export interface PlannedRequest {
  /** The engine process that serves the request. */
  readonly processId: string;
  readonly systemPrompt: SystemPromptTiers;
  /** The request's history, lowered for this route (`lowerProviderHistory`), ending with its new input. */
  readonly messages: readonly ConversationMessage[];
  readonly model: string;
  readonly effort?: ReasoningEffort;
  /** The agent loop's estimate of the whole request, in tokens (`StreamOptions.estimatedContextTokens`). */
  readonly estimatedTokens: number;
}

/** The serving model's limits. `threshold` is the engine's own compaction threshold in tokens; work that would bring
 *  the session within `margin` of it never reaches the engine. `byteCap` is the largest append that the model accepts.
 *  `promptByteCap` is the largest prompt text, in UTF-8 bytes, that the engine reads whole: the engine cuts the end of a
 *  longer prompt, so the caller leaves room in it for the engine's own wrapper. */
export interface PlanLimits {
  readonly threshold: number;
  readonly margin: number;
  readonly byteCap: number;
  readonly promptByteCap: number;
}

type RotationReason = "new-session" | "cancelled" | "process" | "system-prompt" | "history" | "selection" | "occupancy" | "prompt-size";

/** The model and effort that a session changes to between prompts (`session/set_config_option`). */
interface SelectionChange {
  readonly model: string;
  readonly effort: ReasoningEffort | undefined;
}

/**
 * What the bridge does for one request. Every plan except `overflow` carries the view of the session once the bridge
 * has released the plan's work, without the step's output.
 * - `push`: the idle session holds the request's history up to its new user messages, whose rendered `text` goes as
 *   the next prompt, after `select` when the model or effort changed.
 * - `deliver`: the session's open prompt waits on the call `toolUseId`, whose result is the request's new tail, with
 *   the runtime-owned entries that follow it (`notices`).
 * - `continue-call`: the session already revealed the call `toolUseId`, which the request's history does not hold yet,
 *   so the request settles on that call and releases nothing.
 * - `rotate`: the session cannot continue to the request, so a new session opens with `append` and sends `prompt`.
 * - `overflow`: the request does not fit the serving model, so nothing is released and history must compact.
 */
export type RequestPlan =
  | { readonly kind: "push"; readonly text: string; readonly select?: SelectionChange; readonly view: SessionView }
  | { readonly kind: "deliver"; readonly toolUseId: string; readonly result: ToolResultMessage; readonly notices: readonly UserMessage[]; readonly view: SessionView }
  | { readonly kind: "continue-call"; readonly toolUseId: string; readonly view: SessionView }
  | { readonly kind: "rotate"; readonly reason: RotationReason; readonly append: string; readonly prompt: RotationPrompt; readonly view: SessionView }
  | { readonly kind: "overflow"; readonly reason: "tokens" | "bytes" };

/** The new input of the request as rendered text, or a fixed prompt when the append holds the whole request. */
type RotationPrompt =
  | { readonly kind: "input"; readonly text: string }
  | { readonly kind: "continuation"; readonly text: typeof CONTINUATION_PROMPT | typeof REPLY_PROMPT };

function isUser(message: ConversationMessage | undefined): message is UserMessage {
  return message?.kind === "user";
}

/** Whether a user entry only accompanies the entry before it: a runtime notice, or framing that the runtime wrote (a
 *  model, environment, or date reminder, a tool notice, turn context), read from its canonical fields. */
function accompanies(message: UserMessage): boolean {
  return message.runtimeNotice === true || message.framing !== undefined;
}

/** Where the new input of `messages` starts: at the user entries that end it, except the entries that accompany a tool
 *  result before them, which go with that result. The input is empty when nothing but such entries follows the result. */
function inputStart(messages: readonly ConversationMessage[]): number {
  let start = messages.length;
  while (isUser(messages[start - 1])) start -= 1;
  if (messages[start - 1]?.kind !== "toolResult") return start;
  for (let message = messages[start]; isUser(message) && accompanies(message); message = messages[start]) start += 1;
  return start;
}

function promptFits(text: string, limits: PlanLimits): boolean {
  return Buffer.byteLength(text, "utf8") <= limits.promptByteCap;
}

function rotate(request: PlannedRequest, limits: PlanLimits, reason: RotationReason, fingerprints: readonly string[]): RequestPlan {
  if (request.estimatedTokens >= limits.threshold - limits.margin) return { kind: "overflow", reason: "tokens" };
  const start = inputStart(request.messages);
  const input = renderMessages(request.messages.slice(start));
  const sendsInput = start < request.messages.length && promptFits(input, limits);
  const covered = sendsInput ? start : request.messages.length;
  const append = renderAppend({ systemPrompt: request.systemPrompt, history: request.messages.slice(0, covered), byteCap: limits.byteCap });
  if (append.kind === "over-cap") return { kind: "overflow", reason: "bytes" };
  const synthetic: SyntheticPrompt[] = [{ kind: "primer", after: covered }, ...sendsInput ? [] : [{ kind: "continuation" as const, after: covered }]];
  return {
    kind: "rotate",
    reason,
    append: append.text,
    prompt: sendsInput
      ? { kind: "input", text: input }
      : { kind: "continuation", text: start === request.messages.length ? CONTINUATION_PROMPT : REPLY_PROMPT },
    view: {
      processId: request.processId,
      systemPromptHash: systemPromptHash(request.systemPrompt),
      held: fingerprints,
      covered,
      synthetic,
      cancelled: false,
      model: request.model,
      ...request.effort === undefined ? {} : { effort: request.effort },
    },
  };
}

/** The view once the bridge released `request` to the session of `view`. */
function released(view: SessionView, request: PlannedRequest, fingerprints: readonly string[]): SessionView {
  const { output: _settled, effort: _effort, ...rest } = view;
  return { ...rest, held: fingerprints, model: request.model, ...request.effort === undefined ? {} : { effort: request.effort } };
}

/**
 * Decides how the session of `view` (undefined when the agent has none yet) serves `request` (decision 4, P5, P7,
 * P9). The session continues only when it holds exactly the request's history up to the new part, through the same
 * process and system prompt, its last output is in that history as the engine produced it, and it was never
 * cancelled; every other request rotates from canonical history. Before it releases any work, the plan checks the
 * session's last reported occupancy plus the new part against the engine's compaction threshold, and a prompt against
 * the engine's prompt size; a session too close to the threshold or a prompt too large rotates, and a request whose
 * whole history does not fit is `overflow`.
 */
export function planRequest(view: SessionView | undefined, request: PlannedRequest, limits: PlanLimits): RequestPlan {
  const fingerprints = request.messages.map(messageFingerprint);
  if (view === undefined) return rotate(request, limits, "new-session", fingerprints);
  if (view.cancelled) return rotate(request, limits, "cancelled", fingerprints);
  if (view.processId !== request.processId) return rotate(request, limits, "process", fingerprints);
  if (view.systemPromptHash !== systemPromptHash(request.systemPrompt)) return rotate(request, limits, "system-prompt", fingerprints);
  if (view.output === undefined || view.held.some((held, at) => fingerprints[at] !== held)) return rotate(request, limits, "history", fingerprints);

  const [, ...rest] = request.messages.slice(view.held.length);
  const holdsOutput = fingerprints[view.held.length] === view.output.fingerprint;
  const selectionChanged = request.model !== view.model || request.effort !== view.effort;
  const fits = (text: string) => (view.occupancy ?? 0) + Math.ceil(text.length / 4) < limits.threshold - limits.margin;

  if (view.output.kind === "call") {
    const toolUseId = view.output.toolUseId;
    if (selectionChanged) return rotate(request, limits, "selection", fingerprints);
    if (request.messages.length === view.held.length) return { kind: "continue-call", toolUseId, view };
    const [result, ...notices] = rest;
    const delivers = holdsOutput && result?.kind === "toolResult" && result.toolUseId === toolUseId
      && notices.every((notice): notice is UserMessage => isUser(notice) && accompanies(notice));
    if (!delivers) return rotate(request, limits, "history", fingerprints);
    if (!fits(renderMessages([result, ...notices]))) return rotate(request, limits, "occupancy", fingerprints);
    return { kind: "deliver", toolUseId, result, notices, view: released(view, request, fingerprints) };
  }

  if (!holdsOutput || rest.length === 0 || !rest.every(isUser)) return rotate(request, limits, "history", fingerprints);
  const text = renderMessages(rest);
  if (!promptFits(text, limits)) return rotate(request, limits, "prompt-size", fingerprints);
  if (!fits(text)) return rotate(request, limits, "occupancy", fingerprints);
  return {
    kind: "push",
    text,
    ...selectionChanged ? { select: { model: request.model, effort: request.effort } } : {},
    view: released(view, request, fingerprints),
  };
}
