import { createContextTokenAnchor, type OutgoingContextSnapshot } from "./context-token-anchor.js";
import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js";
import { prepareLocalTokenizer } from "../../infra/local-tokenizer.js";
import { createStaleToolResultMasker, maskStaleForTurn, type StaleMaskSeed, type TurnStaleMasking } from "./compaction/stale-tool-result-masker.js";
import { CorruptEventRowError, type AsyncEventStateReadSurface } from "../../infra/event-store-types.js";
import { readProviderRequestAuditFact } from "../session/provider-request-audit-facts.js";
import { providerRequestIdentityFromPayload } from "../session/provider-request-audit-types.js";
import type { AgentLoopPersistence } from "./agent-loop-types.js";
import {
  createTokenCounter,
  createTokenEstimationCache,
  estimateConversationTokens,
  tokenCountingPolicy,
  type TokenCountingPolicy,
} from "./compaction/token-counter.js";
import type { AdmittedModelRequest, ConversationMessage, ModelClient, ModelRequestRoute, ServingAttempt, StreamEvent, ToolPresentation } from "./llm/types.js";
import { presentToolHistory } from "./llm/types.js";
import type { PreparedRequestAttempt, RequestToolSurfaceOwner } from "./request-tool-surface.js";
import type { ModelInteractionProfile } from "./model-interaction-profile.js";
import type { FirstPartyModuleComposition } from "../modules.js";
import type { ToolExecutionGate } from "./tools/tool-dispatch.js";
import { projectToolHistory, type ToolHistoryProjection } from "./llm/tool-history-projection.js";
import { applyContentRepairs } from "./llm/content-repair.js";

type Surface = ReturnType<RequestToolSurfaceOwner["current"]>;

export async function prepareActiveRequestVariant(input: {
  readonly surface: Surface;
  readonly client: ModelClient;
  readonly providerOptions: ProviderRequestOptions | undefined;
  readonly signal: AbortSignal | undefined;
  readonly initialInteractionProfile: ModelInteractionProfile;
  prepareCurrentPrompt(profile: ModelInteractionProfile, attempt: ServingAttempt): Promise<void>;
}): Promise<{
  readonly providerRuntime: Surface["providerRuntime"];
  readonly requestRoute: ModelRequestRoute;
  readonly requestClient: ModelClient;
  readonly interactionProfile: ModelInteractionProfile;
  readonly providerRequest: AdmittedModelRequest;
  readonly plannedAttempt: ServingAttempt;
  readonly toolExecutionGate: ToolExecutionGate | undefined;
}> {
  const providerRuntime = input.surface.providerRuntime;
  const requestRoute = providerRuntime?.mainRoute ?? modelRequestRoute(input.client, input.providerOptions);
  const requestClient = requestRoute.client;
  const interactionProfile = providerRuntime?.interactionProfile ?? input.initialInteractionProfile;
  const providerRequest = providerRuntime?.admittedRequest ?? await input.surface.admitProviderRequest(requestClient, input.signal);
  const plannedAttempt = providerRuntime?.plannedAttempt ?? await providerRequest.plannedAttempt(requestRoute.providerOptions);
  await prepareLocalTokenizer();
  await input.prepareCurrentPrompt(interactionProfile, plannedAttempt);
  const toolExecutionGate = input.surface.moduleSnapshot.gates
    .find((gate): gate is Extract<FirstPartyModuleComposition["gates"][number], { readonly seam: "toolExecution" }> => gate.seam === "toolExecution")?.gate;
  return {
    providerRuntime, requestRoute, requestClient, interactionProfile, providerRequest,
    plannedAttempt, toolExecutionGate,
  };
}

export function modelRequestRoute(
  client: ModelClient,
  providerOptions: ProviderRequestOptions | undefined,
): ModelRequestRoute {
  return { client, ...(providerOptions ? { providerOptions } : {}) };
}

/** Read the latest request decision once at loop startup. Only the current
 * branch after its last compaction can supply a reusable masking prefix.
 * `tree` is the loop's own durable tree, which the loop's storage holds. */
