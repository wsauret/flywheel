/**
 * The one owner of the bytes of a run's request (`openRequestPreparation`), and `prepareRunRequest`, which a
 * pre-start calls to obtain the request that the run's next send would make without sending it. A send's loop and a
 * pre-start run the same preparation and differ only in the walk mode, so a pre-start's request equals the send's
 * byte for byte when the send's last message is the one the pre-start used.
 */

import { randomUUID } from "node:crypto";
import type { CapabilityCheck } from "../../infra/capability-text.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../../infra/llm/models.js";
import { prepareLocalTokenizer } from "../../infra/local-tokenizer.js";
import type { ProjectDefinitionRegistry } from "../../workflows/definition-registry.js";
import type { AgentLoopOptions, HistorySink } from "./agent-loop-types.js";
import { appendEntries, appendProviderHistory, createLoopMessageWriters } from "./agent-loop-history.js";
import { createActiveRequestContext, prepareActiveRequestVariant, readStaleMaskSeed } from "./active-request-context.js";
import type { OutgoingContextSnapshot } from "./context-token-anchor.js";
import { prepareAssistantTurn, type PreparedRequest } from "./assistant-turn-stream.js";
import type { AssistantAttemptInput, ImageLimitCutRecord } from "./assistant-turn-attempt.js";
import type { CaptureModelRuntime } from "./factory.js";
import type { ConversationMessage, ServingAttempt } from "./llm/types.js";
import { resolveModelInteractionProfile, type ModelInteractionProfile } from "./model-interaction-profile.js";
import type { ProviderSession } from "./provider-runtime-cache.js";
import type { RequestToolSurfaceOwner } from "./request-tool-surface.js";
import { openRequestInputs, planRunCapabilities, type RequestInputs } from "./request-inputs.js";
import { resolveRuntimeConversation } from "./runtime-conversation.js";
import type { Agent, AgentOptions, RunnableAgentOptions } from "./types.js";

type ResolvedSurface = Awaited<ReturnType<RequestToolSurfaceOwner["resolve"]>>;

/** The message that a pre-start plans in place of the person's next one when none is queued. A provider that
 *  anticipates the request starts what the request needs from the conversation before it; the message itself is never
 *  sent. */
const NEXT_MESSAGE = "(next message)";

/** Builds the stable system prompt of the request that `surface` plans, for `attempt` and `profile`. */
export function prepareRequestPrompt(
  inputs: Pick<AgentLoopOptions, "tools" | "systemPrompt" | "literalSystemPrompt">,
  profile: ModelInteractionProfile,
  attempt: ServingAttempt,
): ReturnType<ReturnType<RequestToolSurfaceOwner["current"]>["prepareStablePrompt"]> {
  const { systemPrompt } = inputs;
  return inputs.tools.current().prepareStablePrompt(
    () => typeof systemPrompt === "function" ? systemPrompt(attempt, profile) : systemPrompt,
    profile,
    inputs.literalSystemPrompt === true,
  );
}

/** Where a preparation's history goes and whom it tells: a send's durable history and transcript, or nothing for a
 *  pre-start, whose history is an in-memory draft. */
export interface RequestPreparationSinks {
  readonly history: HistorySink;
  readonly onUserMessage: AgentLoopOptions["onUserMessage"];
  readonly onSystemMessage: AgentLoopOptions["onSystemMessage"];
  readonly onEvent: AgentLoopOptions["onEvent"];
  readonly flush: (() => Promise<void>) | undefined;
  readonly assistantContentCommitted: (visible: boolean) => void;
  /** Whether a request appends the route's messages and the turn reminders. A send stops them once its handoff
   *  starts; a pre-start always appends them. */
  readonly admitsProviderMessages?: () => boolean;
}

/** What a request's attempt input carries that its candidate and history do not decide. */
type AttemptValues = Omit<AssistantAttemptInput,
  "messages" | "prepareAttempt" | "staleMasking" | "toolHistoryProjection" | "requestContext" | "messageCount" | "estimatedContextTokens" | "imageLimitCut">;

/**
 * The one preparation of a run's requests (R5): the only code that builds request bytes. A send's loop and a
 * pre-start (`prepareRequest`) both open it on the run's request inputs and build every request through it: the
 * history and its writers, the planned serving attempt, the request context with its stale-masking seed, each
 * request cycle (`openCycle`), and the closure that prepares the request for each candidate of the walk
 * (`attemptInput`). Only the walk differs: a send serves (`streamAssistantTurn`), a pre-start prepares
 * (`prepareAssistantTurn`).
 */
