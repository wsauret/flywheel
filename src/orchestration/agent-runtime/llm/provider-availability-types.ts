/** The availability owner's contract types: what one client binding may ask
 *  about the accounts it spends from, and the shapes those answers take. The
 *  semantics live with the implementation in `provider-availability.ts`. */

import type { CapacityHold } from "../../../infra/llm/provider-error-copy.js";
import type { AccessProviderCandidate, AccessProviderId, ProviderSettingValues } from "../../../infra/llm/access-provider.js";
import type { AvailabilityAuthority } from "../../../infra/llm/availability-store.js";
import type { SubscriptionUsageMetric } from "../../../infra/llm/subscription-usage.js";
import type { SubscriptionSpendAuthorization } from "../../subscription-spend-consent/subscription-spend-consent-service.js";



/** One probe lease as the winning request holds it: the row (window) it was
 *  claimed on and the fence its conclusion must state. */
export interface QuotaProbe {
  readonly window: string;
  readonly fence: number;
}


/** One provider's terminal quota observation, as this owner projects it. The
 *  reset is the provider-reported one, or the bounded safe recheck moment
 *  when the provider reported none: a suppression always states when it
 *  ends. `hold` names which of these it is, and whether a provider-reported
 *  reset ends a usage limit or a rate limit. */
export interface QuotaExhaustion {
  readonly exhaustedAtMs: number;
  readonly resetsAtMs: number;
  readonly hold: CapacityHold;
}

/** Result of a terminal quota observation. The durable transition itself is
 * the one cross-process presentation claim for this exhaustion window. */
export interface QuotaExhaustionObservation {
  readonly exhaustion: QuotaExhaustion;
  readonly newlyExhausted: boolean;
  readonly reportedResetAtMs: number | undefined;
}

export interface RecheckPending {
  readonly kind: "recheck_pending";
  readonly untilMs: number;
  readonly revision: number;
}

/** What the account states a provider may do right now. `live` admits the
 *  request. `suppressed` skips the candidate until the exhaustion's bound.
 *  Once the bound passes, `probe_due` names the one moment a request may
 *  claim the fleet's recheck, and `recheck_pending` holds every other request
 *  back while a claimed probe is still concluding. */
export type QuotaStanding =
  | { readonly kind: "live" }
  | { readonly kind: "suppressed"; readonly exhaustion: QuotaExhaustion }
  | RecheckPending
  | { readonly kind: "probe_due" };


export type SubscriptionSpendAuthorizationResolver = (candidate: Extract<AccessProviderCandidate, { readonly kind: "subscription" }>) => SubscriptionSpendAuthorization | undefined;

/** Secret-free request-local view of a provider's allowance for one
 *  candidate, as the provider's own admission decided it. `refused` stops the
 *  candidate before any adapter is built with the provider's reason; a finite
 *  or pooled view is left for affordability to price against; `unknown` says
 *  the provider states nothing and the kernel does not gate on allowance. */
export type SubscriptionAllowanceAdmission =
  | { readonly freshness: "fresh" | "stale"; readonly allowance: "finite"; readonly metric?: "premium_interactions" | "ai_credits"; readonly remaining?: number }
  | { readonly freshness: "fresh" | "stale"; readonly allowance: "pooled"; readonly usedCredits: number }
  | { readonly allowance: "refused"; readonly detail: string }
  | { readonly allowance: "unknown" };
export type SubscriptionAllowanceResolver = (candidate: AccessProviderCandidate) => SubscriptionAllowanceAdmission;

/** What a provider's allowance admission reads: the request's candidates, the
 *  usage service that holds the provider's observations, and the provider's
 *  own numeric settings for the request's profile. */
interface ProviderAllowanceInput {
  readonly candidates: readonly AccessProviderCandidate[];
  readonly usage: Pick<import("../../auth/provider-observations/subscription-usage-service.js").SubscriptionUsageService, "metric" | "checkAccounts">;
  readonly settings: ProviderSettingValues;
}
export type ProviderAllowanceFactory = (input: ProviderAllowanceInput) => Promise<SubscriptionAllowanceResolver>;

/** Whether the candidate's account holds an available banked reset in the
 *  usage reading already published in memory when the request was admitted. */
export type SubscriptionBankedResetResolver = (candidate: AccessProviderCandidate) => boolean;

/** When the candidate's account resets its provider's expiring usage window,
 *  as the usage reading already published in memory when the request was
 *  admitted states it. It answers only with a moment after admission;
 *  undefined means no known future reset. */
export type SubscriptionExpiringResetResolver = (candidate: AccessProviderCandidate) => number | undefined;

export interface RequestAdmission {
  readonly subscriptionSpendAuthorizationFor: SubscriptionSpendAuthorizationResolver;
  readonly subscriptionAllowanceFor?: SubscriptionAllowanceResolver;
  readonly bankedResetFor?: SubscriptionBankedResetResolver;
  readonly expiringResetFor?: SubscriptionExpiringResetResolver;
}

/** The availability owner as one client sees it: every read and every
 *  observation targets the accounts that client's credentials name. */
