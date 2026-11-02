import type { ModelFamily } from "../../../infra/llm/model-family.js";
/**
 * Running token counter for agent runtime context management.
 *
 * Mapped models use local text tokenizers; other models retain the character
 * heuristic. Images remain estimated. Deliberation counts only where the request
 * replays it, by the rule of the provider-history lowering: another model's
 * thinking counts only as the progress updates that the request sends as text.
 * Opaque reasoning counts by the tokens its provider reported, and only where
 * the request replays it and the model reads it: always in the current turn,
 * and in earlier turns only for a model that keeps them.
 * Provider usage calibrates complete request costs; this counter is not billing.
 *
 * Image parts in tool_result contribute a flat per-provider estimate so the
 * compaction planner and budget projection share one image cost source of
 * truth; see imageTokensForModel and countToolOutputPartsChars below.
 */

import type { ContentBlock, ConversationMessage } from "../llm/types.js";
import { modelFamilyApi, type LlmApi, type LlmToolOutputPart } from "../llm/messages.js";
import { keepsEarlierTurnReasoning } from "../llm/model-compat.js";
import { deliberationReplays, type DeliberationReplay } from "../llm/provider-history.js";
import { isProgressUpdate } from "../../../infra/llm/anthropic-narration.js";
import type { AccessProviderId } from "../../../infra/llm/access-provider.js";
import { assertNever } from "../../../infra/assert-never.js";
import { localTokenizerForModel, type LocalTokenizerIdentity } from "../../../infra/local-tokenizer.js";
import type { ClaudeTokenizerIdentity } from "../../../infra/llm/model-id.js";

export type TokenCountingPolicyIdentity =
  | `local:${LocalTokenizerIdentity}`
  | `heuristic:${ModelFamily}`;

export interface TokenCountingPolicy {
  readonly kind: "local" | "heuristic";
  /** The text encoding. Two policies with one identity count text alike. */
  readonly identity: TokenCountingPolicyIdentity;
  readonly imageTokens: number;
  countText(text: string): number;
  /** The request these counts are for. An assistant message's thinking counts
   *  only where this request replays it, and its reported reasoning only where
   *  the request replays all of its deliberation (`deliberationReplays`, the
   *  rule of the lowering) and the model reads it. Absent: reasoning counts by
   *  its visible text only. */
  readonly replayTarget?: ReasoningReplayTarget;
}

interface ReasoningReplayTarget {
  readonly accessProvider: AccessProviderId;
  readonly provider: ModelFamily;
  readonly api: LlmApi;
  readonly model: string;
  /** Whether the model reads replayed thinking from before the current turn. */
  readonly keepsEarlierTurns: boolean;
}

/** Where a message stands in its request. The current turn opens at the last
 *  user input and holds the tool loop that answers it. */
type TurnPosition = "current" | "earlier";

export interface TokenEstimationCache {
  /** Keyed by the text identity, and for an assistant message also by which
   *  deliberation the policy's request replays and whether it counts the
   *  reported reasoning. */
  readonly messages: WeakMap<ConversationMessage, Map<string, number>>;
}

interface TokenCounter {
  addMessage(message: ConversationMessage): void;
  addToolResult(content: LlmToolOutputPart[]): void;
  resetFor(messages: ReadonlyArray<ConversationMessage>): void;
  readonly total: number;
}

/** Per-image token heuristic. Provider-distinct but coarse: gpt-4o
 *  (default detail) is tile-based ≈765, Gemini charges 258 per image,
 *  Anthropic default-res ≈1568. Used to decide WHEN to summarize, not
 *  for billing. Model-specific refinement (detail=high vs auto) is a
 *  future concern. */
export function imageTokensForModel(provider: ModelFamily): number {
  switch (provider) {
    case "anthropic": return 1568;
    case "openai": return 765;
    case "google": return 258;
    // Estimator, not a hard invariant: an unknown provider falls back to a sane
    // image-token estimate rather than crash the counter. The `never` binding
    // still forces a compile error if ModelFamily grows a member.
    default: {
      const _exhaustive: never = provider;
      void _exhaustive;
      return 1568;
    }
  }
}

