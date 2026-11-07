import { summarizeProviderError } from "../../infra/llm/provider-error-diagnostic.js";
import { attemptRequest, createAssistantAttempt, type AssistantAttemptInput } from "./assistant-turn-attempt.js";
import type { AssistantTurnResult } from "./assistant-turn-result.js";
import { isFailoverFailure } from "./llm/provider-failure.js";
import type { PreparedRequestAttempt } from "./request-tool-surface.js";
import { NO_SYSTEM_PROMPT } from "./llm/system-prompt-tiers.js";
import { resolveCacheRetention, type AdmittedModelRequest, type AdmittedModelRequestExecution, type PreparedCandidate, type PreparedServingRequest, type ProviderRetry, type ProviderStreamEvent, type ServingAttempt, type StreamOptions, type TurnModelClient, type ConversationMessage } from "./llm/types.js";
import { estimateConversationTokens, tokenCountingPolicy } from "./compaction/token-counter.js";
import { prepareLocalTokenizer } from "../../infra/local-tokenizer.js";
import { redactMessage } from "./agent-loop-history.js";
import { isProviderResponseEvent, promptPrefixKey, type PrefixHoldTicket, type PromptPrefixHold } from "./prompt-prefix-hold.js";

type Attempt = ReturnType<typeof createAssistantAttempt>;
type SettledAttempt<T> = { value: T; stop: boolean };
type ExecutionInput = Pick<AssistantAttemptInput, "signal" | "onEvent" | "canonicalizeToolCall" | "canonicalizeToolName" | "onStreamAbandoned" | "onHandoffStarted">;
type FoldAttempt<T> = (input: Partial<ExecutionInput>, settle: (attempt: Attempt) => Promise<SettledAttempt<T>>) => Promise<AdmittedModelRequestExecution<T>>;
type StreamRetryEvent = Extract<ProviderStreamEvent, { kind: "stream_retry" }>;

interface RequestInput {
  client: TurnModelClient;
  executionCwd: string;
  request?: Pick<AdmittedModelRequest, "run">;
  signal: AbortSignal | undefined;
  providerOptions: StreamOptions["providerOptions"];
  estimatedInputTokenClasses?: (attempt: ServingAttempt) => {
    readonly uncachedInputTokens: number;
    readonly cacheTokens: number;
  };
  /** Receives the walk's in-place retries as stream events, so the session
   *  shows the reconnect while the request waits. Absent for callers with
   *  no presentation. */
  onEvent?: (event: StreamRetryEvent) => void;
  /** Reports entry and exit of the provider walk's abortable account login wait. */
  onLoginWait?: (waiting: boolean) => void;
  /** Holds this request behind a sibling that is writing the same cached
   *  prompt prefix (prompt-prefix-hold.ts). Only the first request of an
   *  agent of a workflow carries it. */
  prefixHold?: PromptPrefixHold;
}

interface PreparedExecution<T> {
  input: AssistantAttemptInput;
  execute: (candidate: PreparedCandidate, fold: FoldAttempt<T>) => Promise<AdmittedModelRequestExecution<T>>;
}

/** One request of a loop whose bytes the loop prepares for each candidate. */
export interface AssistantRequestPreparation extends RequestInput {
  /** Returns the request bytes for `attempt` without opening execution resources. Called again after
   *  `appendEntries`, so it reads the history that holds them. */
  prepare(attempt: ServingAttempt): { input: AssistantAttemptInput } | Promise<{ input: AssistantAttemptInput }>;
  /** Appends the route's request entries (`ServingAttempt.requestEntries`) to the request's history. */
  appendEntries?: (entries: readonly ConversationMessage[]) => Promise<void>;
}

/** One request of a loop that settles its own attempts (`streamAssistantTurn`). */
export interface AssistantTurnRequest<T> extends AssistantRequestPreparation {
  prepare(attempt: ServingAttempt): PreparedExecution<T> | Promise<PreparedExecution<T>>;
}

/** The candidate that a walk selected and the request that its client receives. */
export interface PreparedRequest {
  readonly candidate: PreparedCandidate;
  readonly request: StreamOptions;
}

/** The stream event one in-place retry becomes: what failed, which retry of
 *  how many, and how long the request waits before it. */
function streamRetryEvent(retry: ProviderRetry): StreamRetryEvent {
  return {
    kind: "stream_retry",
    attempt: retry.attempt,
    maxAttempts: retry.maxAttempts,
    reason: retry.failure.message,
    delayMs: retry.delayMs,
    error: summarizeProviderError(retry.failure.cause),
  };
}

/** The request revision of one admitted request: its walk calls `prepare` for each candidate, and `current` is what
 *  the last call prepared. A loop's request prepares through the loop (`AssistantRequestPreparation`); an ephemeral
 *  request appends the route's messages to its own input. */