export interface ProviderAvailability {
  /** Reads no authority state. A binding is initialized from one exact snapshot,
   * and later reloads only after its shared revision wait observes change or its
   * lease deadline arrives. */
  refreshProjection(): void;
  /** Waits until the authority revision changes or this lease deadline passes,
   * then reloads only this binding's keys. Concurrent bindings share the owner
   * timer and revision cadence. Aborting detaches only this caller; the last
   * caller leaving cancels the shared wait. Owner disposal rejects all waits. */
  waitForChange(pending: RecheckPending, signal: AbortSignal): Promise<void>;
  /** Folds the rate-limit headers of any ChatGPT response, ok or error,
   *  into the account's per-window rows: a window under its limit or reported
   *  inactive is a live observation, a window at its limit suppresses the
   *  account, and a window the response does not describe states nothing.
   *  Best effort - the response the headers rode in on already carries the
   *  request's outcome. */
  observeChatGptRateHeaders(candidate: AccessProviderCandidate, headers: Headers): void;
  /** Folds a published ChatGPT Usage report into the same per-window rows the
   *  rate headers feed: the meter and the response state one fact through one
   *  row. A window under its limit is live, a window at its limit suppresses
   *  the account until its reset. Evidence no fresher than what a row already
   *  states says nothing, so a stale poll never reopens an account a newer
   *  response closed. This is how a banked reset reopens the account: the
   *  Usage refresh that follows it reports the windows live, and no
   *  reset-specific path exists. Best effort - the publication already
   *  happened. */
  observeChatGptUsage(candidate: AccessProviderCandidate, metrics: readonly SubscriptionUsageMetric[], observedAtMs: number): void;
  observeChatGptQuotaExhausted(candidate: AccessProviderCandidate, resetsAtSeconds: number | undefined): QuotaExhaustionObservation;
  /** Folds the headers of an Anthropic API rate-limit 429 into the account's
   *  one row: it suppresses the account until the latest moment its
   *  `anthropic-ratelimit-*-reset` headers state every limit is full again,
   *  and states nothing when it carries no future reset. Recovery is never
   *  read from headers: only a fenced probe that settles successfully
   *  reopens the account. Best effort, like the ChatGPT header fold. */
  observeAnthropicRateLimit(candidate: AccessProviderCandidate, headers: Headers): void;
  /** The account's standing on ChatGPT, folded over both usage windows: any
   *  suppressed window holds the account, then any claimed recheck holds it,
   *  then any window whose bound has passed admits one probe. */
  chatGptStanding(candidate: AccessProviderCandidate): QuotaStanding;
  /** Records a terminal quota failure for a provider whose account state is
   * one row. The suppression holds until the provider-reported reset, or
   * until the bounded safe recheck moment when the provider reported none,
   * and it holds for every process the moment this commits. A landed
   * suppression concludes any probe lease standing on the row. The result
   * identifies the only caller that moved the account into suppression, so
   * presentation needs no second deduplication authority. Throws
   * `QuotaCoordinationError` unless the account's durable row states the
   * provider exhausted afterwards: the caller must not fall back on a
   * suppression only this process knows about. */
  markQuotaExhausted(candidate: AccessProviderCandidate, resetsAtMs?: number): QuotaExhaustionObservation;
  quotaExhaustion(candidate: AccessProviderCandidate): QuotaExhaustion | undefined;
  genericQuotaStanding(candidate: AccessProviderCandidate): QuotaStanding;
  /** The provider's service health standing: whether its last terminal
   *  outage - a failure that said the service could not answer, not that the
   *  account could not pay - still holds it back. Same algebra as quota, on
   *  its own row, so an outage never rewrites what the account's quota
   *  states. Read-only, like `genericQuotaStanding`. */
  serviceStanding(provider: AccessProviderId): QuotaStanding;
  /** Records a terminal outage: the provider could not answer a request that
   *  had already spent its in-request retries. The suppression holds every
   *  process back for the bounded safe recheck moment - but only while a
   *  fallback candidate can serve; the chain retries a sole source through
   *  it. Best effort, never throws: an outage record that could not land
   *  must not block the fallback that unblocks the user's work, and the
   *  worst case is other processes rediscovering the outage themselves. */
  markUnreachable(provider: AccessProviderId): void;
  markReachable(provider: AccessProviderId): void;
  /** Claims the fleet's one outage recheck of a provider whose suppression
   *  bound has passed. Same contract as `claimQuotaProbe`, on the service
   *  row; the winning request concludes it through `markQuotaLive`,
   *  `markUnreachable`, or `releaseQuotaProbe`. */
  claimServiceProbe(provider: AccessProviderId): QuotaProbe | undefined;
  /** Claims the fleet's one recheck of a provider whose suppression bound has
   *  passed. Returns the probe the winning request concludes, or undefined
   *  when another owner holds the lease. Authority failures throw
   *  `QuotaCoordinationError`; they are not lease-held pending state. */
  claimQuotaProbe(candidate: AccessProviderCandidate): QuotaProbe | undefined;
  keepQuotaProbeAlive(candidate: AccessProviderCandidate, probe: QuotaProbe): () => void;
  markQuotaLive(candidate: AccessProviderCandidate, probe: QuotaProbe): boolean;
  releaseQuotaProbe(candidate: AccessProviderCandidate, probe: QuotaProbe): void;
}

export interface ProviderAvailabilityOwner {
  /** Binds one effective auth profile and the exact candidates it can spend
   * from. Profile identity separates account rows while provider outages stay
   * process-global. */
  forCandidates(profileId: string, candidates: readonly AccessProviderCandidate[]): ProviderAvailability;
  /** Stops wait admission, cancels and joins polling, then closes the authority.
   * Repeated calls await the same disposal. */
  dispose(): Promise<void>;
}

export interface ProviderAvailabilityDeps {
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Durable availability authority. Optional so memory-only folds and their
   *  tests need no file. */
  readonly authority?: AvailabilityAuthority;
}
