/**
 * Process-local projection of exact candidate-mode quota and provider outage
 * observations, backed by the durable availability authority.
 *
 * Admission reads current normalized profile spend sources directly. This
 * owner does not poll providers or retain credit state. Account-mode quota
 * rows and provider-scoped outage rows remain separate authorities.
 */

import { Cause, Effect, Exit } from "effect";
import { abortableSleep, awaitWithAbortSignal } from "../../../infra/abort.js";
import { CHATGPT_RATE_LIMIT_HEADER_PREFIX } from "../../../infra/auth/openai-auth-types.js";
import { accessProviderCandidateKey, candidateProviderId, type AccessProviderCandidate, type AccessProviderId } from "../../../infra/llm/access-provider.js";
import { errorMessage } from "../../../infra/error-message.js";
import type { CapacityHold } from "../../../infra/llm/provider-error-copy.js";
import { Log } from "../../../infra/log.js";
import { isRecord } from "../../../infra/record.js";
import {
  AvailabilityCorruptError,
  availabilityKey,
  type AvailabilityKey,
  type AvailabilityObservation,
  AvailabilityProtocolError,
  type AvailabilityRow,
  AvailabilityTransientError,
} from "../../../infra/llm/availability-store.js";
import { QUOTA_CODES, QuotaCoordinationError } from "./errors.js";
import { STREAM_TTFT_TIMEOUT_MS } from "./stream-watchdog.js";
import { startProbeLeaseRenewal } from "./probe-lease-renewal.js";
import { bridgeExternalPromise } from "../external-promise-bridge.js";
import type {
  ProviderAvailability,
  ProviderAvailabilityDeps,
  ProviderAvailabilityOwner,
  QuotaExhaustion,
  QuotaExhaustionObservation,
  QuotaStanding,
  RecheckPending,
} from "./provider-availability-types.js";
const log = Log.create({ service: "provider-availability" });


/** Generic providers report one account-level quota, so their durable rows
 *  share one canonical window key. */
const GENERIC_QUOTA_WINDOW = "account";

/** Service health is its own row per provider, beside the quota windows: an
 *  outage says the service cannot answer, not that the account cannot pay,
 *  and the two facts recover on different evidence. The recheck after an
 *  outage is a request probe for every provider, Copilot included - no meter
 *  can observe whether the service answers requests. */
const SERVICE_WINDOW = "service";

/** The two windows ChatGPT meters, which is the one provider that meters more
 *  than the account as a whole. */
const CHATGPT_WINDOWS = ["primary", "secondary"] as const;

/** The Anthropic API's rate limits. Every response states, in RFC 3339, when
 *  each one is fully replenished (`anthropic-ratelimit-<limit>-reset`). They
 *  all meter the one account, so they fold into its one row. */
const ANTHROPIC_RATE_LIMITS = ["requests", "tokens", "input-tokens", "output-tokens"] as const;

/** The source of a row that the Anthropic rate-limit headers wrote. Every
 *  other exhausted account row is a spent usage limit, quota, or credit. */
const ANTHROPIC_RATE_LIMIT_SOURCE = "anthropic-rate-headers";

/** How long a suppression the provider stated no reset for holds. It is a
 *  safe recheck bound, not a capacity claim: after it, one request finds out
 *  what the account can actually do, which is the only authority there is. */
export const SAFE_RECHECK_MS = 5 * 60_000;

/** How long a first outage mark holds. An outage mark holds back every
 *  session on this machine, and most provider trouble is over in a minute,
 *  so a mark starts short and only a recheck that fails again lengthens it,
 *  doubling up to `SAFE_RECHECK_MS`. */
const OUTAGE_HOLD_MS = 60_000;

/** How long after an outage hold expires a new mark still continues that
 *  outage rather than starting a fresh short one. A failed recheck can land
 *  a probe lease's length after the bound passed, so the memory must outlast
 *  one probe. */