/** Selects exact local text counting when the canonical model has an approved
 *  encoding. `replay` names the request that the counts are for: its access
 *  provider and the model as its adapter stamps the turns that it serves, so
 *  deliberation counts where that request replays it. */
export function tokenCountingPolicy(
  canonicalModel: string,
  modelFamily: ModelFamily,
  tokenizerIdentity?: ClaudeTokenizerIdentity,
  replay?: { readonly accessProvider: AccessProviderId; readonly model: string },
): TokenCountingPolicy {
  const tokenizer = localTokenizerForModel(canonicalModel, tokenizerIdentity);
  const replayTarget = replay === undefined
    ? {}
    : { replayTarget: {
      accessProvider: replay.accessProvider, provider: modelFamily, api: modelFamilyApi(modelFamily), model: replay.model,
      keepsEarlierTurns: keepsEarlierTurnReasoning(canonicalModel),
    } };
  if (tokenizer) {
    return {
      kind: "local",
      identity: `local:${tokenizer.identity}`,
      imageTokens: imageTokensForModel(modelFamily),
      countText: tokenizer.count,
      ...replayTarget,
    };
  }
  return {
    kind: "heuristic",
    identity: `heuristic:${modelFamily}`,
    imageTokens: imageTokensForModel(modelFamily),
    countText: (text) => Math.ceil(text.length / 4),
    ...replayTarget,
  };
}

/** Which deliberation of each message of `messages` the policy's request
 *  replays, by index (`deliberationReplays`); none is known without a request.
 *  Whether the shared engine host serves a Claude request is decided per
 *  request, so a Claude count reads the host's framing, which changes a count
 *  only where host framing alone separates an incomplete fragment from its
 *  continuation. Every other API reads no host framing. */
function replaysUnder(messages: readonly ConversationMessage[], policy: TokenCountingPolicy): readonly (DeliberationReplay | undefined)[] {
  const target = policy.replayTarget;
  return target === undefined ? [] : deliberationReplays(messages, { ...target, sharedHost: target.api === "anthropic-messages" });
}

/** Whether a request under `policy` re-sends the reasoning that `message`'s
 *  provider reported and the model reads it. Only a message whose deliberation
 *  the request replays in full and that kept its reasoning blocks replays them,
 *  and a model that drops earlier thinking reads them only in the current turn. */
function countsReportedReasoning(message: ConversationMessage, policy: TokenCountingPolicy, position: TurnPosition, replay: DeliberationReplay | undefined): message is Extract<ConversationMessage, { kind: "assistant" }> & { reasoningTokens: number; content: ContentBlock[] } {
  return replay === "all"
    && message.kind === "assistant"
    && message.reasoningTokens !== undefined
    && (position === "current" || policy.replayTarget?.keepsEarlierTurns === true)
    && typeof message.content !== "string"
    && message.content.some((block) => block.type === "thinking" || block.type === "reasoning");
}

/** The reported reasoning that the visible thinking text does not already
 *  count. Redacted thinking has no text, so all of it counts; readable
 *  thinking counts once, at the larger of its text and the report. */
function hiddenReasoningTokens(message: ConversationMessage, policy: TokenCountingPolicy, position: TurnPosition, replay: DeliberationReplay | undefined): number {
  if (!countsReportedReasoning(message, policy, position, replay)) return 0;
  let visible = 0;
  for (const block of message.content) {
    if (block.type === "thinking") visible += policy.countText(block.thinking);
  }
  return Math.max(0, message.reasoningTokens - visible);
}

export function createTokenEstimationCache(): TokenEstimationCache {
  return { messages: new WeakMap() };
}

