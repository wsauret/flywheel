import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { NotificationEpisodeInput, NotificationOccurrence } from "../../infra/notification-episode.js"
import { loggedOperation, type OperationFailure } from "../../infra/operation-log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"

const log = Log.create({ service: "auth-attention" })
const FAILURE_WINDOW_MS = 30_000
const FIRST_RETRY_MS = 1_000
const LAST_RETRY_MS = 60_000

/** The one owner of what each auth profile's attention notifications state
 *  (ARCH-STRUCTURE-034, ARCH-STRUCTURE-040). A view read never notifies; a publication offers its view here,
 *  and only a statement that differs from the last settled delivery is sent.
 *  A profile has at most one delivery in flight, and offers made during it
 *  coalesce into one follow-up with the latest statement. A failed delivery
 *  is sent again after a backoff, because an unchanged auth state publishes
 *  nothing that would send it again. */
export interface AuthAttentionPublisher {
  /** Offers the attention that `view` shows for its profile. */
  state(view: RuntimeAuthView): void
  /** Retires every attention episode of a removed profile, in order behind
   *  any statement still in flight for it. */
  retire(profileId: string): void
  /** A notification consumer became enabled and heard none of the earlier
   *  statements: every profile's latest statement is sent again. */
  reconcile(): void
  /** Stops admission and retries, and settles every delivery in flight. */
  dispose(): Promise<void>
}

interface Statement {
  readonly key: string
  readonly episodes: readonly NotificationEpisodeInput[]
}

interface ProfileAttention {
  /** Replaced only by a statement with a different key, or by a fresh copy
   *  when a consumer needs the same statement again. */
  desired: Statement
  /** The last statement whose delivery settled successfully. A failed or
   *  unanswered delivery leaves it unknown until `desired` is sent again. */
  delivered?: Statement
  flight?: Promise<void>
  /** Armed while `desired` waits out its backoff after a failed delivery. */
  retry?: ReturnType<typeof setTimeout>
  /** Failed deliveries since the last settled one, which set the backoff. */
  failedTries: number
}

/** `deliver` settles once the notify seam applied the episode, and rejects
 *  when the delivery was refused, failed, or got no answer. A rejection is
 *  contained here and logged once per failure condition. `retryDelayMs`
 *  gives the wait after `failedTries` failures in a row; by default it
 *  doubles from one second to one minute. */
export function createAuthAttentionPublisher(deps: {
  readonly deliver: (episode: NotificationEpisodeInput) => Promise<void>
  readonly retryDelayMs?: (failedTries: number) => number
}): AuthAttentionPublisher {
  const retryDelayMs = deps.retryDelayMs ?? ((failedTries: number) => Math.min(FIRST_RETRY_MS * 2 ** (failedTries - 1), LAST_RETRY_MS))
  const profiles = new Map<string, ProfileAttention>()
  let accepting = true
  const failureLog = coalesceRepeats<OperationFailure>({
    windowMs: FAILURE_WINDOW_MS,
    first: (_key, failure) => { log.warn("auth attention delivery failed", { ...failure.fields, durationMs: failure.durationMs, error: errorMessage(failure.error), errorDetail: errorDetail(failure.error) }) },
    repeated: (key, repeats) => { log.warn("auth attention delivery failed again", { error: key, count: repeats.count, windowMs: repeats.windowMs }) },
  })

  const schedule = (profileId: string, entry: ProfileAttention): void => {
    if (entry.flight !== undefined || entry.retry !== undefined || entry.delivered === entry.desired) return
    entry.flight = deliverDesired(profileId, entry)
  }

  const deliverDesired = async (profileId: string, entry: ProfileAttention): Promise<void> => {
    const statement = entry.desired
    entry.delivered = undefined
    try {
      await loggedOperation({
        log, operation: "auth attention delivery", level: "debug", failureLevel: "warn",
        fields: { profileId, episodes: statement.episodes.length },
        onFailure: (failure) => { failureLog.observe(errorMessage(failure.error), failure) },
      }, async () => {
        for (const episode of statement.episodes) await deps.deliver(episode)
      })
      entry.delivered = statement
      entry.failedTries = 0
      failureLog.end()
    } catch {
      entry.failedTries += 1
      // A changed statement is sent at once; the same one waits out its
      // backoff, so a refusing channel is never flooded.
      if (accepting && entry.desired === statement) {
        entry.retry = setTimeout(() => {
          entry.retry = undefined
          schedule(profileId, entry)
        }, retryDelayMs(entry.failedTries))
      }
    }
    entry.flight = undefined
    // Shutdown drains a newer admitted statement, but never retries this one.
    if (accepting || entry.desired !== statement) schedule(profileId, entry)
  }

  const replace = (entry: ProfileAttention, statement: Statement): void => {
    clearTimeout(entry.retry)
    entry.retry = undefined
    entry.desired = statement
  }

  const offer = (profileId: string, statement: Statement): void => {
    if (!accepting) return
    const entry = profiles.get(profileId)
    if (entry === undefined) {
      const created: ProfileAttention = { desired: statement, failedTries: 0 }
      profiles.set(profileId, created)
      schedule(profileId, created)
      return
    }
    if (entry.desired.key !== statement.key) replace(entry, statement)
    schedule(profileId, entry)
  }

  return {
    state: (view) => { offer(view.profile.id, attentionStatement(view)) },
    retire: (profileId) => { offer(profileId, statementOf([
      { type: "reconcile", prefix: authAttentionSourcePrefix(profileId), desired: [] },
      { type: "resolve", sourceId: legacyAuthWarningSource(profileId) },
    ])) },
    reconcile() {
      if (!accepting) return
      // A fresh copy also reaches a delivery in flight, which can have sent
      // part of its statement before the consumer was enabled.
      for (const [profileId, entry] of profiles) {
        replace(entry, statementOf(entry.desired.episodes))
        schedule(profileId, entry)
      }
    },
    async dispose() {
      accepting = false
      for (const entry of profiles.values()) {
        clearTimeout(entry.retry)
        entry.retry = undefined
      }
      while (true) {
        const flights = [...profiles.values()].flatMap(({ flight }) => flight === undefined ? [] : [flight])
        if (flights.length === 0) break
        await Promise.all(flights)
      }
      failureLog.end()
    },
  }
}

