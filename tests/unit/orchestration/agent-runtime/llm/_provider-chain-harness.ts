/** Fixtures shared by the provider-chain suites: the selection walk in
 *  `failover-client.test.ts`, the quota failure paths in
 *  `failover-client-failover.test.ts`, and the outage failover and
 *  sole-source last resort in `failover-client-outage.test.ts`. */

import { candidateProviderId, type AccessProviderCandidate, type AccessProviderCandidateAttribution, type AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import { expect } from "bun:test";
import { AllCandidatesExhaustedError, LlmStreamError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { createFailoverClient, createRoutingDecisions, type ProviderChainDeps } from "../../../../../src/orchestration/agent-runtime/llm/failover-client.js";
import type { ProviderAvailability, QuotaExhaustion, QuotaProbe, QuotaStanding } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js";
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type ModelClient, type ProviderStreamEvent, type StreamOptions, type AdmittedModelRequestExecution, type PreparedServingRequest, type ServingAttempt, type StagedProviderClient } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { classifyProviderFailure, isFailoverFailure, normalizeProviderAttemptFailure, type FailoverFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { testProviderSelection } from "../../../../helpers/provider-authority.js";


export interface AvailabilityScript {
  /** A standing ChatGPT suppression, as the funnel would have recorded it. */
  chatGpt?: QuotaExhaustion;
  /** Every probe claim is deferred, the way a lost or unlanded claim is. */
  probeClaimFails?: boolean;
}

/** Mirrors the owner's `SAFE_RECHECK_MS`: how long a suppression with no
 *  provider-reported reset holds before one probe may recheck. */
export const SAFE_RECHECK_MS = 5 * 60_000;

export const subscriptionCandidate = (providerId: AccessProviderId, instanceId = "test-instance"): AccessProviderCandidate => ({ kind: "subscription", providerId, instanceId, spendMode: "included" });
export const singletonCandidate = (providerId: AccessProviderId): AccessProviderCandidate => ({ kind: "singleton", providerId, spendMode: "direct_api" });
const providerId = (candidate: AccessProviderCandidate | AccessProviderId): AccessProviderId => typeof candidate === "string" ? candidate : candidateProviderId(candidate);

export function fakeAvailability(script: AvailabilityScript, nowMs = Date.now()) {
  const state = { reads: 0, projectionReads: 0, nowMs };
  const entries = new Map<AccessProviderId, QuotaExhaustion>();
  const leases = new Map<AccessProviderId, { fence: number; untilMs: number }>();
  // The service row's fold, kept apart from quota exactly as the owner keeps
  // its windows apart: an outage never rewrites what the account can pay.
  const serviceEntries = new Map<AccessProviderId, QuotaExhaustion>();
  const serviceLeases = new Map<AccessProviderId, { fence: number; untilMs: number }>();
  const livePublishes: AccessProviderId[] = [];
  const probeReleases: AccessProviderId[] = [];
  let nextFence = 0;
  // The chatgpt entry stays mutable so tests can script exhaustion and recovery between requests.
  const entryFor = (provider: AccessProviderId): QuotaExhaustion | undefined =>
    provider === "chatgpt" ? script.chatGpt : entries.get(provider);
  const clearEntry = (provider: AccessProviderId): void => {
    if (provider === "chatgpt") script.chatGpt = undefined;
    else entries.delete(provider);
  };
  // Mirrors the owner's standing fold: a suppression holds to its bound, a
  // live lease holds every other request back, then one probe is due.
  const standingOver = (
    entry: QuotaExhaustion | undefined,
    lease: { fence: number; untilMs: number } | undefined,
  ): QuotaStanding => {
    if (!entry) return { kind: "live" };
    if (entry.resetsAtMs > state.nowMs) return { kind: "suppressed", exhaustion: entry };
    if (lease && lease.untilMs > state.nowMs) return { kind: "recheck_pending", untilMs: lease.untilMs, revision: lease.fence };
    return { kind: "probe_due" };
  };
  // `reads` counts quota-standing reads only, which is what the "filtered
  // candidates are never quota-checked" assertions measure; the service gate
  // reads its own row on every candidate and is not a quota check.
  const standingFor = (provider: AccessProviderId): QuotaStanding => {
    state.reads += 1;
    return standingOver(entryFor(provider), leases.get(provider));
  };
  const availability: ProviderAvailability = {
    refreshProjection: () => { state.projectionReads += 1 },
    waitForChange: async (pending, signal) => {
      signal.throwIfAborted();
      state.nowMs = Math.max(state.nowMs, pending.untilMs);
    },
    observeChatGptRateHeaders: () => {},
    observeChatGptUsage: () => {},
    observeAnthropicRateLimit: () => {},
    // Mirrors the real funnel closely enough for the single-write-path tests:
    // a terminal ChatGPT frame lands as the account's suppression directly,
    // never through the chain's markQuotaExhausted.
    observeChatGptQuotaExhausted: (_candidate, resetsAtSeconds) => {
      const prior = script.chatGpt;
      const exhaustion = {
        exhaustedAtMs: state.nowMs,
        resetsAtMs: resetsAtSeconds === undefined ? state.nowMs + SAFE_RECHECK_MS : resetsAtSeconds * 1000,
      };
      script.chatGpt = exhaustion;
      leases.delete("chatgpt");
      return { exhaustion, newlyExhausted: prior === undefined, reportedResetAtMs: resetsAtSeconds === undefined ? undefined : resetsAtSeconds * 1000 };
    },
    chatGptStanding: (candidate) => standingFor(candidate === undefined ? "chatgpt" : providerId(candidate)),
    markQuotaExhausted: (candidate, resetsAtMs) => {
      const provider = providerId(candidate);
      const prior = entries.get(provider);
      const exhaustion = { exhaustedAtMs: state.nowMs, resetsAtMs: resetsAtMs ?? state.nowMs + SAFE_RECHECK_MS };
      entries.set(provider, exhaustion);
      leases.delete(provider);
      return { exhaustion, newlyExhausted: prior === undefined, reportedResetAtMs: resetsAtMs };
    },
    quotaExhaustion: (candidate) => {
      state.reads += 1;
      const entry = entries.get(providerId(candidate));
      if (!entry) return undefined;
      return entry.resetsAtMs <= state.nowMs ? undefined : entry;
    },
    genericQuotaStanding: (candidate) => standingFor(providerId(candidate)),
    serviceStanding: (provider) => standingOver(serviceEntries.get(provider), serviceLeases.get(provider)),
    markUnreachable: (provider) => {
      serviceEntries.set(provider, { exhaustedAtMs: state.nowMs, resetsAtMs: state.nowMs + SAFE_RECHECK_MS });
      serviceLeases.delete(provider);
    },
    markReachable: (provider) => {
      serviceEntries.delete(provider);
      serviceLeases.delete(provider);
    },
    claimQuotaProbe: (candidate): QuotaProbe | undefined => {
      if (script.probeClaimFails) return undefined;
      const provider = providerId(candidate);
      const lease = { fence: ++nextFence, untilMs: state.nowMs + 30_000 };
      leases.set(provider, lease);
      return { window: provider === "chatgpt" ? "primary" : "account", fence: lease.fence };
    },
    claimServiceProbe: (provider): QuotaProbe | undefined => {
      if (script.probeClaimFails) return undefined;
      const lease = { fence: ++nextFence, untilMs: state.nowMs + 30_000 };
      serviceLeases.set(provider, lease);
      return { window: "service", fence: lease.fence };
    },
    keepQuotaProbeAlive: () => () => {},
    markQuotaLive: (candidate, probe) => {
      const provider = providerId(candidate);
      livePublishes.push(provider);
      if (probe.window === "service") {
        if (serviceLeases.get(provider)?.fence === probe.fence) serviceLeases.delete(provider);
        serviceEntries.delete(provider);
        return true;
      }
      if (leases.get(provider)?.fence === probe.fence) leases.delete(provider);
      clearEntry(provider);
      return true;
    },
    releaseQuotaProbe: (candidate, probe) => {
      const provider = providerId(candidate);
      probeReleases.push(provider);
      if (probe.window === "service") {
        if (serviceLeases.get(provider)?.fence === probe.fence) serviceLeases.delete(provider);
        return;
      }
      if (leases.get(provider)?.fence === probe.fence) leases.delete(provider);
    },
  };
  return {
    availability,
    get reads() { return state.reads },
    get projectionReads() { return state.projectionReads },
    genericEntryCount: () => entries.size,
    serviceEntryCount: () => serviceEntries.size,
    livePublishes,
    probeReleases,
    advance: (ms: number) => { state.nowMs += ms },
  };
}

export function fakeClient(accessProvider: AccessProviderId, stream: () => AsyncGenerator<ProviderStreamEvent>): LLMClient {
  return { historyTarget: ownHistoryTarget,
    accessProvider,
    modelFamily: "openai",
    model: "gpt-5.5",
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 400_000,
    outputLimit: 64_000,
    supportsReasoning: true,
    promptNotes: { progress: "", modelNotes: "" },
    streamWithTools: stream,
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  };
}

export function textStream(text: string): () => AsyncGenerator<ProviderStreamEvent> {
  return async function* () {
    yield { kind: "text_delta", text, blockKey: "b1" };
  };
}

export function throwingStream(error: Error, before?: ProviderStreamEvent): () => AsyncGenerator<ProviderStreamEvent> {
  return async function* () {
    if (before) yield before;
    throw error;
  };
}

/** An outage error shaped the way real adapters produce one: the classified
 *  stream failure wraps the wire error it observed as `cause`, and that error
 *  carries the HTTP status the provider stated, which is the positive
 *  attribution a durable suppression requires. A bare LlmStreamError models
 *  an adapter inference from silence, which advances the walk but marks
 *  nothing. */
export function providerOutageError(message: string, kind: LlmStreamError["kind"] = "transient"): LlmStreamError {
  return new LlmStreamError(message, kind, undefined, { cause: Object.assign(new Error(message), { status: 502 }) });
}

/** Asserts that `error` is the chain's exhaustion and that its recovery rechecks one safe interval after it was
 *  thrown, which `before` and the moment of this call bound: the bound of a spent route no shared gate holds. */
export function expectSafeRecheck(error: unknown, before: number): void {
  if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected AllCandidatesExhaustedError");
  if (error.recovery.kind !== "at") throw new Error(`expected a recovery bound, got ${error.recovery.kind}`);
  expect(error.recovery.atMs).toBeGreaterThanOrEqual(before + SAFE_RECHECK_MS);
  expect(error.recovery.atMs).toBeLessThanOrEqual(Date.now() + SAFE_RECHECK_MS);
}

/** Records every backoff the walk asks for and returns at once, so a suite
 *  can assert the schedule without waiting through it. */
export function sleepRecorder() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number): Promise<void> => { delays.push(ms); },
  };
}