export async function openRequestPreparation(inputs: RequestInputs, sinks: RequestPreparationSinks) {
  const { client, executionCwd } = inputs;
  const admits = sinks.admitsProviderMessages ?? (() => true);
  const messages: ConversationMessage[] = inputs.seed.kind === "fresh" ? [] : [...inputs.seed.priorMessages];
  const preparation = {
    /** The request's history. A compaction replaces it. */
    messages,
    /** The serving attempt of the request that the loop prepares now. The runner's initial client supplies model
     *  metadata before the first request; every request replaces it from its captured composition. */
    planned: inputs.initialPlannedAttempt ?? await client.plannedAttempt(inputs.providerOptions),
    initialInteractionProfile: inputs.initialInteractionProfile ?? resolveModelInteractionProfile(client.model, client.modelFamily),
    /** The image-limit cut that the run's requests last recorded, which every attempt of every request advances. */
    imageLimitCut: { replaced: 0 } satisfies ImageLimitCutRecord,
  };
  const writers = createLoopMessageWriters({
    messages: () => preparation.messages, history: sinks.history, onUserMessage: sinks.onUserMessage, onSystemMessage: sinks.onSystemMessage,
    assistantContentCommitted: sinks.assistantContentCommitted,
  });
  const requestContext = createActiveRequestContext({
    messages: () => preparation.messages, attempt: () => preparation.planned, onEvent: sinks.onEvent,
    initialStaleMasking: await readStaleMaskSeed({
      reader: inputs.sessionEventReader ?? inputs.sessionEventStore, tree: inputs.persistence.committedTree,
      conversationId: inputs.conversationId, sessionId: inputs.sessionId, messageCount: preparation.messages.length,
    }),
  });
  const entryWriter = { append: writers.pushMessage, onUserMessage: sinks.onUserMessage, flush: sinks.flush };
  const appendProviderMessages = async (attempt: ServingAttempt): Promise<void> => {
    if (admits()) await appendProviderHistory({ ...entryWriter, attempt, messages: preparation.messages, executionCwd, capabilities: inputs.tools.current().capabilities, turnReminders: inputs.turnReminders });
  };
  /** Plans the provider variant of a request on `surface`; its planned attempt becomes `planned`. */
  const prepareVariant = (surface: ResolvedSurface, signal: AbortSignal | undefined) => prepareActiveRequestVariant({
    surface, client, providerOptions: inputs.providerOptions, signal, initialInteractionProfile: preparation.initialInteractionProfile,
    prepareCurrentPrompt: async (profile, attempt) => {
      preparation.planned = attempt;
      await prepareRequestPrompt(inputs, profile, attempt);
    },
  });
  return Object.assign(preparation, {
    ...writers,
    requestContext,
    appendProviderMessages,
    appendRequestEntries: (entries: readonly ConversationMessage[]) => appendEntries(entryWriter, entries),
    prepareVariant,
    /**
     * Opens one request cycle on `surface`: plans the request's provider variant, reads the cycle's effort, appends the
     * route's messages and the turn reminders to the history, and selects the request context. Returns the variant
     * with the effort and the cycle's estimated context tokens.
     */
    async openCycle(cycle: {
      readonly surface: ResolvedSurface;
      readonly signal: AbortSignal | undefined;
      /** The cycle's request context before the request takes it, and the take. */
      readonly context: { readonly preview: string | undefined; readonly consume: () => string | undefined };
    }) {
      const variant = await prepareVariant(cycle.surface, cycle.signal);
      // The effort is read once per cycle: the appends read it, and so does each attempt of the cycle's request.
      const providerRole = variant.providerRuntime?.role;
      const turnEffort: ReasoningEffort | undefined = providerRole
        ? REASONING_EFFORTS.find((effort) => effort === providerRole.effort)
        : inputs.reasoningEffort ? await inputs.reasoningEffort() : undefined;
      await appendProviderMessages(variant.plannedAttempt);
      requestContext.select(cycle.surface, variant.plannedAttempt, cycle.context.preview);
      const contextTokens = requestContext.prepareCycle(cycle.surface, variant.plannedAttempt, cycle.context.consume());
      return { ...variant, turnEffort, contextTokens };
    },
    /**
     * The closure that prepares a request for each candidate of its walk: it selects the candidate, appends the
     * route's messages, advances the request context, and returns the attempt input with the outgoing snapshot that
     * its token accounting reads.
     */
    attemptInput(values: AttemptValues): (attempt: ServingAttempt) => Promise<{ readonly input: AssistantAttemptInput; readonly snapshot: OutgoingContextSnapshot }> {
      return async (attempt) => {
        preparation.planned = attempt;
        await appendProviderMessages(attempt);
        requestContext.prepare(attempt);
        requestContext.advance();
        const outbound = requestContext.active();
        return {
          snapshot: outbound.snapshot,
          input: {
            ...values,
            messages: outbound.messages, prepareAttempt: requestContext.prepare,
            staleMasking: outbound.mask.staleMasking, toolHistoryProjection: outbound.toolHistoryProjection,
            requestContext: outbound.requestContext, imageLimitCut: preparation.imageLimitCut,
            messageCount: outbound.messages.length, estimatedContextTokens: requestContext.anchor.estimate(),
          },
        };
      };
    },
  });
}