export async function readStaleMaskSeed(input: {
  reader?: AsyncEventStateReadSurface | undefined;
  tree?: AgentLoopPersistence["committedTree"];
  conversationId?: string | undefined;
  sessionId?: string | undefined;
  messageCount: number;
}): Promise<StaleMaskSeed | undefined> {
  const { reader, conversationId, sessionId } = input;
  if (!reader || !input.tree || !conversationId || !sessionId) return undefined;
  const tree = await input.tree();
  const currentHistory = new Set<string>();
  let leaf = tree.leafId;
  while (leaf !== null) {
    const entry = tree.entriesById[leaf];
    if (!entry || entry.kind === "compaction") break;
    currentHistory.add(leaf);
    leaf = entry.parentId;
  }
  let beforePosition: number | undefined;
  // One startup scan, paged through indexed descending reads. Other
  // conversations can share this session's request-audit aggregate.
  while (true) {
    const { facts } = await reader.readSlice({
      aggregateId: `session:${sessionId}`, types: ["prompt.assembled"],
      order: "desc", limit: 64, ...(beforePosition === undefined ? {} : { beforePosition }),
    });
    if (facts.length === 0) return undefined;
    for (const event of facts) {
      // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the narrowed durable-row Error and its identity
      if (event instanceof CorruptEventRowError) throw event;
      beforePosition = event.position;
      const fact = readProviderRequestAuditFact(event);
      if (fact.type !== "prompt.assembled") continue;
      const identity = providerRequestIdentityFromPayload(fact.payload);
      if (!("conversationId" in identity) || identity.conversationId !== conversationId) continue;
      if (fact.version !== 4 && fact.version !== 5) return undefined;
      const { treeLeafEntryId, messageCount, staleMasking } = fact.payload;
      if (treeLeafEntryId == null || !currentHistory.has(treeLeafEntryId) || messageCount > input.messageCount) continue;
      return staleMasking;
    }
  }
}

/** Owns the prepared request view, frozen masking, and the immutable usage baseline.
 * History appends refresh the active view without changing the snapshot charged by
 * the provider. A request cycle retains only its newly discarded token cost until
 * its checkpoint is compacted; earlier masks remain excluded.
 */