function requestRevision<Revision extends { input: AssistantAttemptInput }>(input: (Omit<AssistantRequestPreparation, "request"> & { prepare(attempt: ServingAttempt): Revision | Promise<Revision> }) | (Omit<RequestInput, "request"> & AssistantAttemptInput)) {
  let revision: Revision | { input: AssistantAttemptInput };
  let preparedAttempt: PreparedRequestAttempt | undefined;
  let ephemeral = "prepare" in input ? undefined : input;

  /** Prepares `revision` for `attempt`: the caller's own preparation, or the ephemeral input with the route's
   *  appends. */
  async function revise(attempt: ServingAttempt): Promise<void> {
    if ("prepare" in input) {
      revision = await input.prepare(attempt);
      return;
    }
    const sent = ephemeral ?? input;
    // An ephemeral request is its own agent: it can use exactly the tools that it sends.
    const capabilities = (term: string): boolean => sent.tools?.some((tool) => tool.name === term) === true;
    ephemeral = await withEntries(attempt, sent, attempt.messagesToAppend?.(sent.messages, input.executionCwd, capabilities) ?? []);
    revision = { input: ephemeral };
  }

  /** The request that `revision` sends to the candidate `attempt`. */
  function servingRequest(attempt: ServingAttempt): PreparedServingRequest {
    const actual = revision.input;
    preparedAttempt = actual.prepareAttempt?.(attempt);
    const estimatedClasses = input.estimatedInputTokenClasses?.(attempt);
    const appendedTokens = "prepare" in input ? 0 : actual.estimatedContextTokens - input.estimatedContextTokens;
    const inputTokenClasses = estimatedClasses === undefined ? undefined : {
      ...estimatedClasses,
      uncachedInputTokens: estimatedClasses.uncachedInputTokens + appendedTokens,
    };
    const systemPrompt = preparedAttempt?.systemPrompt ?? actual.systemPrompt ?? NO_SYSTEM_PROMPT;
    const tools = preparedAttempt?.tools ?? actual.tools ?? [];
    const outputTokenLimit = attempt.totalContextLimit === undefined
      ? attempt.outputLimit
      : Math.min(attempt.outputLimit, attempt.totalContextLimit - actual.estimatedContextTokens);
    const cacheRetention = resolveCacheRetention(attempt.accessProvider, actual);
    return Object.freeze({
      attempt,
      messages: actual.messages,
      tools,
      systemPrompt,
      ...(outputTokenLimit < attempt.outputLimit ? { outputTokenLimit } : {}),
      providerOptions: input.providerOptions,
      cacheRetention,
      tokenClasses: Object.freeze({
        estimatedPromptTokens: inputTokenClasses === undefined
          ? actual.estimatedContextTokens
          : inputTokenClasses.uncachedInputTokens + inputTokenClasses.cacheTokens,
        estimatedUncachedInputTokens: inputTokenClasses?.uncachedInputTokens
          ?? actual.estimatedContextTokens,
        estimatedCacheTokens: inputTokenClasses?.cacheTokens ?? 0,
        cacheRetention,
      }),
    });
  }

  return {
    current: () => revision,
    preparedAttempt: () => preparedAttempt,
    async prepare(attempt: ServingAttempt): Promise<PreparedServingRequest> {
      await revise(attempt);
      const prepared = servingRequest(attempt);
      // The route reads the request that its client receives, so its entries follow outbound preparation.
      const entries = attempt.requestEntries?.(attemptRequest({ attempt, prepared }, revision.input, input.signal)) ?? [];
      if (entries.length === 0) return prepared;
      if (!("prepare" in input)) {
        ephemeral = await withEntries(attempt, ephemeral ?? input, entries);
        revision = { input: ephemeral };
      } else if (input.appendEntries === undefined) {
        throw new Error("a route's request entries need the owner of the request's history");
      } else {
        await input.appendEntries(entries);
        await revise(attempt);
      }
      return servingRequest(attempt);
    },
  };
}

/** Runs one admitted request. Each callback must settle actual work and close
 *  accounting before it returns. A stop ends the request without advancing
 *  candidates, and so does a failure outside the failover class: the settled
 *  attempt already records it as its outcome, and the loop surfaces that. */