// Image parts contribute imageTokens * 4 chars so the shared `chars / 4`
// rounding in addMessage/resetFor lands on `imageTokens` per image.
function countToolOutputPartsChars(parts: ReadonlyArray<LlmToolOutputPart>, imageTokens: number): number {
  let chars = 0;
  for (const part of parts) {
    switch (part.type) {
      case "text":
        chars += part.text.length;
        break;
      case "image":
        chars += imageTokens * 4;
        break;
      default:
        return assertNever(part);
    }
  }
  return chars;
}

function estimateChars(content: string | ContentBlock[], imageTokens: number): number {
  if (typeof content === "string") return content.length;

  let chars = 0;
  for (const block of content) {
    switch (block.type) {
      case "text":
        chars += block.text.length;
        break;
      case "image":
        chars += imageTokens * 4;
        break;
      case "tool_use":
        chars += block.name.length + JSON.stringify(block.input).length;
        break;
      case "thinking":
        chars += block.thinking.length;
        break;
      case "reasoning":
        break;
      default:
        return assertNever(block);
    }
  }
  return chars;
}

function estimateContentTokens(content: string | ContentBlock[], policy: TokenCountingPolicy): number {
  if (typeof content === "string") return policy.countText(content);
  let tokens = 0;
  for (const block of content) {
    switch (block.type) {
      case "text":
        tokens += policy.countText(block.text);
        break;
      case "image":
        tokens += policy.imageTokens;
        break;
      case "tool_use":
        tokens += policy.countText(block.name + JSON.stringify(block.input));
        break;
      case "thinking":
        tokens += policy.countText(block.thinking);
        break;
      case "reasoning":
        break;
      default:
        return assertNever(block);
    }
  }
  return tokens;
}

/** Single source of truth for per-message token estimation, shared by the
 *  running counter and the compaction planner so trigger and plan agree. */
export function estimateMessageTokens(message: ConversationMessage, imageTokens: number): number {
  const chars = message.kind === "toolResult"
    ? countToolOutputPartsChars(message.content, imageTokens)
    : estimateChars(message.content, imageTokens);
  return Math.ceil(chars / 4);
}

/** Estimates one message under one model policy: its semantic text, images at
 *  their numeric provider cost, and the reported reasoning that the policy's
 *  request replays and its model reads at `position`. `replay` is the
 *  message's deliberation replay within its request, by default as a request
 *  of that message alone. */
export function estimateMessageTokensWithPolicy(
  message: ConversationMessage,
  policy: TokenCountingPolicy,
  position: TurnPosition = "current",
  replay: DeliberationReplay | undefined = replaysUnder([message], policy)[0],
): number {
  return estimateVisibleTokens(withholdsThinking(message, replay) ? withoutPrivateThinking(message) : message, policy) + hiddenReasoningTokens(message, policy, position, replay);
}

/** Whether a request that replays `replay` of `message`'s deliberation withholds its thinking. */
function withholdsThinking(message: ConversationMessage, replay: DeliberationReplay | undefined): message is Extract<ConversationMessage, { kind: "assistant" }> & { content: ContentBlock[] } {
  return replay === "none"
    && message.kind === "assistant"
    && typeof message.content !== "string"
    && message.content.some((block) => block.type === "thinking");
}

/** The message as a request that withholds its thinking sends it: only its progress updates stay. */
function withoutPrivateThinking(message: Extract<ConversationMessage, { kind: "assistant" }> & { content: ContentBlock[] }): ConversationMessage {
  return { ...message, content: message.content.filter((block) => block.type !== "thinking" || isProgressUpdate(block)) };
}

/** The index of the first message of the current turn: the first assistant
 *  message after the last user input that travels without a tool result. A
 *  user message next to a tool result shares its wire message (one user
 *  message per run, as the Anthropic conversion sends it), so it continues
 *  the tool loop. Not verified for OpenAI and Google, which only report
 *  reasoning tokens here. */
function currentTurnStart(messages: ReadonlyArray<ConversationMessage>): number {
  let start = 0;
  let input = false;
  let toolResult = false;
  for (const [index, message] of messages.entries()) {
    if (message.kind === "assistant") {
      if (input && !toolResult) start = index;
      input = false;
      toolResult = false;
    } else if (message.kind === "toolResult") toolResult = true;
    else if (message.kind === "user" || message.kind === "compactionSummary") input = true;
  }
  return input && !toolResult ? messages.length : start;
}