export function createActiveRequestContext(input: {
  messages(): ConversationMessage[];
  attempt(): ServingAttempt;
  onEvent(event: StreamEvent): void;
  initialStaleMasking?: StaleMaskSeed | undefined;
}) {
  const masker = createStaleToolResultMasker(input.initialStaleMasking);
  let restoration = input.initialStaleMasking ? { history: input.messages(), prepared: false } : undefined;
  let selected: { surface: Surface; attempt: ServingAttempt; prepared: PreparedRequestAttempt } | undefined;
  let requestContext: string | undefined;
  let removedTokens = 0;
  let cached: { history: ConversationMessage[]; length: number; mask: TurnStaleMasking; toolHistoryProjection: ToolHistoryProjection | undefined; snapshot: OutgoingContextSnapshot; messages: ConversationMessage[]; requestContext: string | undefined } | undefined;
  const estimationCache = createTokenEstimationCache();
  // Canonical appends clone content; masking and contract changes replace entries.
  // Only this history owner can safely retain provider views by source identity.
  const presentedMessages = new WeakMap<ConversationMessage, WeakMap<ToolPresentation, ConversationMessage>>();
  // An adapter stamps its turns with the model's wire id, which the candidate's attribution names.
  const attemptPolicy = (attempt: ServingAttempt) => tokenCountingPolicy(attempt.model, attempt.modelFamily, attempt.tokenizerIdentity, {
    accessProvider: attempt.accessProvider, model: attempt.candidateAttribution?.wireModelId ?? attempt.model,
  });
  let policy = attemptPolicy(input.attempt());
  let counter = createTokenCounter({ provider: input.attempt().modelFamily, tokenPolicy: policy, cache: estimationCache });

  const requestKey = (attempt: ServingAttempt, prepared: PreparedRequestAttempt): string =>
    JSON.stringify([attempt.accessProvider, attempt.model, prepared.systemPrompt, prepared.tools]);
  const activeRegistrationIds = (prepared: PreparedRequestAttempt): ReadonlyMap<string, string> =>
    new Map(prepared.auditTools.map(({ executableId, registrationId }) => [executableId, registrationId]));

  const rebuild = (mask: TurnStaleMasking, preparedOverride?: PreparedRequestAttempt): NonNullable<typeof cached> => {
    const history = input.messages();
    if (!selected) throw new Error("Select a request surface before building its history");
    const prepared = preparedOverride ?? selected.prepared;
    // Repairs follow masking, so the mask cutoff reads the unchanged history,
    // and precede projection, so lowering never sees a removed call.
    const projected = projectToolHistory({
      messages: applyContentRepairs(mask.messages),
      activeRegistrationIds: activeRegistrationIds(prepared),
      historicalRegistrationId: (message, block) => selected?.surface.historicalRegistrationId(block.name, message.model, message.provider),
    });
    const activeMessages = projected.messages;
    const messages = requestContext === undefined
      ? activeMessages
      : [...activeMessages, { kind: "user" as const, content: requestContext, requestOnly: true as const }];
    const presentation = selected.attempt.toolPresentation;
    counter.resetFor(messages.map((message) => {
      let variants = presentedMessages.get(message);
      const prior = variants?.get(presentation);
      if (prior) return prior;
      // SAFETY: presentToolHistory maps one output per input, so this singleton has exactly one result.
      const presented = presentToolHistory([message], presentation)[0]!;
      variants ??= new WeakMap();
      variants.set(presentation, presented);
      presentedMessages.set(message, variants);
      return presented;
    }));
    return {
      history, length: history.length, mask, toolHistoryProjection: projected.projection, messages, requestContext,
      snapshot: {
        messageTokens: counter.total,
        staticTokens: prepared.attemptStaticTokens,
        anchorKey: requestKey(selected.attempt, prepared),
      },
    };
  };
  const active = (): NonNullable<typeof cached> => {
    const history = input.messages();
    if (cached?.history === history && cached.length === history.length) return cached;
    const masked = masker.mask(history, 0);
    cached = rebuild(masked
      ? { messages: masked.messages, staleMasking: {
          cutoffIndex: masked.cutoffIndex, zone: masked.zone, masksApplied: masked.masksApplied, bytesSaved: masked.bytesSaved,
          maskedToolUseIds: masked.maskedToolUseIds, maskedToolUseInputIds: masked.maskedToolUseInputIds,
        } }
      : { messages: history, staleMasking: undefined });
    return cached;
  };
  const anchor = createContextTokenAnchor({ attempt: input.attempt, current: () => active().snapshot, onEvent: input.onEvent });

  function materialize(surface: Surface, attempt: ServingAttempt): void {
    const prepared = surface.prepareAttempt(attempt);
    const nextPolicy = attemptPolicy(attempt);
    if (policy.identity !== nextPolicy.identity || policy.imageTokens !== nextPolicy.imageTokens
      || policy.replayTarget?.accessProvider !== nextPolicy.replayTarget?.accessProvider || policy.replayTarget?.model !== nextPolicy.replayTarget?.model) {
      policy = nextPolicy;
      counter = createTokenCounter({ provider: attempt.modelFamily, tokenPolicy: policy, cache: estimationCache });
    }
    selected = {
      surface,
      attempt,
      prepared,
    };
    cached = undefined;
  }

  function prepare(attempt: ServingAttempt): PreparedRequestAttempt {
    if (!selected) throw new Error("Select a request surface before preparing its candidate");
    const prior = selected.attempt;
    if (prior.accessProvider !== attempt.accessProvider || prior.model !== attempt.model
      || prior.modelFamily !== attempt.modelFamily || prior.toolPresentation !== attempt.toolPresentation
      || prior.tokenizerIdentity !== attempt.tokenizerIdentity
      || prior.promptNotes?.progress !== attempt.promptNotes?.progress
      || prior.promptNotes?.modelNotes !== attempt.promptNotes?.modelNotes) {
      materialize(selected.surface, attempt);
    }
    return selected.prepared;
  }

  function advance(): void {
    // Admission and provider-candidate preparation both advance one request.
    // Neither can replace the recorded prefix during the restored cycle.
    if (restoration?.prepared && restoration.history === input.messages()) return;
    const before = active();
    const mask = maskStaleForTurn({
      masker, messages: input.messages(), estimatedContextTokens: anchor.estimate(),
      contextLimit: input.attempt().contextLimit,
    });
    if (restoration?.history === input.messages()) restoration.prepared = true;
    if (mask.staleMasking?.cutoffIndex === before.mask.staleMasking?.cutoffIndex
      && mask.staleMasking?.zone === before.mask.staleMasking?.zone) return;
    cached = rebuild(mask);
    removedTokens += before.snapshot.messageTokens - cached.snapshot.messageTokens;
  }

  function select(surface: Surface, attempt: ServingAttempt, context: string | undefined, newCycle = false): void {
    if (newCycle) removedTokens = 0;
    if (requestContext !== context) { requestContext = context; cached = undefined; }
    if (selected?.surface !== surface) {
      materialize(surface, attempt);
    } else prepare(attempt);
  }

  function appendRequestContext(context: string): void {
    requestContext = requestContext === undefined ? context : `${requestContext}\n\n${context}`;
    cached = undefined;
  }

  return {
    anchor,
    appendRequestContext,
    prepare,
    prepareCycle(surface: Surface, attempt: ServingAttempt, context: string | undefined): number {
      if (restoration?.prepared) restoration = undefined;
      select(surface, attempt, context, true);
      advance();
      return anchor.estimate();
    },
    select,
    advance,
    active,
    variant(prepared: PreparedRequestAttempt) {
      return rebuild(active().mask, prepared);
    },
    beforeCompaction: () => anchor.estimate() + removedTokens,
    prefixTokens: () => (selected?.prepared.attemptStaticTokens ?? 0)
      + (requestContext === undefined ? 0 : estimateConversationTokens([{ kind: "user", content: requestContext }], policy, estimationCache)),
    tokenPolicy: (): TokenCountingPolicy => policy,
  };
}
