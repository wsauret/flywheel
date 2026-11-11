/**
 * Access-provider chain for a model client. Every client the factory builds
 * is a chain client; a single-candidate family degenerates to a chain of one.
 *
 * Selection walks authorized candidates in canonical spend-class order.
 * A candidate is skipped or left behind only when it cannot serve the request
 * for its own reasons: spent quota, throttling, saturation, or an outage
 * (`FailoverFailure`). A failure the request or the account caused would
 * repeat on every candidate, so it never reaches the walk; the attempt that
 * met it settles the request under that failure's own name.
 *
 * One client serves many requests, and availability is account state that
 * other sessions and workers spend too, so provider selection is
 * request-local: nothing is read, polled, built, or rejected when the client
 * is created. Every request resolves from the head of the chain against the
 * availability owner immediately before its own I/O, and the provider that
 * wins prepares the request it serves. A spent provider serves no further
 * request until its suppression's bound passes; after that, recovery is one
 * probe per fleet: the request that claims the row's lease serves as the
 * recheck, its successful settlement commits the provider live for every
 * process, and every other request keeps holding back until then.
 *
 * A candidate is judged only on account state this process could actually
 * read. When the availability owner cannot coordinate - an authority it
 * cannot read, or a meter lease it cannot claim - the request rejects with
 * `QuotaCoordinationError` before any adapter is built, so no provider is
 * sent a request the other processes are not metering.
 *
 * A candidate that throttles, saturates, or loses the connection is retried
 * in place with bounded backoff before the walk leaves it: a dropped socket
 * is seconds of waiting, not a lost turn. The walk reports each retry to the
 * request so the session can show the reconnect, and advances only when the
 * candidate's retries are spent.
 *
 * Provider selection and failover are silent. They are implementation details of
 * the request, while audit records retain the provider used by each attempt.
 * The diagnostics record a routing decision when it changes, not per
 * request: the first request that skips a candidate or fails over records
 * the candidate it chose and why each earlier one was passed, the first that
 * no candidate can serve records why each was refused, and the first that
 * its first candidate serves again records that the route is restored.
 *
 * Classification also decides durable availability evidence: a spent
 * candidate whose last failure the provider itself stated marks the
 * provider, a spent quota marks the account, and nothing else writes. A
 * lost connection never marks. Local failures, aborts, and coordination
 * failures stop the request.
 */