export const streamOptions: StreamOptions = { messages: [], tools: [], systemPrompt: stableSystemPrompt("s") };
export const preparedRequest = (attempt: ServingAttempt, options: StreamOptions = streamOptions): PreparedServingRequest => Object.freeze({
  attempt,
  messages: options.messages,
  tools: options.tools,
  systemPrompt: options.systemPrompt,
  providerOptions: options.providerOptions,
  cacheRetention: options.cacheRetention,
  tokenClasses: Object.freeze({ estimatedPromptTokens: options.estimatedContextTokens, cacheRetention: options.cacheRetention }),
});

export async function collect(stream: AsyncGenerator<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

export function textDelta(text: string): ProviderStreamEvent {
  return { kind: "text_delta", text, blockKey: "b1" };
}

/** Chain under test. Defaults to the two-candidate openai chain whose fake
 * clients stream their own provider id, so assertions read who served. */
export function chain(deps: Omit<Partial<ProviderChainDeps>, "build"> & { readonly availability: ProviderAvailability; readonly candidates?: readonly (AccessProviderCandidate | AccessProviderId)[]; readonly build?: (provider: AccessProviderId, attribution: AccessProviderCandidateAttribution) => Promise<LLMClient | StagedProviderClient> }): ModelClient {
  const build = deps.build ?? (async (provider: AccessProviderId) => fakeClient(provider, textStream(provider)));
  const candidates = (deps.candidates ?? [subscriptionCandidate("chatgpt"), singletonCandidate("openai_api")])
    .map((candidate) => typeof candidate === "string" ? singletonCandidate(candidate) : candidate);
  const suppliedAttributions = deps.candidateAttributions ?? candidates.map((candidate) => ({ candidate, wireModelId: "gpt-5.5", dataUse: "standard" as const }));
  const candidateAttributions = () => {
    const current = typeof suppliedAttributions === "function" ? suppliedAttributions() : suppliedAttributions;
    return current;
  };
  return createFailoverClient({
    model: "gpt-5.5",
    family: "openai",
    shortName: testProviderSelection().shortName,
    // The walk's backoff is real time in production; a suite that does not
    // assert the schedule must not wait through it.
    sleep: async () => {},
    routing: createRoutingDecisions(),
    ...deps,
    candidateAttributions,
    build: async (attribution) => {
      const candidate = attribution.candidate;
      const built = await build(candidateProviderId(candidate), attribution);
      const described = "attempt" in built ? built.attempt : built;
      const credentialLineage = deps.credentialLineage?.(candidate)
        ?? (candidate.kind === "subscription" ? candidate.instanceId : undefined);
      const attempt = Object.freeze({
        ...described,
        candidateAttribution: attribution,
        accessProviderCandidate: attribution.candidate,
        ...(attribution.catalogProvenance === undefined ? {} : { catalogProvenance: attribution.catalogProvenance }),
        ...(credentialLineage === undefined ? {} : { credentialLineage }),
      });
      return Object.freeze({
        attempt,
        connect: async () => {
          const connected = "attempt" in built ? await built.connect() : built;
          return Object.freeze({ ...attempt, historyTarget: connected.historyTarget.bind(connected), streamWithTools: connected.streamWithTools.bind(connected) });
        },
      });
    },
  });
}

/** Provider that served one request, read from the stream the fake emits. */
export async function served(client: ModelClient): Promise<string> {
  const events = await run(client);
  const first = events[0];
  if (first?.kind !== "text_delta") throw new Error("expected the served provider's text");
  return first.text;
}

export async function run(client: ModelClient): Promise<ProviderStreamEvent[]> {
  return requestEvents(client, streamOptions);
}

/** Mirrors the production fold: only a failure the chain may advance on is
 *  handed back as `provider_failure`; every other failure leaves the chain
 *  under its own name, the way the loop surfaces a settled stream error. */
export async function executeStream(client: LLMClient, options: StreamOptions): Promise<AdmittedModelRequestExecution<ProviderStreamEvent[]>> {
  try {
    return { kind: "success", value: await collect(client.streamWithTools(options)) };
  } catch (error) {
    if (options.signal?.aborted || error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) throw error;
    const normalized = normalizeProviderAttemptFailure(error);
    if (!isFailoverFailure(normalized.failure)) throw normalized;
    return { kind: "provider_failure", failure: normalized.failure };
  }
}

export async function requestEvents(client: ModelClient, options: StreamOptions = streamOptions): Promise<ProviderStreamEvent[]> {
  const request = await client.admitRequest();
  return request.run<ProviderStreamEvent[]>({
    signal: options.signal,
    providerOptions: options.providerOptions,
    prepare: preparedRequest,
    execute: ({ client: adapter }) => executeStream(adapter, options),
  });
}

/** Classifies an error the chain must advance on. A test that hands the chain
 *  anything else has misread the contract, so this fails loudly. */
export function failoverFailure(error: unknown): FailoverFailure {
  const failure = classifyProviderFailure(error);
  if (!isFailoverFailure(failure)) throw new Error(`${failure._tag} never advances the failover chain`);
  return failure;
}

export async function runAdmitted(client: ModelClient, visits: AccessProviderId[], fail: readonly AccessProviderId[] = []): Promise<AccessProviderId> {
  const request = await client.admitRequest();
  return request.run<AccessProviderId>({
    prepare: preparedRequest,
    execute: async ({ attempt }) => {
      visits.push(attempt.accessProvider);
      return fail.includes(attempt.accessProvider)
        ? { kind: "provider_failure", failure: failoverFailure(Object.assign(new Error("failed"), { status: 503 })) }
        : { kind: "success", value: attempt.accessProvider };
    },
  });
}
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { ownHistoryTarget } from "../_model-client.js";