export function streamAssistantTurn<T>(input: AssistantTurnRequest<T>): Promise<T>;
export function streamAssistantTurn(input: RequestInput & AssistantAttemptInput): Promise<AssistantTurnResult>;
export async function streamAssistantTurn<T>(input: AssistantTurnRequest<T> | (RequestInput & AssistantAttemptInput)): Promise<T | AssistantTurnResult> {
  const request = input.request ?? await input.client.admitRequest();
  const onEvent = input.onEvent;
  const revision = requestRevision<PreparedExecution<T>>(input);
  return request.run<T | AssistantTurnResult>({
    signal: input.signal,
    providerOptions: input.providerOptions,
    ...(input.onLoginWait === undefined ? {} : { onLoginWait: input.onLoginWait }),
    ...(onEvent === undefined ? {} : { onRetry: (retry) => onEvent(streamRetryEvent(retry)) }),
    prepare: revision.prepare,
    execute: async (candidate) => {
      // The hold sits here, where the serving route and the exact prefix are
      // known and nothing of the request has started yet. The client learns
      // the request first, so what it needs to serve it, such as the Claude
      // engine, starts while the request waits.
      const hold = candidate.prepared.cacheRetention === "none" ? undefined : input.prefixHold;
      if (hold === undefined) return executeCandidate(candidate, undefined);
      // The execution owns its anticipation's claim (ARCH-PROVIDERS-068): it releases the claim when it settles,
      // whatever the outcome, and on arrival a claim that resolves later. The request holds what it took itself.
      const claim = candidate.client.anticipate?.(attemptRequest(candidate, revision.current().input, input.signal));
      try {
        const ticket = await hold.enter(promptPrefixKey(candidate, revision.current().input.promptCacheKey), input.signal);
        try {
          return await executeCandidate(candidate, ticket);
        } finally {
          ticket.done();
        }
      } finally {
        void claim?.then((claimed) => claimed?.release());
      }
    },
  });

  async function executeCandidate(candidate: PreparedCandidate, ticket: PrefixHoldTicket | undefined): Promise<AdmittedModelRequestExecution<T | AssistantTurnResult>> {
    const current = revision.current();
    const fold = async <Value>(executionInput: Partial<ExecutionInput>, settle: (attempt: Attempt) => Promise<SettledAttempt<Value>>): Promise<AdmittedModelRequestExecution<Value>> => {
      const merged = { ...current.input, ...executionInput, cacheRetention: candidate.prepared.cacheRetention };
      const attemptInput = ticket === undefined ? merged : {
        ...merged,
        onEvent: (event: ProviderStreamEvent) => {
          if (isProviderResponseEvent(event)) ticket.responded();
          merged.onEvent(event);
        },
      };
      const attempt = createAssistantAttempt(candidate, attemptInput, revision.preparedAttempt());
      const settled = await settle(attempt);
      const failure = attempt.failure();
      if (settled.stop || attemptInput.signal?.aborted) {
        attempt.releaseIdentity();
        attemptInput.onStreamAbandoned?.(attemptInput.signal?.aborted ? "interrupted" : "retry");
        return { kind: "success", value: settled.value };
      }
      if (failure?._tag === "AuthFailure") {
        attempt.releaseIdentity();
        attemptInput.onStreamAbandoned?.("retry");
        return { kind: "login_refused", failure, value: settled.value };
      }
      if (failure && isFailoverFailure(failure)) {
        attempt.releaseIdentity();
        attemptInput.onStreamAbandoned?.("retry");
        return { kind: "provider_failure", failure };
      }
      // A failed response that no other candidate replaces still ends here.
      if (failure) attemptInput.onStreamAbandoned?.("failed");
      return { kind: "success", value: settled.value };
    };
    if ("execute" in current) return current.execute(candidate, fold);
    return fold({}, async (attempt) => {
      const value = await attempt.stream();
      await attempt.close();
      return { value, stop: value.outcome.kind === "aborted" };
    });
  }
}

/**
 * Prepares `input` as `streamAssistantTurn` prepares its first attempt, through the same admission, candidate
 * selection, construction, affordability check, connection, and preparation, and returns the candidate with the
 * request that its client would receive, without sending it (`AdmittedModelRequest.prepare`). The request carries no
 * signal: a client that anticipates it holds what it starts for the claim that it returns (`LLMClient.anticipate`).
 * Rejects as the walk does when no candidate can be prepared, and when `input.signal` aborts.
 */
export async function prepareAssistantTurn(input: Omit<AssistantRequestPreparation, "request"> & { readonly request: Pick<AdmittedModelRequest, "prepare"> }): Promise<PreparedRequest> {
  const revision = requestRevision(input);
  const candidate = await input.request.prepare({ signal: input.signal, providerOptions: input.providerOptions, prepare: revision.prepare });
  return { candidate, request: attemptRequest(candidate, revision.current().input, undefined) };
}

/** `input` with `additions` after its messages, counted into its context estimate. Redacts each addition. */
async function withEntries<Input extends AssistantAttemptInput>(attempt: ServingAttempt, input: Input, additions: readonly ConversationMessage[]): Promise<Input> {
  if (additions.length === 0) return input;
  await prepareLocalTokenizer();
  const redacted = additions.map((message) => redactMessage(message, false));
  return {
    ...input,
    messages: [...input.messages, ...redacted],
    messageCount: input.messageCount + redacted.length,
    estimatedContextTokens: input.estimatedContextTokens + estimateConversationTokens(redacted, tokenCountingPolicy(attempt.model, attempt.modelFamily, attempt.tokenizerIdentity)),
  };
}