function statementOf(episodes: readonly NotificationEpisodeInput[]): Statement {
  return { key: JSON.stringify(episodes), episodes }
}

/** One statement of a profile's attention: the seam's observer raises what is
 *  new and resolves what cleared, and a raise of an active source is
 *  idempotent, so sending the same statement again changes nothing. */
function attentionStatement(view: RuntimeAuthView): Statement {
  const profileId = view.profile.id
  const prefix = authAttentionSourcePrefix(profileId)
  const attention: NotificationOccurrence[] = view.providers.flatMap((provider) => [
    ...(provider.attention === undefined ? [] : [{
      sourceId: `${prefix}provider:${provider.providerId}`,
      title: `${provider.displayName} needs attention`,
      message: `Reconnect ${provider.displayName}.`,
      severity: "warning" as const,
      action: { kind: "open-auth-provider" as const, providerId: provider.providerId },
    }]),
    ...provider.accounts.flatMap((account) => account.attention === undefined ? [] : [{
      sourceId: `${prefix}account:${provider.providerId}:${account.accountCorrelationId}`,
      title: `${provider.displayName} needs attention`,
      message: account.attention.message,
      severity: "warning" as const,
      action: { kind: "open-auth-provider" as const, providerId: provider.providerId },
    }]),
  ])
  if (view.fileAttention !== undefined) {
    attention.push({
      sourceId: `${prefix}file`,
      title: "Authentication file needs attention",
      message: `Repair the authentication file at ${view.fileAttention.path}.`,
      severity: "warning",
      action: { kind: "open-auth" },
    })
  }
  // The view's warnings are exactly the unknown-provider diagnostics, which
  // raise under the profile's one legacy source.
  const legacySourceId = legacyAuthWarningSource(profileId)
  return statementOf([
    { type: "reconcile", prefix, desired: attention },
    view.warnings.length === 0 ? { type: "resolve", sourceId: legacySourceId } : { type: "raise", occurrence: {
      sourceId: legacySourceId,
      title: "Authentication needs attention",
      message: "The authentication file names a provider that Flywheel does not recognize.",
      severity: "warning",
      action: { kind: "open-auth" },
    } },
  ])
}

/** The source prefix every attention episode of one profile carries, so a
 *  profile's episodes reconcile and retire as one group. */
function authAttentionSourcePrefix(profileId: string): string {
  return `runtime:auth-attention:${profileId}:`
}

/** The one source the profile's unknown-provider diagnostics raise under. */
function legacyAuthWarningSource(profileId: string): string {
  return `runtime:auth-status-warning:${profileId}`
}