const OUTAGE_MEMORY_MS = 15 * 60_000;


/** Initial lease for one generic quota recheck. A live request renews it at
 *  half this interval; a crashed process therefore delays the next recheck by
 *  at most one interval without limiting how long a retrying request may run. */
const QUOTA_PROBE_LEASE_MS = STREAM_TTFT_TIMEOUT_MS + 30_000;
const QUOTA_PROBE_RENEW_INTERVAL_MS = Math.floor(QUOTA_PROBE_LEASE_MS / 2);


/** The durable half of an observation: the state it puts the row in and when
 *  that row stops holding the account back. */
type DurableObservation = Pick<AvailabilityObservation, "state" | "resetsAtMs" | "nextProbeAtMs">;

/** One observation, less the account key it is stated about. */
type Observation = DurableObservation
  & Pick<AvailabilityObservation, "observedAtMs" | "source">
  & { readonly fence?: number };

type ObservationResult = { readonly row: AvailabilityRow | undefined; readonly committed: boolean };

interface RevisionWait {
  readonly stop: () => void;
  readonly settled: Promise<Exit.Exit<void>>;
  waiters: number;
}

/** One coordination point's failure. `at` states what could not be
 *  coordinated, in the words that reach the user. */
function coordinationError(provider: string, at: string, reason: unknown): QuotaCoordinationError {
  return new QuotaCoordinationError({
    message: `${at}, so this request cannot be served by another provider: ${errorMessage(reason)}`,
    provider,
    reason: errorMessage(reason),
  });
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** The durable meaning of one response's headers for one window. A window
 *  with no used-percent header was not described, which states nothing. A
 *  window under its limit or reported inactive (zero minutes long) is a live
 *  observation - a new version of the row, never a deletion, so every other
 *  owner recovers from it. A window at its limit suppresses the account. */
function chatGptWindowObservation(headers: Headers, prefix: string, observedAtMs: number): DurableObservation | undefined {
  const usedPercent = headerNumber(headers, `${prefix}-used-percent`);
  if (usedPercent === undefined) return undefined;
  if (headerNumber(headers, `${prefix}-window-minutes`) === 0 || usedPercent < 100) return { state: "live" };
  const resetsAtSeconds = headerNumber(headers, `${prefix}-reset-at`);
  return terminalSuppression(observedAtMs, resetsAtSeconds === undefined ? undefined : resetsAtSeconds * 1000);
}

/** A suppression that holds to the provider-reported reset, or to a bounded
 *  safe recheck moment when the provider reported none: a suppression always
 *  states when it ends. */
function terminalSuppression(observedAtMs: number, resetsAtMs: number | undefined): DurableObservation {
  return resetsAtMs === undefined
    ? { state: "exhausted", nextProbeAtMs: observedAtMs + SAFE_RECHECK_MS }
    : { state: "exhausted", resetsAtMs };
}


export function createProviderAvailability(deps: ProviderAvailabilityDeps = {}): ProviderAvailabilityOwner {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const authority = deps.authority;

  /** The row this owner last read, committed, or observed, per account key. It
   *  carries the generation every commit is conditioned on and the semantics
   *  that decide whether a new observation says anything at all. */
  const rows = new Map<string, AvailabilityRow>();
  const rowRevisions = new Map<string, number>();
  /** Set when this owner must stop using the authority: confirmed corruption,
   *  a foreign protocol version, or disposal. A durable observation then has
   *  nowhere to land, which a terminal suppression must not pass over. */
  let stopped: Error | undefined;
  let disposal: Promise<void> | undefined;
  const revisionWaits = new Map<string, RevisionWait>();

  function rowKey(key: AvailabilityKey): string {
    return `${key.scope}\u0000${key.provider}\u0000${key.scope === "account" ? `${key.profileId}\u0000${key.candidateKey}` : ""}\u0000${key.window}`;
  }

  function handleAuthorityFailure(error: unknown, at: string): void {
    if (error instanceof AvailabilityCorruptError || error instanceof AvailabilityProtocolError) {
      stopped = error;
      log.error("the availability authority failed closed; this process keeps its own observations and commits none", { at, error: errorMessage(error) });
      return;
    }
    log.warn("the availability authority is unreachable; keeping the in-memory observation only", { at, error: errorMessage(error) });
  }

  /** Until when the row holds the account back, or undefined when it holds it
   *  no longer: `live` and `probe_due` never suppress, and an exhausted row
   *  expires at its provider-reported reset or its safe recheck moment. */
  function suppressedUntilMs(row: AvailabilityRow): number | undefined {
    if (row.state !== "exhausted") return undefined;
    const until = row.resetsAtMs ?? row.nextProbeAtMs;
    return until !== undefined && until > now() ? until : undefined;
  }

  /** The exhaustion that an exhausted row states until `untilMs`, and what holds it. A service row holds an outage
   *  until its recheck. An account row holds a rate limit when the rate-limit headers wrote it, and otherwise a spent
   *  limit, whose reset the provider stated or not. */
  function exhaustionOf(row: AvailabilityRow, untilMs: number): QuotaExhaustion {
    const hold: CapacityHold = row.scope === "provider" ? { kind: "recheck" }
      : row.source === ANTHROPIC_RATE_LIMIT_SOURCE ? { kind: "rate_limit" }
      : { kind: "usage_limit", stated: row.resetsAtMs !== undefined };
    return { exhaustedAtMs: row.observedAtMs, resetsAtMs: untilMs, hold };
  }

  /** How long a new outage mark holds, given the service row it lands on. A
   *  mark inside a standing hold restates the outage at the same length: two
   *  sessions spending their retries at once is one outage, not a longer one.
   *  A mark after the hold expired is a recheck that failed, so it doubles,
   *  up to the safe bound, while a mark long after the last hold starts a new
   *  short one. A row a recovery or anything else last wrote starts short. */
  function outageHoldMs(row: AvailabilityRow | undefined, nowMs: number): number {
    if (row?.state !== "exhausted" || row.source !== "provider-outage" || row.nextProbeAtMs === undefined) return OUTAGE_HOLD_MS;
    const previousHoldMs = row.nextProbeAtMs - row.observedAtMs;
    if (suppressedUntilMs(row) !== undefined) return previousHoldMs;
    if (nowMs - row.nextProbeAtMs > OUTAGE_MEMORY_MS) return OUTAGE_HOLD_MS;
    return Math.min(previousHoldMs * 2, SAFE_RECHECK_MS);
  }

  /** Whether the row already states this observation and still stands by it.
   *  A suppression whose reset or safe recheck moment has passed holds the
   *  account back no longer, so the same terminal failure observed after it is
   *  news: the bound must be renewed rather than leave every process reading a
   *  suppression that expired and never re-arms. */
  function stillStates(row: AvailabilityRow, observation: Observation): boolean {
    if (row.state !== observation.state || row.resetsAtMs !== observation.resetsAtMs) return false;
    return row.state !== "exhausted" || suppressedUntilMs(row) !== undefined;
  }

  /** Folds one durable row into this owner's projection. */
  function fold(row: AvailabilityRow, observedRevision?: number): void {
    const key = rowKey(availabilityKey(row));
    rows.set(key, row);
    if (observedRevision !== undefined) rowRevisions.set(key, observedRevision);
  }

  /** Drops what this owner concluded about a key the account states no row
   *  for: an observation that never landed is not the account's word. */
  function forget(key: AvailabilityKey): void {
    const keyName = rowKey(key);
    rows.delete(keyName);
    rowRevisions.delete(keyName);
  }

  /** The account's exhaustion entry while its row still holds it back. */
  function liveExhaustion(key: AvailabilityKey): QuotaExhaustion | undefined {
    const row = rows.get(rowKey(key));
    if (!row) return undefined;
    const until = suppressedUntilMs(row);
    return until === undefined ? undefined : exhaustionOf(row, until);
  }


  /** The row this owner would hold if the observation were the account's last
   *  word: what a memory-only account states, and what this owner keeps when
   *  the authority could not be reached. */
  function projectedRow(key: AvailabilityKey, known: AvailabilityRow | undefined, observation: Observation): AvailabilityRow {
    return {
      ...key,
      state: observation.state,
      generation: known?.generation ?? 0,
      observedAtMs: observation.observedAtMs,
      source: observation.source,
      fence: known?.fence ?? 0,
      leaseExpiresAtMs: 0,
      ...(observation.resetsAtMs === undefined ? {} : { resetsAtMs: observation.resetsAtMs }),
      ...(observation.nextProbeAtMs === undefined ? {} : { nextProbeAtMs: observation.nextProbeAtMs }),
    };
  }

  /** Commits one observation under the generation this owner read, unless the
   * row already states it. `committed` is true only when this caller advanced
   * the durable row; a rejected or semantic no-op commit adopts the winner and
   * returns false. */
  function observe(key: AvailabilityKey, observation: Observation, forceAuthority = false): ObservationResult {
    const known = rows.get(rowKey(key));
    if (!forceAuthority && observation.fence === undefined && known && stillStates(known, observation)) {
      return { row: known, committed: false };
    }
    if (!authority) {
      const projected = projectedRow(key, known, observation);
      rows.set(rowKey(key), projected);
      return { row: projected, committed: true };
    }
    if (stopped) {
      rows.set(rowKey(key), projectedRow(key, known, observation));
      // oxlint-disable-next-line eslint/no-throw-literal -- boundary: `stopped` is the typed authority failure this owner latched; rethrowing it keeps the caller's reason exact.
      throw stopped;
    }
    try {
      const result = authority.commit({ ...observation, ...key, readGeneration: known?.generation ?? 0 });
      if (result.kind === "rejected") {
        if (!result.current) {
          rows.delete(rowKey(key));
          return { row: undefined, committed: false };
        }
        fold(result.current);
        return { row: result.current, committed: false };
      }
      rows.set(rowKey(key), result.row);
      return { row: result.row, committed: result.kind === "committed" };
    } catch (error) {
      handleAuthorityFailure(error, "committing an availability observation");
      rows.set(rowKey(key), projectedRow(key, known, observation));
      throw error;
    }
  }

  /** An observation whose durability is worth having but not worth failing a
   *  request over: header folds and meter results, which the next observation
   *  supersedes anyway. */
  function observeBestEffort(key: AvailabilityKey, observation: Observation): void {
    try {
      observe(key, observation);
    } catch {
      // observe classified and logged the failure, and the projection kept the
      // observation: only its durability was lost.
    }
  }

  /** Commits a terminal suppression and proves the account adopted it. The
   * returned transition is also the one presentation claim for this active
   * exhaustion window. Reset-only updates do not claim again. */
  function suppress(provider: AccessProviderId, key: AvailabilityKey, observation: Observation): QuotaExhaustionObservation {
    const known = rows.get(rowKey(key));
    let wasExhausted = known?.state === "exhausted";
    let result: ObservationResult;
    try {
      result = observe(key, observation, true);
      if (result.row !== undefined && result.row.state !== "exhausted") {
        wasExhausted = false;
        result = observe(key, { ...observation, fence: undefined }, true);
      }
    } catch (error) {
      throw coordinationError(provider, `the ${provider} quota suppression did not reach the account's availability authority`, error);
    }
    const current = result.row;
    const resetsAtMs = current?.resetsAtMs ?? current?.nextProbeAtMs;
    if (current?.state === "exhausted" && resetsAtMs !== undefined) {
      return {
        exhaustion: exhaustionOf(current, resetsAtMs),
        newlyExhausted: result.committed && !wasExhausted,
        reportedResetAtMs: current.resetsAtMs,
      };
    }
    throw coordinationError(
      provider,
      `the account did not adopt the ${provider} quota suppression`,
      current === undefined ? "the account states no row" : `the account states ${current.state}`,
    );
  }
  async function sharedRevisionWait(pending: RecheckPending, signal: AbortSignal): Promise<void> {
    if (!authority) return;
    const key = `${pending.revision}\u0000${pending.untilMs}`;
    while (true) {
      signal.throwIfAborted();
      // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the authority's original typed failure when admission is closed.
      if (stopped) throw stopped;
      let wait = revisionWaits.get(key);
      if (wait?.waiters === 0) {
        // A new caller can arrive while the last caller's cancelled sleep is
        // still unwinding. Keep that work owned until it settles.
        await awaitWithAbortSignal(wait.settled, signal);
        continue;
      }
      if (!wait) {
        const bridge = bridgeExternalPromise(async (internalSignal) => {
          while (true) {
            internalSignal.throwIfAborted();
            if (authority.revision() !== pending.revision || now() >= pending.untilMs) return;
            await sleep(Math.min(250, pending.untilMs - now()), internalSignal);
          }
        });
        wait = {
          stop: bridge.stop,
          settled: Effect.runPromiseExit(bridge.owned).finally(() => revisionWaits.delete(key)),
          waiters: 0,
        };
        revisionWaits.set(key, wait);
      }
      wait.waiters += 1;
      try {
        const exit = await awaitWithAbortSignal(wait.settled, signal);
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        return;
      } finally {
        wait.waiters -= 1;
        if (wait.waiters === 0) wait.stop();
      }
    }
  }


  function forCandidates(profileId: string, candidates: readonly AccessProviderCandidate[]): ProviderAvailability {
    const candidateKey = (candidate: AccessProviderCandidate): string => accessProviderCandidateKey(candidate);
    const accountKey = (candidate: AccessProviderCandidate, window: string): Extract<AvailabilityKey, { scope: "account" }> => ({
      scope: "account",
      provider: candidateProviderId(candidate),
      profileId,
      candidateKey: candidateKey(candidate),
      window,
    });
    const serviceKey = (provider: AccessProviderId): AvailabilityKey => ({ scope: "provider", provider, window: SERVICE_WINDOW });
    const boundKeys: readonly AvailabilityKey[] = [
      ...candidates.flatMap((candidate) => {
        const provider = candidateProviderId(candidate);
        const windows = provider === "chatgpt" ? CHATGPT_WINDOWS : [GENERIC_QUOTA_WINDOW];
        return windows.map((window) => accountKey(candidate, window));
      }),
      ...[...new Set(candidates.map(candidateProviderId))].map(serviceKey),
    ];
    const coordinatedProviders = authority === undefined ? [] : [...new Set(candidates.map(candidateProviderId))];
    let revision = 0;
    let initialized = false;

    const windowKeysFor = (candidate: AccessProviderCandidate): readonly AvailabilityKey[] =>
      (candidateProviderId(candidate) === "chatgpt" ? CHATGPT_WINDOWS : [GENERIC_QUOTA_WINDOW]).map((window) => accountKey(candidate, window));

    function standingFor(candidate: AccessProviderCandidate): QuotaStanding {
      return standingOver(windowKeysFor(candidate));
    }

    function standingOver(keys: readonly AvailabilityKey[]): QuotaStanding {
      const exhausted = keys.flatMap((key) => {
        const row = rows.get(rowKey(key));
        return row?.state === "exhausted" ? [row] : [];
      });
      const suppressed = exhausted.flatMap((row) => {
        const until = suppressedUntilMs(row);
        return until === undefined ? [] : [exhaustionOf(row, until)];
      });
      if (suppressed.length > 0) {
        const latest = suppressed.reduce((held, entry) => entry.resetsAtMs > held.resetsAtMs ? entry : held);
        return {
          kind: "suppressed",
          exhaustion: { ...latest, exhaustedAtMs: Math.max(...suppressed.map((entry) => entry.exhaustedAtMs)) },
        };
      }
      if (exhausted.length === 0) return { kind: "live" };
      if (!authority) return { kind: "live" };
      const leasedRows = exhausted.filter((row) => row.leaseExpiresAtMs > now());
      if (leasedRows.length > 0) {
        const leasedUntilMs = Math.min(...leasedRows.map((row) => row.leaseExpiresAtMs));
        const leaseRows = leasedRows.filter((row) => row.leaseExpiresAtMs === leasedUntilMs);
        const observedRevision = Math.max(...leaseRows.map((row) => rowRevisions.get(rowKey(availabilityKey(row))) ?? revision));
        return { kind: "recheck_pending", untilMs: leasedUntilMs, revision: observedRevision };
      }
      return { kind: "probe_due" };
    }

    /** Claims the fleet's one recheck of `target`, quota and service rows alike. */
    function claimProbeOn(target: AvailabilityKey): ReturnType<ProviderAvailability["claimQuotaProbe"]> {
      if (!authority) return undefined;
      try {
        const claim = authority.claimProbe({ ...target, nowMs: now(), leaseMs: QUOTA_PROBE_LEASE_MS });
        fold(claim.row, claim.revision);
        return claim.kind === "won" ? { window: target.window, fence: claim.row.fence } : undefined;
      } catch (error) {
        handleAuthorityFailure(error, "claiming a recheck probe");
        throw coordinationError(target.provider, `the ${target.provider} recheck lease could not be claimed`, error);
      }
    }

    function reloadBoundKeys(): void {
      if (!authority || boundKeys.length === 0) return;
      const snapshot = authority.snapshotFor(boundKeys);
      const stated = new Map(snapshot.rows.map((row) => [rowKey(availabilityKey(row)), row]));
      for (const key of boundKeys) {
        const row = stated.get(rowKey(key));
        if (row) fold(row, snapshot.revision);
        else forget(key);
      }
      revision = snapshot.revision;
    }
    /** The first selection reads one exact snapshot. Later normal selections are
     * projection-only; pending waits own every additional authority read. */
    function sync(): void {
      if (initialized || !authority || boundKeys.length === 0) return;
      initialized = true;
      reloadBoundKeys();
    }

    return {
      refreshProjection() {
        try {
          sync();
        } catch (error) {
          if (coordinatedProviders.length === 0) return;
          throw coordinationError(coordinatedProviders.join(", "), "the accounts this request would spend from could not be read from the availability authority", error);
        }
      },
      async waitForChange(pending: RecheckPending, signal: AbortSignal) {
        if (!authority || boundKeys.length === 0) return;
        try {
          await sharedRevisionWait(pending, signal);
          // oxlint-disable-next-line eslint/no-throw-literal -- boundary: disposal may begin after the shared wait settles but before this binding resumes.
          if (stopped) throw stopped;
          reloadBoundKeys();
        } catch (error) {
          if (signal.aborted) throw error;
          handleAuthorityFailure(error, "waiting for an availability change");
          throw coordinationError(coordinatedProviders.join(", "), "the availability authority could not be watched for a change", error);
        }
      },


      observeChatGptRateHeaders(candidate, headers) {
        if (candidate.spendMode !== "included") return;
        const observedAtMs = now();
        for (const window of CHATGPT_WINDOWS) {
          const durable = chatGptWindowObservation(headers, `${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-${window}`, observedAtMs);
          if (durable) observeBestEffort(accountKey(candidate, window), { observedAtMs, source: "chatgpt-rate-headers", ...durable });
        }
      },

      observeChatGptUsage(candidate, metrics, observedAtMs) {
        if (candidate.spendMode !== "included") return;
        sync();
        for (const window of CHATGPT_WINDOWS) {
          const metric = metrics.find((entry) => entry.scope.kind === "account" && entry.metricKey === `${window}_window`);
          if (metric?.usedFraction === undefined) continue;
          const key = accountKey(candidate, window);
          const known = rows.get(rowKey(key));
          if (known !== undefined && known.observedAtMs >= observedAtMs) continue;
          const resetsAtMs = metric.timing.kind === "exact" ? metric.timing.endMs : metric.timing.resetAtMs;
          observeBestEffort(key, { observedAtMs, source: "chatgpt-usage-report", ...(metric.usedFraction < 1 ? { state: "live" as const } : terminalSuppression(observedAtMs, resetsAtMs)) });
        }
      },

      observeChatGptQuotaExhausted(candidate, resetsAtSeconds) {
        const observedAtMs = now();
        return suppress("chatgpt", accountKey(candidate, "primary"), {
          observedAtMs,
          source: "chatgpt-quota-frame",
          ...terminalSuppression(observedAtMs, resetsAtSeconds === undefined ? undefined : resetsAtSeconds * 1000),
        });
      },

      observeAnthropicRateLimit(candidate, headers) {
        const observedAtMs = now();
        const resets = ANTHROPIC_RATE_LIMITS.flatMap((limit) => {
          const resetsAtMs = Date.parse(headers.get(`anthropic-ratelimit-${limit}-reset`) ?? "");
          return Number.isFinite(resetsAtMs) && resetsAtMs > observedAtMs ? [resetsAtMs] : [];
        });
        if (resets.length > 0) observeBestEffort(accountKey(candidate, GENERIC_QUOTA_WINDOW), { observedAtMs, source: ANTHROPIC_RATE_LIMIT_SOURCE, state: "exhausted", resetsAtMs: Math.max(...resets) });
      },

      chatGptStanding: standingFor,

      markQuotaExhausted(candidate, resetsAtMs) {
        const provider = candidateProviderId(candidate);
        const exhaustedAtMs = now();
        return suppress(provider, accountKey(candidate, GENERIC_QUOTA_WINDOW), {
          observedAtMs: exhaustedAtMs,
          source: "terminal-quota-error",
          ...terminalSuppression(exhaustedAtMs, resetsAtMs),
        });
      },

      quotaExhaustion(candidate) {
        return liveExhaustion(accountKey(candidate, GENERIC_QUOTA_WINDOW));
      },

      genericQuotaStanding: standingFor,

      serviceStanding(provider) {
        return standingOver([serviceKey(provider)]);
      },

      markUnreachable(provider) {
        const observedAtMs = now();
        const key = serviceKey(provider);
        try {
          suppress(provider, key, {
            observedAtMs,
            source: "provider-outage",
            state: "exhausted",
            nextProbeAtMs: observedAtMs + outageHoldMs(rows.get(rowKey(key)), observedAtMs),
          });
        } catch (error) {
          log.warn("a provider outage record did not reach the availability authority; other processes rediscover it themselves", { provider, error: errorMessage(error) });
        }
      },

      markReachable(provider) {
        observeBestEffort(serviceKey(provider), { observedAtMs: now(), source: "provider-recovered", state: "live" });
      },

      claimQuotaProbe(candidate) {
        const provider = candidateProviderId(candidate);
        const target = provider === "chatgpt"
          ? windowKeysFor(candidate).find((key) => {
            const row = rows.get(rowKey(key));
            return row?.state === "exhausted" && suppressedUntilMs(row) === undefined;
          })
          : accountKey(candidate, GENERIC_QUOTA_WINDOW);
        return target ? claimProbeOn(target) : undefined;
      },

      claimServiceProbe(provider) {
        return claimProbeOn(serviceKey(provider));
      },

      keepQuotaProbeAlive(candidate, probe) {
        if (!authority) return () => {};
        const provider = candidateProviderId(candidate);
        const key = probe.window === SERVICE_WINDOW ? serviceKey(provider) : accountKey(candidate, probe.window);
        return startProbeLeaseRenewal({
          intervalMs: QUOTA_PROBE_RENEW_INTERVAL_MS,
          isStopped: () => stopped !== undefined,
          renew: () => authority.renewProbe({ ...key, fence: probe.fence, nowMs: now(), leaseMs: QUOTA_PROBE_LEASE_MS }),
          onFailure: (error) => handleAuthorityFailure(error, "renewing a quota recheck probe"),
        });
      },

      markQuotaLive(candidate, probe) {
        const provider = candidateProviderId(candidate);
        const key = probe.window === SERVICE_WINDOW ? serviceKey(provider) : accountKey(candidate, probe.window);
        const observedAtMs = now();
        let landed: boolean;
        try {
          landed = observe(key, { observedAtMs, source: "quota-probe", state: "live", fence: probe.fence }).row?.state === "live";
        } catch {
          return false;
        }
        if (!landed) return false;
        for (const sibling of [...windowKeysFor(candidate), serviceKey(provider)]) {
          if (rowKey(sibling) === rowKey(key)) continue;
          const row = rows.get(rowKey(sibling));
          if (row?.state === "exhausted" && suppressedUntilMs(row) === undefined) {
            observeBestEffort(sibling, { observedAtMs, source: "quota-probe", state: "live" });
          }
        }
        return true;
      },

      releaseQuotaProbe(candidate, probe) {
        if (!authority) return;
        const provider = candidateProviderId(candidate);
        const key = probe.window === SERVICE_WINDOW ? serviceKey(provider) : accountKey(candidate, probe.window);
        try {
          authority.releaseProbe({ ...key, fence: probe.fence });
          const row = rows.get(rowKey(key));
          if (row && row.fence === probe.fence) fold({ ...row, leaseExpiresAtMs: 0 });
        } catch (error) {
          handleAuthorityFailure(error, "releasing a quota recheck probe");
        }
      },

    };
  }

  return {
    forCandidates,

    dispose() {
      if (disposal) return disposal;
      stopped = new AvailabilityTransientError({
        message: "The availability owner is disposed",
        at: "using a disposed availability owner",
        reason: "disposed",
      });
      disposal = (async () => {
        const waits = [...revisionWaits.values()];
        for (const wait of waits) wait.stop();
        await Promise.all(waits.map((wait) => wait.settled));
        await authority?.dispose();
      })();
      return disposal;
    },
  };
}

/** Folds a terminal ChatGPT quota frame into the owner's windows. ChatGPT
 *  states a spent allowance on the HTTP error body, which `openai-chatgpt.ts`
 *  reads at the fetch boundary, and on the stream frames the transports carry
 *  instead of that body: `response.failed` puts the payload on
 *  `response.error`, an `error` frame nests it under `error` (real backend
 *  frames carry the quota discriminator on `error.type` with no `code`,
 *  as in the Codex CLI fixtures `client_websockets.rs:1472-1480`), and legacy frames
 *  put the fields at the top level. Frames that name no terminal quota code
 *  record nothing. */
export function observeChatGptQuotaFrame(
  frame: unknown,
  candidate: AccessProviderCandidate,
  availability: Pick<ProviderAvailability, "observeChatGptQuotaExhausted">,
): QuotaExhaustionObservation | undefined {
  if (!isRecord(frame)) return undefined;
  const carried = isRecord(frame.payload) ? frame.payload : frame;
  const response = isRecord(carried.response) ? carried.response : undefined;
  for (const payload of [response?.error, carried.error, carried]) {
    if (!isRecord(payload)) continue;
    const code = typeof payload.code === "string" ? payload.code : payload.type;
    if (typeof code !== "string" || !QUOTA_CODES.has(code)) continue;
    const resetsAt = payload.resets_at;
    return availability.observeChatGptQuotaExhausted(candidate, typeof resetsAt === "number" ? resetsAt : undefined);
  }
  return undefined;
}