/** A prepared request whose last message stands in for one that the person has not written yet. */
export interface AnticipatedRequest extends PreparedRequest {
  readonly nextMessage?: "unknown";
}

/** What a pre-start knows of the request it prepares: the person's queued next message, if any, and its stop. */
interface RequestPreparation {
  readonly nextMessage?: string;
  readonly signal: AbortSignal;
}

/**
 * Prepares the first request that a send of `inputs` would make after `nextMessage`, through the send's setup, its
 * prepare closure, and the walk's `prepares` mode, and returns the candidate with that request. The history, the
 * route's messages, the turn reminders, and the request context are written to an in-memory draft only: it sends no
 * model request, claims no recheck lease, records no routing choice, and writes no durable fact. Without a
 * `nextMessage` the draft ends with a placeholder and the result is marked `nextMessage: "unknown"`. Rejects when
 * `signal` aborts and when no candidate can be prepared.
 */
async function prepareRequest(inputs: RequestInputs, preparation: RequestPreparation): Promise<AnticipatedRequest> {
  await prepareLocalTokenizer();
  const { executionCwd } = inputs;
  const { signal } = preparation;
  // The person's message ends the history, as the send's history holds it once the chat commits it.
  const nextMessage: ConversationMessage = { kind: "user", content: preparation.nextMessage ?? NEXT_MESSAGE, origin: "human" };
  const draft = await openRequestPreparation(
    { ...inputs, seed: { kind: "resume", priorMessages: [...inputs.seed.kind === "fresh" ? [] : inputs.seed.priorMessages, nextMessage] } },
    { history: { append: () => {} }, onUserMessage: undefined, onSystemMessage: undefined, onEvent: () => {}, flush: undefined, assistantContentCommitted: () => {} },
  );
  const surface = await inputs.tools.resolve();
  const cycle = await draft.openCycle({
    surface, signal, context: { preview: inputs.initialRequestContext, consume: () => inputs.initialRequestContext },
  });
  const prepareInput = draft.attemptInput({
    interactionProfile: cycle.interactionProfile, reasoningEffort: cycle.turnEffort, signal,
    cacheRetention: inputs.cacheRetention ?? "1h", providerSessionKey: inputs.providerSessionKey, promptCacheKey: inputs.promptCacheKey,
    cacheRetentionPolicies: surface.runtimeConfig.cacheRetentionPolicies, providerOptions: cycle.requestRoute.providerOptions,
    requestAudit: undefined, onEvent: () => {}, turn: 1,
  });
  const prepared = await prepareAssistantTurn({
    client: cycle.requestClient, request: cycle.providerRequest, executionCwd, signal,
    providerOptions: cycle.requestRoute.providerOptions,
    estimatedInputTokenClasses: () => draft.requestContext.anchor.estimateInputTokenClasses(),
    appendEntries: draft.appendRequestEntries,
    prepare: async (attempt) => ({ input: (await prepareInput(attempt)).input }),
  });
  return preparation.nextMessage === undefined ? { ...prepared, nextMessage: "unknown" } : prepared;
}

/** The options of a run whose requests take a session's provider runtime (`AgentBaseOptions.providerSession`). */
type SessionRunOptions<Options extends AgentOptions> = Options & { readonly providerSession: ProviderSession };