import { abortableSleep } from "../../../infra/abort.js";
import { accessProviderAccountKey, accessProviderCandidateKey, candidateProviderId, type AccessProviderCandidate, type AccessProviderCandidateAttribution, type AccessProviderId, type LoginWaitAnswer } from "../../../infra/llm/access-provider.js";
import type { ModelFamily } from "../../../infra/llm/model-family.js";
import { errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import { exhaustedProvidersCopy, exhaustedProvidersRecovery, extractProviderErrorDetail, waitingClears, type CapacityHold, type CapacityReset, type ProviderUnavailableCause } from "../../../infra/llm/provider-error-copy.js";
import { summarizeProviderError } from "../../../infra/llm/provider-error-diagnostic.js";
import { providerOptionsUnservableReason, type ProviderRequestOptions } from "../../../infra/llm/provider-options.js";
import { AllCandidatesExhaustedError, ModelAccessRefusedError, QuotaExhaustedError, StreamIdleTimeoutError, SUBSCRIPTION_PAID_REVIEW_DETAIL } from "./errors.js";
import type { ModelRefusal } from "../../../infra/auth/provider-model-catalog-store.js";
import { ThinkingStallError } from "./thinking-stall.js";
import type { AuthStoreCondition } from "../../../infra/auth/auth-store.js";
import { isFailoverFailure, isProviderAttributedFailure, ProviderAttemptFailure, type FailoverFailure } from "./provider-failure.js";
import { SAFE_RECHECK_MS } from "./provider-availability.js";
import type { ProviderAvailability, QuotaExhaustion, QuotaProbe, RecheckPending, RequestAdmission, SubscriptionAllowanceResolver, SubscriptionBankedResetResolver, SubscriptionSpendAuthorizationResolver } from "./provider-availability-types.js";
import type {
  LLMClient,
  ModelClient,
  AdmittedModelRequestPreparation,
  AdmittedModelRequestRun,
  PreparedCandidate,
  ServingAttempt,
  PreparedServingRequest,
  RepetitionGuard,
  StagedProviderClient,

} from "./types.js";
import type { ProviderAffordabilityCapability } from "./provider-affordability.js";


export interface ProviderChainDeps {
  /** Normalized model name, as the adapters receive it. */
  readonly model: string;
  readonly family: ModelFamily;
  /** Immutable candidate order captured by the request admission owner. */
  readonly candidateAttributions: readonly AccessProviderCandidateAttribution[] | (() => readonly AccessProviderCandidateAttribution[]);
  /** The account key (`accessProviderAccountKey`) that each request tries first among its provider's accounts in one
   *  spend mode, read when the request captures its candidates: the login of the chat tree's live shared host
   *  (`SharedTree.login`). In included use a sooner expiring-window reset still goes first, so the login only breaks
   *  ties. Within that order the walk's eligibility and failover decide when the request leaves the login. */
  readonly preferredAccount?: () => string | undefined;
  readonly build: (attribution: AccessProviderCandidateAttribution) => Promise<StagedProviderClient>;
  readonly affordability?: ReadonlyMap<AccessProviderId, ProviderAffordabilityCapability>;
  readonly requestAdmission?: RequestAdmission;
  readonly shortName?: (provider: AccessProviderId) => string;
  /** The availability owner bound to the accounts this client's credentials
   *  name. Selection and every observation this chain makes target those
   *  accounts, so a second client on other credentials shares none of it. */
  readonly availability: ProviderAvailability;
  /** Profile-local Copilot ceiling. Provider observations own allowance classification and use. */
  /** Current provider-native Copilot allowance captured for each exact account. */
  readonly subscriptionAllowanceFor?: SubscriptionAllowanceResolver;
  /** Exact, immutable accepted-envelope lookup captured before this chain was admitted. */
  readonly subscriptionSpendAuthorizationFor?: SubscriptionSpendAuthorizationResolver;
  readonly credentialLineage?: (candidate: AccessProviderCandidate) => string | undefined;
  /** Secret-free storage conditions captured with this request's credentials. */
  readonly conditions?: readonly AuthStoreCondition[];
  /** Publishes a strict mutation refusal only after its provider attempt settles. */
  readonly observeAuthConditions?: (conditions: readonly AuthStoreCondition[]) => void;
  /** Records that a candidate's account refused the model or its extended window. It returns at once and never
   *  fails: the walk moves to the next candidate without waiting for the record. */
  readonly recordModelRefusal?: (attribution: AccessProviderCandidateAttribution, refusal: ModelRefusal) => void;
  /** Interactive compositions wait for this exact account's login. Headless callers omit it. */
  readonly awaitLogin?: (candidate: AccessProviderCandidate, signal: AbortSignal) => Promise<LoginWaitAnswer>;
  /** The wait between in-place retries. Injectable so a suite asserts the
   *  schedule without living through it. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The routing decisions of every request the admitted client makes, held
   *  with the client so a decision records when it changes, not per request. */
  readonly routing: RoutingDecisions;
}

/** In-place retries one candidate gets before the walk gives up on it. Four
 *  attempts in a row is the corroboration one request can offer: a dropped
 *  socket costs seconds, and only a failure that outlasts every retry can
 *  leave a mark that holds other sessions back. */
const CANDIDATE_RETRY_LIMIT = 3;
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_MAX_MS = 30_000;
/** A provider-declared backoff is honored as stated, up to this bound. */
const RETRY_AFTER_MAX_MS = 60_000;
/** Fresh samples one model response gets after its reasoning repeated itself. The attempt after the last resample
 *  runs without reasoning and without detection, so a response is never stopped more than this many times and a
 *  model that keeps looping cannot loop without bound on the attempt that is accepted. */
const REPETITION_RESAMPLE_LIMIT = 2;

function repetitionGuard(resamples: number): RepetitionGuard {
  return resamples < REPETITION_RESAMPLE_LIMIT ? "detect" : "reasoning_off";
}

/** How long retry number `retry` waits: the provider's own backoff when it
 *  declared one, else exponential from one second with jitter so concurrent
 *  sessions do not retry in lockstep. */
function retryDelayMs(retry: number, failure: FailoverFailure): number {
  if ("retryAfterMs" in failure && typeof failure.retryAfterMs === "number") return Math.min(failure.retryAfterMs, RETRY_AFTER_MAX_MS);
  const base = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (retry - 1), RETRY_BACKOFF_MAX_MS);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/** What the availability owner states about one provider's ability to pay for
 *  the next request. `detail` states the cap or reset in user-facing words
 *  and never carries a credential; `reset` is the machine-readable moment the
 *  candidate can serve again and what held it when the walk passed it, so the
 *  terminal error can name the earliest recovery across the whole chain. `probe`
 *  marks the request as the fleet's one recheck of a provider whose
 *  suppression bound passed: the request must conclude it. */
type QuotaState =
  | { readonly available: true; readonly probe?: QuotaProbe; readonly probeDue?: true }
  | UnavailableState
  | { readonly available: false; readonly kind: "pending"; readonly pending: RecheckPending };

const UNMETERED: QuotaState = { available: true };

type UnavailableState = {
  readonly available: false;
  readonly kind: "terminal";
  readonly reason: "quota" | "unavailable" | "ineligible" | FailoverFailure;
  readonly detail: string;
  readonly reset: CapacityReset | undefined;
};

/** The reset of an exhaustion that a shared gate holds. */
function resetOf(exhaustion: QuotaExhaustion): CapacityReset {
  return { atMs: exhaustion.resetsAtMs, hold: exhaustion.hold };
}

const log = Log.create({ service: "provider-failover" });

interface PassedCandidate {
  readonly provider: AccessProviderId;
  readonly reason: string;
}

/** Where one serving walk ended: the candidate it chose after passing
 *  others, the first candidate with none passed, or a refusal. */
type RoutingDecision =
  | { readonly kind: "served"; readonly model: string; readonly chosen: AccessProviderId; readonly passed: readonly PassedCandidate[] }
  | { readonly kind: "refused"; readonly model: string; readonly passed: readonly PassedCandidate[] };

/** The routing decisions of one admitted client's requests. */
export interface RoutingDecisions {
  record(decision: RoutingDecision): void;
}

/** The identity of a decision: the model, the chosen candidate, and the set
 *  of passed candidates with their reasons, in any order. */
function routingKey(decision: RoutingDecision): string {
  const passed = decision.passed.map(({ provider, reason }) => `${provider}\0${reason}`).toSorted();
  return JSON.stringify([decision.model, decision.kind === "served" ? decision.chosen : null, passed]);
}

/** Records a routing decision only when it differs from the last one. A
 *  standing condition, such as a spent quota or an unaffordable candidate,
 *  passes a candidate on every request while it lasts; the change is the
 *  decision, and each request that repeats it is DEBUG. A request its first
 *  candidate serves records only when it ends a reroute or a refusal, with
 *  how many requests the ended decision covered. */
export function createRoutingDecisions(): RoutingDecisions {
  let last: { readonly key: string; requests: number } | undefined;
  return {
    record(decision) {
      const key = routingKey(decision);
      const fields = { model: decision.model, ...(decision.kind === "served" ? { chosen: decision.chosen } : {}), passed: decision.passed };
      if (last?.key === key) {
        last.requests += 1;
        log.debug("provider request routed as before", fields);
        return;
      }
      const previousRequests = last?.requests;
      last = { key, requests: 1 };
      if (decision.kind === "refused") log.warn("provider request refused", fields);
      else if (decision.passed.length > 0) log.info("provider request rerouted", fields);
      else if (previousRequests !== undefined) log.info("provider request routing restored", { model: decision.model, chosen: decision.chosen, previousRequests });
    },
  };
}

function passedCandidates(skipped: readonly SkippedCandidate[]): PassedCandidate[] {
  return skipped.map((entry) => ({ provider: candidateProviderId(entry.candidate), reason: entry.state.detail }));
}

interface SkippedCandidate {
  readonly candidate: AccessProviderCandidate;
  readonly wireModelId?: string;
  readonly state: UnavailableState;
}

type Selection = {
  readonly candidate: AccessProviderCandidate;
  readonly attribution: AccessProviderCandidateAttribution;
  readonly servingAttempt: ServingAttempt;
  /** The fleet rechecks this request must conclude - the quota row's, the
   *  service row's, or both when both bounds passed at once. Each concludes
   *  the same way: live on admission, re-suppressed on the matching terminal
   *  failure, released on anything that said nothing about it. */
  readonly probes: readonly QuotaProbe[];
} & (
  | { readonly client: LLMClient; readonly prepared: PreparedServingRequest }
  | { readonly client?: undefined }
);


/** Whether a walk backs a real request, the preparation of one that nothing sends yet, or a planning read. Only a
 *  serving walk may take a probe lease or record its routing choice, because only a request can conclude a lease and
 *  only a request is routed. A preparing walk otherwise selects, builds, checks, and connects as a serving walk does,
 *  and waits on a pending recheck as it does. */
type WalkMode = "serves" | "prepares" | "plans";

/** What live state says about one candidate serving a request now. `ready`
 *  can serve; its due flags name the fleet rechecks that a serving request
 *  must claim before it sends. `pending` waits on a recheck another request
 *  holds. `refused` cannot serve, with the reason. */
export type CandidateReadiness =
  | { readonly kind: "ready"; readonly quotaProbeDue: boolean; readonly serviceProbeDue: boolean }
  | { readonly kind: "pending"; readonly pending: RecheckPending }
  | { readonly kind: "refused"; readonly state: UnavailableState };

/** The live state that decides candidate readiness. */
export interface CandidateReadinessInputs {
  readonly availability: ProviderAvailability;
  readonly family: ModelFamily;
  readonly providerOptions?: ProviderRequestOptions;
  /** Read at each call, so a condition recorded during a walk applies to the candidates after it. */
  readonly conditions: readonly AuthStoreCondition[];
  readonly credentialLineage?: (candidate: AccessProviderCandidate) => string | undefined;
  readonly subscriptionSpendAuthorizationFor?: SubscriptionSpendAuthorizationResolver;
  readonly subscriptionAllowanceFor?: SubscriptionAllowanceResolver;
}

/** Decides from state alone whether `candidate` can serve now: storage
 *  conditions, request options, the provider's outage row, the spend mode's
 *  admission, and the account's quota rows, in that order. It claims no
 *  probe and builds no adapter, so the request walk and a read-only view
 *  such as the model picker reach the same answer. The caller refreshes
 *  `availability` first. */
export function candidateReadiness(candidate: AccessProviderCandidate, inputs: CandidateReadinessInputs): CandidateReadiness {
  const provider = candidateProviderId(candidate);
  const refused = (reason: UnavailableState["reason"], detail: string, reset?: CapacityReset): CandidateReadiness =>
    ({ kind: "refused", state: { available: false, kind: "terminal", reason, detail, reset } });
  const conditioned = inputs.conditions.some((condition) =>
    condition.scope === "provider"
      ? condition.providerId === provider
      : inputs.credentialLineage?.(candidate) !== undefined);
  if (conditioned) return refused("ineligible", "authentication storage needs attention.");
  const unservable = providerOptionsUnservableReason(provider, inputs.family, inputs.providerOptions);
  if (unservable !== undefined) return refused("ineligible", unservable);
  const service = inputs.availability.serviceStanding(provider);
  if (service.kind === "suppressed") {
    return refused("unavailable", `unreachable; one request will recheck it at ${new Date(service.exhaustion.resetsAtMs).toISOString()}.`, resetOf(service.exhaustion));
  }
  const admission = spendModeState(candidate, inputs.subscriptionSpendAuthorizationFor, inputs.subscriptionAllowanceFor);
  const quota = admission.available ? standingQuotaState(candidate, inputs.availability, "plans") : admission;
  if (!quota.available) return quota.kind === "pending" ? { kind: "pending", pending: quota.pending } : { kind: "refused", state: quota };
  if (service.kind === "recheck_pending") return { kind: "pending", pending: service };
  return { kind: "ready", quotaProbeDue: quota.probeDue === true, serviceProbeDue: service.kind === "probe_due" };
}


/** Owns request-local selection and publishes availability only after execution settles. */
export function createFailoverClient(deps: ProviderChainDeps): ModelClient {
  const availability = deps.availability;
  const shortName = deps.shortName ?? ((provider: AccessProviderId) => provider);
  const sleep = deps.sleep ?? abortableSleep;
  const captureAttributions = (): readonly AccessProviderCandidateAttribution[] => {
    const captured = typeof deps.candidateAttributions === "function" ? deps.candidateAttributions() : deps.candidateAttributions;
    const preferred = deps.preferredAccount?.();
    const resetFor = deps.requestAdmission?.expiringResetFor;
    // Runs of one provider's accounts in one spend mode keep their order, so
    // class and rank still decide first (PI-MODEL-058). Inside a run, included
    // use spends the account whose quota expires soonest first, and the tree's
    // login, which pins an account and never a spend mode, breaks ties.
    const runs: AccessProviderCandidateAttribution[][] = [];
    for (const attribution of captured) {
      const run = runs.at(-1);
      const head = run?.[0]?.candidate;
      if (run !== undefined && head?.spendMode === attribution.candidate.spendMode && head.providerId === attribution.candidate.providerId) run.push(attribution);
      else runs.push([attribution]);
    }
    const reset = (attribution: AccessProviderCandidateAttribution) => (attribution.candidate.spendMode === "included" ? resetFor?.(attribution.candidate) : undefined) ?? Number.MAX_SAFE_INTEGER;
    const sticky = (attribution: AccessProviderCandidateAttribution) => accessProviderAccountKey(attribution.candidate) === preferred ? 0 : 1;
    return Object.freeze(runs.flatMap((run) => run.toSorted((left, right) => reset(left) - reset(right) || sticky(left) - sticky(right))));
  };



  /** Concludes won probes when the provider admits the request. */
  function admit(serving: Selection): void {
    for (const probe of serving.probes) {
      if (!availability.markQuotaLive(serving.candidate, probe)) availability.releaseQuotaProbe(serving.candidate, probe);
    }
  }

  /** Hands back probes this request could not conclude: the failure said
   *  nothing about their rows, or the request was abandoned before its first
   *  event, so the next request rechecks at once. A probe a suppression's
   *  commit already concluded releases as a harmless no-op. */
  function releaseProbes(serving: Selection): void {
    for (const probe of serving.probes) availability.releaseQuotaProbe(serving.candidate, probe);
  }

  function keepProbesAlive(serving: Selection): () => void {
    const stops = serving.probes.map((probe) => availability.keepQuotaProbeAlive(serving.candidate, probe));
    return () => { for (const stop of stops) stop() };
  }



  function servingAttempt(staged: StagedProviderClient): ServingAttempt {
    return staged.attempt;
  }

  /** Pending candidates remain unresolved while ready candidates serve. Each
   * exact candidate is attempted once; planning never claims a probe. */
  function requestWalk(candidateAttributions: readonly AccessProviderCandidateAttribution[], mode: WalkMode, providerOptions?: ProviderRequestOptions, signal?: AbortSignal, prepare?: AdmittedModelRequestRun<unknown>["prepare"]) {
    const spent: SkippedCandidate[] = [];
    const attempted = new Set<string>();
    const waitSignal = signal ?? new AbortController().signal;
    const conditions = [...deps.conditions ?? []];
    const routeKey = (attribution: AccessProviderCandidateAttribution): string =>
      `${accessProviderCandidateKey(attribution.candidate)}\0${attribution.wireModelId}`;
    const recordSpent = (entry: SkippedCandidate): void => {
      const index = spent.findIndex((current) =>
        accessProviderCandidateKey(current.candidate) === accessProviderCandidateKey(entry.candidate)
        && current.wireModelId === entry.wireModelId
      );
      if (index < 0) spent.push(entry);
      else spent[index] = entry;
    };

    async function affordable(attribution: AccessProviderCandidateAttribution, prepared: PreparedServingRequest): Promise<boolean> {
      const provider = candidateProviderId(attribution.candidate);
      const capability = deps.affordability?.get(provider);
      if (capability === undefined) return true;
      if (deps.requestAdmission === undefined) throw new Error(`Provider ${provider} affordability has no request admission capture`);
      const decision = await capability.evaluate({
        attribution, admission: deps.requestAdmission, request: prepared,
        ...(signal === undefined ? {} : { signal }),
      });
      if (decision.kind === "eligible") return true;
      recordSpent({ candidate: attribution.candidate, state: { available: false, kind: "terminal", reason: "ineligible", detail: decision.detail, reset: undefined } });
      return false;
    }

    function select(attribution: AccessProviderCandidateAttribution, client: LLMClient, prepared: PreparedServingRequest, probes: readonly QuotaProbe[]): Selection {
      attempted.add(routeKey(attribution));
      return { candidate: attribution.candidate, attribution, client, servingAttempt: prepared.attempt, prepared, probes };
    }

    function coalescedPending(entries: readonly RecheckPending[]): RecheckPending {
      return {
        kind: "recheck_pending",
        revision: Math.max(...entries.map((entry) => entry.revision)),
        untilMs: Math.min(...entries.map((entry) => entry.untilMs)),
      };
    }

    const readinessInputs: CandidateReadinessInputs = {
      availability,
      family: deps.family,
      conditions,
      ...(providerOptions === undefined ? {} : { providerOptions }),
      ...(deps.credentialLineage === undefined ? {} : { credentialLineage: deps.credentialLineage }),
      ...(deps.subscriptionSpendAuthorizationFor === undefined ? {} : { subscriptionSpendAuthorizationFor: deps.subscriptionSpendAuthorizationFor }),
      ...(deps.subscriptionAllowanceFor === undefined ? {} : { subscriptionAllowanceFor: deps.subscriptionAllowanceFor }),
    };

    function recordAuthConditions(next: readonly AuthStoreCondition[]): void {
      conditions.push(...next);
      deps.observeAuthConditions?.(next);
    }

    async function selectNext(): Promise<Selection> {
      for (;;) {
        if (mode !== "plans") waitSignal.throwIfAborted();
        availability.refreshProjection();
        const pending: RecheckPending[] = [];
        let pendingPlan: AccessProviderCandidateAttribution | undefined;
        for (const attribution of candidateAttributions) {
          const candidate = attribution.candidate;
          const key = accessProviderCandidateKey(candidate);
          if (attempted.has(routeKey(attribution)) || spent.some((entry) =>
            accessProviderCandidateKey(entry.candidate) === key
            && (entry.wireModelId === undefined || entry.wireModelId === attribution.wireModelId)
          )) continue;
          const provider = candidateProviderId(candidate);
          const readiness = candidateReadiness(candidate, readinessInputs);
          if (readiness.kind === "refused") {
            recordSpent({ candidate, state: readiness.state });
            continue;
          }
          if (readiness.kind === "pending") {
            pending.push(readiness.pending);
            pendingPlan ??= attribution;
            continue;
          }
          // A stop that landed while an earlier candidate awaited claims nothing more.
          if (mode !== "plans") waitSignal.throwIfAborted();
          // A planning read predicts what a request would do - probe - without
          // a lease it could never conclude.
          const probes: QuotaProbe[] = [];
          // The candidate owns every probe it claims until a Selection takes them; every other exit hands them back.
          let handedOff = false;
          try {
            if (mode === "serves" && readiness.quotaProbeDue) {
              const state = standingQuotaState(candidate, availability, mode);
              if (!state.available) {
                if (state.kind === "pending") {
                  pending.push(state.pending);
                  pendingPlan ??= attribution;
                } else {
                  recordSpent({ candidate, state });
                }
                continue;
              }
              if (state.probe !== undefined) probes.push(state.probe);
            }
            if (mode === "serves" && readiness.serviceProbeDue) {
              const probe = availability.claimServiceProbe(provider);
              if (probe === undefined) {
                const current = availability.serviceStanding(provider);
                if (current.kind === "recheck_pending") pending.push(current);
                else recordSpent({ candidate, state: { available: false, kind: "terminal", reason: "unavailable", detail: "the outage recheck could not be coordinated.", reset: undefined } });
                continue;
              }
              probes.push(probe);
            }
            try {
              const staged = await deps.build(attribution);
              const attempt = servingAttempt(staged);
              if (prepare === undefined) {
                attempted.add(routeKey(attribution));
                handedOff = true;
                return { candidate, attribution, servingAttempt: attempt, probes };
              }
              const prepared = await prepare(attempt);
              if (!await affordable(attribution, prepared)) continue;
              waitSignal.throwIfAborted();
              const client = await staged.connect();
              // A request stopped while its candidate connected is neither served nor prepared.
              waitSignal.throwIfAborted();
              if (mode === "serves") deps.routing.record({ kind: "served", model: deps.model, chosen: provider, passed: passedCandidates(spent) });
              handedOff = true;
              return select(attribution, client, prepared, probes);
            } catch (error) {
              // Construction fails under the same rule as serving: a spent or
              // unreachable account hands the request on, anything else ends it.
              if (!(error instanceof ProviderAttemptFailure) || !isFailoverFailure(error.failure)) throw error;
              if (error.failure._tag === "AuthConditionFailure") recordAuthConditions(error.failure.conditions);
              recordSpent({
                candidate,
                ...(attribution.routeKind === "free" ? { wireModelId: attribution.wireModelId } : {}),
                state: { available: false, kind: "terminal", reason: error.failure, detail: errorMessage(error), reset: undefined },
              });
            }
          } finally {
            if (!handedOff) for (const held of probes) availability.releaseQuotaProbe(candidate, held);
          }
        }
        if (pending.length > 0) {
          if (mode === "plans" && pendingPlan) {
            const staged = await deps.build(pendingPlan);
            const attempt = servingAttempt(staged);
            return { candidate: pendingPlan.candidate, attribution: pendingPlan, servingAttempt: attempt, probes: [] };
          }
          await availability.waitForChange(coalescedPending(pending), waitSignal);
          continue;
        }
        if (mode === "serves") deps.routing.record({ kind: "refused", model: deps.model, passed: passedCandidates(spent) });
        throw exhaustedChainError(deps.model, spent, shortName, availability, deps.requestAdmission?.bankedResetFor);
      }
    }

    return {
      start(): Promise<Selection> {
        return selectNext();
      },
      /** The candidate spent its attempts on one outage-shaped failure. The
       *  durable mark rests on the last failure's evidence: a provider-stated
       *  failure marks, a lost connection never does. */
      publishOutageFailure(failed: Selection, failure: FailoverFailure, attempts: number): void {
        const provider = candidateProviderId(failed.candidate);
        if (failed.attribution.routeKind !== "free" && isProviderAttributedFailure(failure)) availability.markUnreachable(provider);
        const standing = availability.serviceStanding(provider);
        recordSpent({
          candidate: failed.candidate,
          ...(failed.attribution.routeKind === "free" ? { wireModelId: failed.attribution.wireModelId } : {}),
          state: {
            available: false,
            kind: "terminal",
            reason: failure,
            detail: `unreachable after ${attempts} attempts (${extractProviderErrorDetail(errorMessage(failure.cause)).replace(/\.\s*$/, "")}).`,
            reset: standing.kind === "suppressed" ? resetOf(standing.exhaustion) : undefined,
          },
        });
      },
      selectNext,
      affordable,
      recordAuthConditions,
      recordProviderFailure(failed: Selection, failure: FailoverFailure): void {
        const standing = failure._tag !== "QuotaExhaustedFailure" || failed.attribution.routeKind === "free"
          ? undefined
          : candidateProviderId(failed.candidate) === "chatgpt"
            ? availability.chatGptStanding(failed.candidate)
            : availability.genericQuotaStanding(failed.candidate);
        recordSpent({
          candidate: failed.candidate,
          ...(failed.attribution.routeKind === "free" ? { wireModelId: failed.attribution.wireModelId } : {}),
          state: {
            available: false,
            kind: "terminal",
            reason: failure,
            detail: extractProviderErrorDetail(errorMessage(failure.cause)).replace(/\.\s*$/, ""),
            reset: standing?.kind === "suppressed" ? resetOf(standing.exhaustion) : undefined,
          },
        });
      },
    };
  }


  /** Resolves an authorized ready candidate without publishing observations or claiming probes. */
  async function plannedAttempt(providerOptions?: ProviderRequestOptions): Promise<ServingAttempt> {
    const selected = await requestWalk(captureAttributions(), "plans", providerOptions).start();
    return selected.servingAttempt;
  }

  function admittedRequest(candidateAttributions: readonly AccessProviderCandidateAttribution[]) {
    const capturedAttributions = Object.freeze([...candidateAttributions]);
    async function run<T>(request: AdmittedModelRequestRun<T>): Promise<T> {
      const walk = requestWalk(capturedAttributions, "serves", request.providerOptions, request.signal, request.prepare);
      const waitSignal = request.signal ?? new AbortController().signal;
      // Counted across candidates: the budget belongs to the model response, not to the candidate that serves it.
      let resamples = 0;
      let selection = await walk.start();
      for (;;) {
        const attempt = selection;
        let concluded = attempt.probes.length === 0;
        const stopProbeRenewal = keepProbesAlive(attempt);
        try {
          // Inside the try, so a stop that lands before the first attempt still hands the Selection's probes back.
          request.signal?.throwIfAborted();
          // The candidate's own attempts: one wire attempt, then in-place
          // retries of its transient failures. A probe lease stays alive
          // across them, because the recheck is concluded by the candidate's
          // outcome, not by its first try.
          let retries = 0;
          if (attempt.client === undefined) throw new Error("Serving selection has no connected provider client");
          let prepared = attempt.prepared;
          for (;;) {
            const result = await request.execute(Object.freeze({ attempt: attempt.servingAttempt, client: attempt.client, prepared, sample: resamples + 1, repetitionGuard: repetitionGuard(resamples) }));
            request.signal?.throwIfAborted();
            if (result.kind === "repetition") {
              // The provider served the request and a fresh sample almost always recovers: the same request goes to
              // the same candidate at once, with no backoff, no outage mark, and no failover. The attempt recorded
              // the trip itself (`model.reasoning.repetition_detected`).
              resamples += 1;
              request.onResample?.({ attempt: resamples, maxAttempts: REPETITION_RESAMPLE_LIMIT, nextAttemptDisablesReasoning: repetitionGuard(resamples) === "reasoning_off" });
              continue;
            }
            if (result.kind === "success") {
              if (!concluded) {
                concluded = true;
                admit(attempt);
              }
              return result.value;
            }
            if (result.kind === "login_refused") {
              if (deps.awaitLogin === undefined) return result.value;
              let answer: LoginWaitAnswer;
              request.onLoginWait?.(true);
              try {
                answer = await deps.awaitLogin(attempt.candidate, waitSignal);
                waitSignal.throwIfAborted();
              } finally {
                request.onLoginWait?.(false);
              }
              if (answer === "declined") return result.value;
              continue;
            }
            const failure = result.failure;
            if (failure._tag === "AuthConditionFailure") {
              walk.recordAuthConditions(failure.conditions);
              walk.recordProviderFailure(attempt, failure);
              break;
            }
            if (failure._tag === "ModelAccessFailure") {
              // The account, not the provider, refused: no retry, no outage mark, and no quota mark.
              if (failure.cause instanceof ModelAccessRefusedError) deps.recordModelRefusal?.(attempt.attribution, failure.cause.refusal);
              walk.recordProviderFailure(attempt, failure);
              break;
            }
            if (failure._tag === "RouteUnavailableFailure") {
              // The route cannot run on this machine, and another start meets the same machine: no retry, no outage mark.
              walk.recordProviderFailure(attempt, failure);
              break;
            }
            if (failure._tag === "QuotaExhaustedFailure") {
              const alreadyRecordedObservation = failure.cause instanceof QuotaExhaustedError
                ? failure.cause.quotaObservation
                : undefined;
              if (alreadyRecordedObservation === undefined && attempt.attribution.routeKind !== "free") {
                if (candidateProviderId(attempt.candidate) === "chatgpt") availability.observeChatGptQuotaExhausted(attempt.candidate, undefined);
                else availability.markQuotaExhausted(attempt.candidate);
              }
              walk.recordProviderFailure(attempt, failure);
              break;
            }
            if (retries < CANDIDATE_RETRY_LIMIT) {
              retries += 1;
              const delayMs = retryDelayMs(retries, failure);
              request.onRetry?.({ attempt: retries, maxAttempts: CANDIDATE_RETRY_LIMIT, delayMs, failure });
              await sleep(delayMs, waitSignal);
              prepared = await request.prepare(attempt.servingAttempt);
              if (!await walk.affordable(attempt.attribution, prepared)) break;
              request.signal?.throwIfAborted();
              continue;
            }
            walk.publishOutageFailure(attempt, failure, retries + 1);
            break;
          }
        } finally {
          stopProbeRenewal();
          if (!concluded) releaseProbes(attempt);
        }
        selection = await walk.selectNext();
      }
    }
    async function prepare(request: AdmittedModelRequestPreparation): Promise<PreparedCandidate> {
      const selected = await requestWalk(capturedAttributions, "prepares", request.providerOptions, request.signal, request.prepare).start();
      if (selected.client === undefined) throw new Error("Prepared selection has no connected provider client");
      return Object.freeze({ attempt: selected.servingAttempt, client: selected.client, prepared: selected.prepared });
    }
    return Object.freeze({
      candidateAttributions: capturedAttributions,
      run,
      prepare,
      plannedAttempt: (providerOptions?: ProviderRequestOptions) => requestWalk(capturedAttributions, "plans", providerOptions).start().then((selected) => selected.servingAttempt),
    });
  }
  return {
    model: deps.model,
    modelFamily: deps.family,
    async admitRequest() { return admittedRequest(captureAttributions()); },
    plannedAttempt,
  };
}


/** Durable quota suppression is exact to the candidate mode. Once its bound
 * passes, one request per fleet claims the row's probe lease. */
function standingQuotaState(candidate: AccessProviderCandidate, availability: ProviderAvailability, mode: WalkMode): QuotaState {
  const standing = candidateProviderId(candidate) === "chatgpt" ? availability.chatGptStanding(candidate) : availability.genericQuotaStanding(candidate);
  if (standing.kind === "live") return UNMETERED;
  if (standing.kind === "suppressed") {
    return { available: false, kind: "terminal", reason: "quota", detail: `out of quota until ${new Date(standing.exhaustion.resetsAtMs).toISOString()}.`, reset: resetOf(standing.exhaustion) };
  }
  if (standing.kind === "recheck_pending") return { available: false, kind: "pending", pending: standing };
  if (mode !== "serves") return { available: true, probeDue: true };
  const probe = availability.claimQuotaProbe(candidate);
  if (probe !== undefined) return { available: true, probe };
  const afterClaim = candidateProviderId(candidate) === "chatgpt" ? availability.chatGptStanding(candidate) : availability.genericQuotaStanding(candidate);
  if (afterClaim.kind === "recheck_pending") return { available: false, kind: "pending", pending: afterClaim };
  return { available: false, kind: "terminal", reason: "unavailable", detail: "the quota recheck could not be coordinated.", reset: undefined };
}

function spendModeState(
  candidate: AccessProviderCandidate,
  authorizationFor: SubscriptionSpendAuthorizationResolver | undefined,
  subscriptionAllowanceFor: SubscriptionAllowanceResolver | undefined,
): QuotaState {
  if (candidate.spendMode === "included") {
    const allowance = subscriptionAllowanceFor?.(candidate);
    return allowance?.allowance === "refused"
      ? { available: false, kind: "terminal", reason: "ineligible", detail: allowance.detail, reset: undefined }
      : UNMETERED;
  }
  if (candidate.kind === "singleton" || candidate.spendMode === "direct_api") return UNMETERED;
  const authorized = (() => {
    const authorization = authorizationFor?.(candidate);
    return authorization !== undefined
      && authorization.envelope.providerId === candidate.providerId
      && authorization.envelope.instanceId === candidate.instanceId
      && authorization.envelope.mode === candidate.spendMode;
  })();
  if (!authorized) return { available: false, kind: "terminal", reason: "ineligible", detail: SUBSCRIPTION_PAID_REVIEW_DETAIL, reset: undefined };
  return UNMETERED;
}

function failureCopyCause(failure: FailoverFailure): ProviderUnavailableCause {
  if (failure._tag === "QuotaExhaustedFailure") return "quota";
  if (failure._tag === "ModelAccessFailure") return failure.cause instanceof ModelAccessRefusedError && failure.cause.refusal.kind === "extended-context" ? "extended_context" : "model_access";
  if (failure._tag === "AuthConditionFailure") return "ineligible";
  // A route that cannot run on this machine comes back only when a person
  // installs or repairs its program, so waiting does not clear it.
  if (failure._tag === "RouteUnavailableFailure") return "route_unavailable";
  if (failure._tag === "RateLimitFailure") return "rate_limit";
  if (failure.cause instanceof ThinkingStallError || (failure.cause instanceof StreamIdleTimeoutError && failure.cause.phase === "idle")) return "stall";
  // Adapters can classify a 503 as overload while retaining the HTTP status
  // only in the SDK cause. Read the existing diagnostic projection, not prose.
  let diagnostic = summarizeProviderError(failure);
  while (diagnostic.status === undefined && diagnostic.cause !== undefined) diagnostic = diagnostic.cause;
  if (diagnostic.status !== undefined && diagnostic.status >= 500 && diagnostic.status !== 529) return "server_error";
  return failure._tag === "OverloadedFailure" ? "overload" : "connection";
}

function exhaustedChainError(model: string, skipped: readonly SkippedCandidate[], shortName: (provider: AccessProviderId) => string, availability: ProviderAvailability, bankedResetFor: SubscriptionBankedResetResolver | undefined): AllCandidatesExhaustedError {
  // Workflow control parses this legacy message, whose contract is the last
  // reason per candidate. Typed display retains every request-local route.
  const legacy = [...new Map(skipped.map((entry) => [accessProviderCandidateKey(entry.candidate), entry])).values()];
  // One account fills several spend modes, and one service row gates them
  // all, so identical lines are one fact stated once.
  const reasons = [...new Set(legacy
    .map((entry) => `${shortName(candidateProviderId(entry.candidate))}: ${entry.state.detail}`))]
    .join(" ");
  const resets = legacy
    .flatMap((candidate) => candidate.state.reset === undefined ? [] : [candidate.state.reset.atMs]);
  const earliestResetsAtMs = resets.length === 0 ? undefined : Math.min(...resets);
  // String-only consumers retain the legacy reset channel. Current terminal
  // presentation uses the typed copy and never classifies this wrapper.
  const reset = earliestResetsAtMs === undefined ? "" : ` Capacity returns at ${new Date(earliestResetsAtMs).toISOString()}.`;
  const message = `No access provider can run "${model}" right now. ${reasons}${reset}`.trim();
  const detail = legacy.some((entry) => entry.state.detail === SUBSCRIPTION_PAID_REVIEW_DETAIL)
    ? SUBSCRIPTION_PAID_REVIEW_DETAIL
    : undefined;
  // A route that waiting can help but that no shared gate holds, such as one
  // that lost its connection or whose recheck claim did not land, is checked
  // again after the safe recheck interval, so a chain of spent routes always
  // states when to try again (PI-MODEL-039). The bound lives on this
  // request's recovery alone: it marks nothing that other sessions read.
  const recheckAtMs = Date.now() + SAFE_RECHECK_MS;
  // Both shared gates must reopen, including for an earlier free route. When no gate holds the candidate now, such as
  // when its bound passed during the walk, what held it when the walk passed it still names its hold: a spent limit is
  // still a spent limit and a rate limit still a rate limit, and a recheck must not stand in for either.
  const sharedGateReset = (provider: AccessProviderId, entry: SkippedCandidate, cause: ProviderUnavailableCause): CapacityReset => {
    const service = availability.serviceStanding(provider);
    const quota = provider === "chatgpt" ? availability.chatGptStanding(entry.candidate) : availability.genericQuotaStanding(entry.candidate);
    const holds = [service, quota].flatMap((standing) => standing.kind === "suppressed" ? [standing.exhaustion] : []);
    if (holds.length === 0) {
      const observed: CapacityHold = entry.state.reset?.hold ?? (cause === "quota" ? { kind: "usage_limit", stated: false } : { kind: "recheck" });
      // The recheck moment is no reset that the provider stated.
      return { atMs: recheckAtMs, hold: observed.kind === "usage_limit" ? { kind: "usage_limit", stated: false } : observed };
    }
    return resetOf(holds.reduce((held, exhaustion) => exhaustion.resetsAtMs > held.resetsAtMs ? exhaustion : held));
  };
  const candidates = skipped.map((entry) => {
    const provider = candidateProviderId(entry.candidate);
    const cause = typeof entry.state.reason === "string" ? entry.state.reason : failureCopyCause(entry.state.reason);
    return {
      provider: `${shortName(provider)}${entry.wireModelId === undefined ? "" : ` (free route ${entry.wireModelId})`}`,
      cause,
      detail: typeof entry.state.reason === "string" ? entry.state.detail : errorMessage(entry.state.reason.cause),
      // A cause that only a person clears states no reset.
      reset: waitingClears(cause) ? sharedGateReset(provider, entry, cause) : undefined,
      bankedReset: bankedResetFor?.(entry.candidate) === true,
    };
  });
  return new AllCandidatesExhaustedError({
    message,
    copy: exhaustedProvidersCopy(candidates),
    recovery: exhaustedProvidersRecovery(candidates),
    ...(detail === undefined ? {} : { detail }),
  });
}