function estimateVisibleTokens(message: ConversationMessage, policy: TokenCountingPolicy): number {
  if (policy.kind === "heuristic") return estimateMessageTokens(message, policy.imageTokens);
  if (message.kind !== "toolResult") return estimateContentTokens(message.content, policy);
  let tokens = 0;
  for (const part of message.content) {
    switch (part.type) {
      case "text":
        tokens += policy.countText(part.text);
        break;
      case "image":
        tokens += policy.imageTokens;
        break;
      default:
        return assertNever(part);
    }
  }
  return tokens;
}

/** Estimates one prepared outbound message view without changing the running
 * canonical-history counter. */
export function estimateConversationTokens(
  messages: ReadonlyArray<ConversationMessage>,
  providerOrPolicy: ModelFamily | TokenCountingPolicy,
  cache?: TokenEstimationCache,
): number {
  if (typeof providerOrPolicy === "string") {
    const imageTokens = imageTokensForModel(providerOrPolicy);
    return messages.reduce((total, message) => total + estimateMessageTokens(message, imageTokens), 0);
  }
  const turnStart = currentTurnStart(messages);
  const replays = replaysUnder(messages, providerOrPolicy);
  return messages.reduce((total, message, index) => {
    const position: TurnPosition = index >= turnStart ? "current" : "earlier";
    const replay = replays[index];
    const key = message.kind === "assistant"
      ? `${providerOrPolicy.identity}:${replay ?? "unknown"}:${countsReportedReasoning(message, providerOrPolicy, position, replay) ? "counted" : "uncounted"}`
      : providerOrPolicy.identity;
    let identities = cache?.messages.get(message);
    const cached = identities?.get(key);
    if (cached !== undefined) return total + cached;
    const tokens = estimateMessageTokensWithPolicy(message, providerOrPolicy, position, replay);
    if (cache) {
      identities ??= new Map();
      identities.set(key, tokens);
      cache.messages.set(message, identities);
    }
    return total + tokens;
  }, 0);
}

export function createTokenCounter(options: {
  provider: ModelFamily;
  tokenPolicy?: TokenCountingPolicy;
  cache?: TokenEstimationCache;
}): TokenCounter {
  const imageTokens = imageTokensForModel(options.provider);
  // resetFor walks every message in the post-compaction history; cache the
  // per-message token count so repeated walks (compaction unwind, idle
  // recompute) don't re-scan content arrays. ConversationMessage objects are
  // immutable in practice, so identity-keyed caching is safe.
  const cache = new WeakMap<ConversationMessage, number>();
  let totalTokens = 0;

  function messageTokens(message: ConversationMessage): number {
    if (options.tokenPolicy) {
      return estimateConversationTokens([message], options.tokenPolicy, options.cache);
    }
    const cached = cache.get(message);
    if (cached !== undefined) return cached;
    const tokens = estimateMessageTokens(message, imageTokens);
    cache.set(message, tokens);
    return tokens;
  }

  return {
    /** Counts `message` as the newest message of its request. */
    addMessage(message) {
      totalTokens += messageTokens(message);
    },

    addToolResult(content: LlmToolOutputPart[]) {
      totalTokens += options.tokenPolicy
        ? estimateMessageTokensWithPolicy({ kind: "toolResult", toolUseId: "", content }, options.tokenPolicy)
        : Math.ceil(countToolOutputPartsChars(content, imageTokens) / 4);
    },

    /** Recounts `messages` as one request, so each message's turn position
     *  decides whether its reported reasoning counts. */
    resetFor(messages) {
      if (options.tokenPolicy) {
        totalTokens = estimateConversationTokens(messages, options.tokenPolicy, options.cache);
        return;
      }
      totalTokens = 0;
      for (const m of messages) totalTokens += messageTokens(m);
    },

    get total() {
      return totalTokens;
    },
  };
}