/** What a session's pre-start gives the preparation beside the run's options: the next message and the stop, and the
 *  history of the run's conversation when its owner reads it only for a pre-start that prepares. That history then
 *  replaces the seed of `options.conversation`. */
interface PrestartPreparation extends RequestPreparation {
  readonly readHistory?: () => Promise<readonly ConversationMessage[]>;
}

/** Prepares the next request of the run that `options` describe, as the run's next send would make it, without
 *  building its Agent (`prepareRunRequest`). Resolves undefined when the run's planned route anticipates no request.
 *  The agent factory provides it beside `AgentFactory`. */
export type RequestPreparer = (options: SessionRunOptions<AgentOptions>, preparation: PrestartPreparation) => Promise<AnticipatedRequest | undefined>;

/** What `prepareRunRequest` builds the request of a run from: the run's options and the authorities that build its
 *  runs, as the agent factory holds them. */
interface RunRequestPreparation extends PrestartPreparation {
  readonly options: SessionRunOptions<RunnableAgentOptions>;
  readonly definitions: ProjectDefinitionRegistry;
  readonly captureModelRuntime: CaptureModelRuntime;
  readonly createRunner: (options: RunnableAgentOptions) => Agent;
}

/**
 * Prepares the next request of the run that `options` describe (`prepareRequest`) without building its Agent or its
 * turn resources. The request's provider lifetime is the session's (`options.providerSession`), so a tree-hosted
 * preparation's hold of its chat tree's shared state lasts until the session's owner closes that provider session,
 * and the host that the request anticipates finds the tree that every later run of the session takes. The module
 * runtimes that its tool plan creates live only as long as the returned request. A pre-start whose route anticipates
 * no request resolves undefined once the session's client resolved, before it reads the environment, the history, the
 * tools, or the prompt.
 */
export async function prepareRunRequest(input: RunRequestPreparation): Promise<AnticipatedRequest | undefined> {
  const opened = await openRunRequestInputs(input);
  if (opened.planned.anticipatesRequests !== true) return undefined;
  const { request } = await opened.build();
  return await prepareRequest(request, input);
}

/** Answers the agent check of the first request of the run that `options` describe (ARCH-CONTEXT-033), as that
 *  request plans its tools, with no model route (`planRunCapabilities`). The text that only this run's agent reads,
 *  such as a workflow agent's opening turn or a skill method that a command commits to its chat, renders from it. It
 *  builds no Agent, never waits for model access, sends no request, and writes no fact. */
export type CapabilityPlanner = (options: AgentOptions) => Promise<CapabilityCheck>;

/** The authorities that build the runs of an agent factory, with the options of one run. */
type RunSource = Pick<RunRequestPreparation, "definitions" | "captureModelRuntime" | "createRunner"> & { readonly options: RunnableAgentOptions };

/** The conversation and personas of a run that builds no Agent, as its Agent would resolve them. */
function runConversationSource(input: RunSource) {
  const { options } = input;
  const id = randomUUID();
  return {
    options, definitions: input.definitions,
    conversation: resolveRuntimeConversation(options.conversation, {
      providerSessionKey: `agent-${id}`, artifactScopeId: `artifact-${id}`, retrievalSessionId: `retrieval-${id}`,
    }),
    personas: options.agentRegistry ?? input.definitions.personas(),
    captureModelRuntime: input.captureModelRuntime, createRunner: input.createRunner,
  };
}

/** `CapabilityPlanner` over the authorities that build the run's requests. */
export function planCapabilitiesOfRun(input: RunSource): Promise<CapabilityCheck> {
  return planRunCapabilities(runConversationSource(input));
}

async function openRunRequestInputs(input: RunRequestPreparation): ReturnType<typeof openRequestInputs> {
  const { options, readHistory } = input;
  const provider = options.providerSession;
  const source = runConversationSource(input);
  const resolved = source.conversation;
  const conversation = readHistory === undefined ? resolved : { ...resolved, seed: async () => ({ kind: "resume" as const, priorMessages: [...await readHistory()] }) };
  return await openRequestInputs({
    ...source, conversation,
    providerRuntimeCache: provider.cache,
    providerSessionLifetime: {
      providerSessionKey: conversation.providerSessionKey, scope: provider.scope,
      ...(provider.demand === undefined ? {} : { demand: provider.demand }),
    },
  }, { kind: "prestart", signal: input.signal });
}
