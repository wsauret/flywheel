import { existsSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import { storedTokensToCredential } from "../../../infra/auth/openai-auth-types.js"
import { replaceCredentialInstance } from "../../../infra/auth/auth-store-mutations.js"
import { captureSubscriptionCredentials, meteredKeyAccount, type SubscriptionCredentials } from "../../../infra/auth/auth-context.js"
import { loadAuthStoreWithDiagnostics } from "../../../infra/auth/auth-store.js"
import {
  createUsageAuthority,
  type SubscriptionUsageAccount,
  type SubscriptionUsageSnapshot,
  type UsageAuthority,
} from "../../../infra/llm/usage-authority.js"
import type { SubscriptionUsageMetric, SubscriptionUsageOutcome, SubscriptionUsageReader, SubscriptionUsageResetConsumer, SubscriptionUsageResetOutcome, SubscriptionUsageRuntimeAccount } from "../../../infra/llm/subscription-usage.js"

import type { AccessProviderDefinition } from "../../../infra/llm/access-provider.js"
import { createSubscriptionAccountIdentity, type SubscriptionAccountIdentity } from "../../../infra/llm/subscription-account-identity.js"
import { expiredSignInMessage } from "../../../infra/llm/auth-error.js"
import type { AccessProviderRegistry } from "../../agent-runtime/llm/access-provider-registry.js"
import { createOrderedLane } from "../../../infra/ordered-lane.js"
import { credentialSlotClassifier } from "../credential-slot-classifier.js"
import type { CredentialSlotClassifier } from "../../../infra/auth/auth-store-types.js"
import type { LauncherScope } from "../../../infra/process-supervisor.js"
export const SUBSCRIPTION_USAGE_CHECK_INTERVAL_MS = 5 * 60 * 1_000
const SUBSCRIPTION_USAGE_FRESHNESS_MS = 5 * 60 * 1_000
const SUBSCRIPTION_USAGE_JITTER_FRACTION = 0.25
/** The time an ordinary check waits before it reads an account again after a
 *  read that failed. Request admission makes ordinary checks, so this spacing
 *  limits an account whose reads fail to one provider read each minute. An
 *  explicit refresh reads at once. */
const SUBSCRIPTION_USAGE_FAILED_RETRY_MS = 60 * 1_000

interface SubscriptionUsageScheduler {
  readonly nowMs: () => number
  readonly setTimer: (fire: () => void, delayMs: number) => () => void
}

export interface SubscriptionUsageProfile {
  readonly id: string
  readonly directory: string
}

interface SubscriptionUsageAccountView {
  readonly providerId: string
  readonly instanceId: string
  readonly identity?: string
  readonly label?: string
}

type SubscriptionUsageAccountState =
  | { readonly kind: "supported"; readonly account: SubscriptionUsageAccountView; readonly snapshot: SubscriptionUsageSnapshot }
  | { readonly kind: "unsupported"; readonly account: SubscriptionUsageAccountView }
  | { readonly kind: "identity-unavailable"; readonly account: SubscriptionUsageAccountView }
  | { readonly kind: "expired-auth"; readonly account: SubscriptionUsageAccountView; readonly message: string }
  | { readonly kind: "stale"; readonly account: SubscriptionUsageAccountView; readonly snapshot: SubscriptionUsageSnapshot; readonly message?: string }
  | { readonly kind: "failure"; readonly account: SubscriptionUsageAccountView; readonly message: string; readonly snapshot?: SubscriptionUsageSnapshot }

interface SubscriptionUsageProfileGeneration {
  readonly generation: number
  readonly profileId: string
  readonly profileDirectory: string
  readonly providerIds: readonly string[]
  readonly enabledModuleIds: readonly string[]
  readonly readerProviderIds: readonly string[]
  readonly accounts: readonly SubscriptionUsageAccountView[]
  readonly thresholds: readonly number[]
  readonly identity: string
}

export interface SubscriptionUsagePublishedSnapshot {
  readonly generation: number
  readonly profileId: string
  readonly profileDirectory: string
  readonly checkedAtMs: number
  readonly thresholds: readonly number[]
  readonly accounts: readonly SubscriptionUsageAccountState[]
}

type SubscriptionUsageMetricEvidence =
  | { readonly kind: "fresh"; readonly metric: SubscriptionUsageMetric }
  | { readonly kind: "retained"; readonly metric: SubscriptionUsageMetric }
  | { readonly kind: "unknown" }

interface SubscriptionUsageServiceDeps {
  /** Captured once for this service's lifetime; the pool owns profile replacement. */
  readonly profile: () => SubscriptionUsageProfile
  readonly registry: () => AccessProviderRegistry
  readonly thresholds: () => readonly number[]
  readonly monitor?: boolean
  readonly freshnessMs?: number
  readonly now?: () => number
  readonly random?: () => number
  readonly scheduler?: SubscriptionUsageScheduler
  readonly openStore?: (profile: SubscriptionUsageProfile) => UsageAuthority
  /** The runtime's launch authority, which each reader receives (`SubscriptionUsageReaderContext`). */
  readonly launcher?: LauncherScope
}

export interface SubscriptionUsageService {
  readonly generation: () => SubscriptionUsageProfileGeneration | undefined
  readonly snapshot: () => SubscriptionUsagePublishedSnapshot | undefined
  /** The profile-service-owned durable authority, stable across refresh. Callers never dispose it. */
  readonly store: () => UsageAuthority | undefined
  /** The accounts of the current generation's providers as their owners hold them now: the auth store for a stored
   *  login, and the program for an external one. A paid-use decision is saved only for one of them. */
  readonly currentAccounts: () => readonly SubscriptionAccountIdentity[]
  /** Returns an exact current metric and states whether its provider evidence is fresh, retained, or unknown. */
  readonly metric: (providerId: string, instanceId: string, metricName: string) => SubscriptionUsageMetricEvidence
  /** Re-captures enabled providers and credentials within the service's fixed profile. */
  readonly refresh: () => Promise<SubscriptionUsageProfileGeneration | undefined>
  /** Replaces alert policy on the current generation without provider I/O. */
  readonly replaceThresholds: (thresholds: readonly number[]) => Promise<SubscriptionUsageProfileGeneration | undefined>
  /** Checks every captured account and publishes only after all accounts settle.
   *  Without `forceRefresh`, a check does not read an account whose evidence is
   *  fresh, or whose last read failed less than one retry spacing ago. */
  readonly check: (options?: { readonly forceRefresh?: boolean }) => Promise<SubscriptionUsagePublishedSnapshot | undefined>
  /** Checks only the exact captured provider/instance keys, coalesces provider work, and returns the complete current publication. `forceRefresh` has the same meaning as for `check`. */
  readonly checkAccounts: (accounts: readonly Pick<SubscriptionUsageAccountView, "providerId" | "instanceId">[], options?: { readonly forceRefresh?: boolean }) => Promise<SubscriptionUsagePublishedSnapshot | undefined>
  /** Prepares or resumes one durable exact-credit action before provider I/O. */
  readonly applyReset: (input: { readonly providerId: string; readonly instanceId: string; readonly authorityIncarnation: string; readonly revision: number; readonly actionId: string }) => Promise<SubscriptionUsageResetOutcome | { readonly kind: "stale" }>
  /** Observes settled current-state publications without owning provider or store lifecycle. */
  readonly onPublished: (listener: (snapshot: SubscriptionUsagePublishedSnapshot) => void) => () => void
  /** Arms the interactive monitor. Calling this for a non-interactive runtime is a no-op. */
  readonly start: () => void
  /** Stops optional polling while preserving admission evidence and accounting. */
  readonly pause: () => void
  /** Stops admission and aborts the current generation's network work. */
  readonly closeAdmission: () => void
  /** Joins generation transitions, network work, lease release, and store close. */
  readonly settled: () => Promise<void>
}

interface CapturedAccount {
  readonly view: SubscriptionUsageAccountView
  /** The provider whose credential collection holds this account. */
  readonly definition: AccessProviderDefinition
  readonly reader: SubscriptionUsageReader | undefined
  readonly resetConsumer: SubscriptionUsageResetConsumer | undefined
  state: SubscriptionUsageAccountState
  /** When the last provider read for this account settled; undefined before the first. */
  providerReadAtMs: number | undefined
  inFlight: Promise<void> | undefined
}

interface RuntimeGeneration {
  readonly classifySlot: CredentialSlotClassifier
  descriptor: SubscriptionUsageProfileGeneration
  readonly accounts: readonly CapturedAccount[]
  readonly abort: AbortController
  resetInFlight: Promise<SubscriptionUsageResetOutcome | { readonly kind: "stale" }> | undefined
  closed: boolean
}

interface CurrentUsage {
  readonly snapshot: SubscriptionUsageSnapshot | undefined
  readonly error: string | undefined
}

function defaultScheduler(): SubscriptionUsageScheduler {
  return {
    nowMs: () => Date.now(),
    setTimer: (fire, delayMs) => {
      const handle = setTimeout(fire, delayMs)
      handle.unref?.()
      return () => { clearTimeout(handle) }
    },
  }
}

function accountView(providerId: string, account: SubscriptionUsageRuntimeAccount): SubscriptionUsageAccountView {
  return Object.freeze({
    providerId,
    instanceId: account.instanceId,
    ...(account.identity === undefined ? {} : { identity: account.identity }),
    ...(account.label === undefined ? {} : { label: account.label }),
  })
}


function immutableThresholds(value: readonly number[]): readonly number[] {
  return Object.freeze([...value])
}

/** The accounts usage readers read, keyed by provider: every subscription
 *  account, and the stored key of each metered provider in `definitions`. */
function usageCredentials(definitions: readonly AccessProviderDefinition[], authDir: string, classifySlot: CredentialSlotClassifier): SubscriptionCredentials {
  const load = loadAuthStoreWithDiagnostics(authDir, undefined, classifySlot)
  const credentials = new Map(captureSubscriptionCredentials(definitions, { kind: "decoded", store: load.store, authDir }))
  for (const definition of definitions) {
    const key = definition.billing === "metered" ? meteredKeyAccount(load, definition) : undefined
    if (key !== undefined) credentials.set(definition.id, [key])
  }
  return credentials
}

function runtimeAccount(account: SubscriptionCredentials extends ReadonlyMap<string, readonly (infer Entry)[]> ? Entry : never): SubscriptionUsageRuntimeAccount {
  return account
}


function generationIdentity(input: {
  readonly profileId: string
  readonly profileDirectory: string
  readonly providerIds: readonly string[]
  readonly enabledModuleIds: readonly string[]
  readonly readerProviderIds: readonly string[]
  readonly generation: number
}): string {
  return JSON.stringify({
    profileId: input.profileId,
    profileDirectory: input.profileDirectory,
    providerIds: input.providerIds,
    enabledModuleIds: input.enabledModuleIds,
    readerProviderIds: input.readerProviderIds,
    generation: input.generation,
  })
}



function isFresh(snapshot: SubscriptionUsageSnapshot, nowMs: number, freshnessMs: number): boolean {
  return nowMs - snapshot.observedAtMs <= freshnessMs
}

function retainedState(account: SubscriptionUsageAccountView, message: string, snapshot: SubscriptionUsageSnapshot | undefined): SubscriptionUsageAccountState {
  return snapshot === undefined ? { kind: "failure", account, message } : { kind: "stale", account, snapshot, message }
}

function stateForFailure(
  account: SubscriptionUsageAccountView,
  message: string,
  snapshot: SubscriptionUsageSnapshot | undefined,
): SubscriptionUsageAccountState {
  return retainedState(account, snapshot === undefined ? message : `${message}; retained provider observation is inspection-only`, snapshot)
}

/** `providerName` is the provider's short name. An expired sign-in is the one
 *  outcome a person repairs, so its message names the provider and /auth. */
function stateForOutcome(
  account: SubscriptionUsageAccountView,
  providerName: string,
  outcome: SubscriptionUsageOutcome,
  snapshot: SubscriptionUsageSnapshot | undefined,
  committed: boolean,
): SubscriptionUsageAccountState {
  if (outcome.kind === "success" && committed && snapshot !== undefined) return { kind: "supported", account, snapshot }
  if (outcome.kind === "unsupported") return { kind: "unsupported", account }
  if (outcome.kind === "identity-unavailable") return { kind: "identity-unavailable", account }
  if (outcome.kind === "expired-auth") return snapshot === undefined
    ? { kind: "expired-auth", account, message: expiredSignInMessage(providerName) }
    : retainedState(account, `${expiredSignInMessage(providerName)} The usage shown is the last reading.`, snapshot)
  if (outcome.kind === "success") return stateForFailure(account, "subscription usage report was not committed", snapshot)
  const message = outcome.kind === "quota-error"
    ? outcome.status === undefined ? "subscription usage quota request failed" : `subscription usage quota request failed: ${outcome.status}`
    : "subscription usage request failed"
  return stateForFailure(account, message, snapshot)
}

function currentUsage(store: UsageAuthority | undefined, account: SubscriptionUsageAccount): CurrentUsage {
  if (store === undefined) return { snapshot: undefined, error: "subscription usage store is unavailable" }
  try {
    return { snapshot: store.current(account), error: undefined }
  } catch {
    return { snapshot: undefined, error: "subscription usage store read failed" }
  }
}

export function createSubscriptionUsageService(deps: SubscriptionUsageServiceDeps): SubscriptionUsageService {
  const profile = Object.freeze({ ...deps.profile() })
  const scheduler = deps.scheduler ?? defaultScheduler()
  const now = deps.now ?? scheduler.nowMs
  const freshnessMs = deps.freshnessMs ?? SUBSCRIPTION_USAGE_FRESHNESS_MS
  const random = deps.random ?? Math.random
  let sequence = 0
  let refreshSequence = 0
  let closed = false
  let started = false
  let current: RuntimeGeneration | undefined
  let thresholds = immutableThresholds(deps.thresholds())
  let published: SubscriptionUsagePublishedSnapshot | undefined
  const transitions = createOrderedLane()
  let monitorCycle: Promise<void> | undefined
  let monitorTimer: (() => void) | undefined
  let monitorNeedsImmediateCheck = false
  const publishedListeners = new Set<(snapshot: SubscriptionUsagePublishedSnapshot) => void>()

  const capture = (): RuntimeGeneration => {
    const registry = deps.registry()
    const readers = registry.usageReaders
    // A metered key has no allowance; only a provider that reads its balance makes it a usage account.
    const definitions = [...registry.selection.definitions]
      .filter((definition) => definition.billing === "subscription" || readers.has(definition.id))
      .toSorted((left, right) => left.id.localeCompare(right.id))
    const classifySlot = credentialSlotClassifier(registry.composition)
    const credentials = usageCredentials(definitions, profile.directory, classifySlot)
    const providerIds = Object.freeze(definitions.map((definition) => definition.id))
    const captured: CapturedAccount[] = []
    for (const definition of definitions) {
      const accounts = credentials.get(definition.id) ?? []
      for (const account of accounts) {
        // An account whose own billing is metered has no provider allowance; Usage lists it as a metered source.
        if (account.billing === "metered") continue
        const capturedAccount = runtimeAccount(account)
        const view = accountView(definition.id, capturedAccount)
        const reader = readers.get(definition.id)
        captured.push({
          view,
          definition,
          reader,
          resetConsumer: registry.resetConsumers?.get(definition.id),
          state: view.identity === undefined || view.identity.trim() === ""
            ? { kind: "identity-unavailable", account: view }
            : reader === undefined ? { kind: "unsupported", account: view }
            : { kind: "failure", account: view, message: "subscription usage has not been checked" },
          providerReadAtMs: undefined,
          inFlight: undefined,
        })
      }
    }
    const accounts = Object.freeze(captured)
    const capturedThresholds = thresholds
    const enabledModuleIds = Object.freeze("composition" in registry ? [...registry.composition.enabledModuleIds].toSorted() : [])
    const readerProviderIds = Object.freeze([...readers.keys()].filter((providerId) => providerIds.includes(providerId)).toSorted())
    const generation = ++sequence
    const descriptorInput = {
      profileId: profile.id,
      profileDirectory: profile.directory,
      providerIds,
      enabledModuleIds,
      readerProviderIds,
      accounts,
      generation,
    }
    const descriptor = Object.freeze({
      generation,
      profileId: profile.id,
      profileDirectory: profile.directory,
      providerIds,
      enabledModuleIds,
      readerProviderIds,
      accounts: Object.freeze(accounts.map((account) => account.view)),
      thresholds: capturedThresholds,
      identity: generationIdentity(descriptorInput),
    })
    return { descriptor, accounts, classifySlot, abort: new AbortController(), resetInFlight: undefined, closed: false }
  }

  const closeGeneration = async (generation: RuntimeGeneration): Promise<void> => {
    generation.closed = true
    generation.abort.abort()
    await Promise.all([...generation.accounts.map((account) => account.inFlight), generation.resetInFlight].map((work) => work?.catch(() => {})))
  }

  const publish = (generation: RuntimeGeneration): SubscriptionUsagePublishedSnapshot | undefined => {
    if (closed || generation.closed || current !== generation) return undefined
    const snapshot = Object.freeze({
      generation: generation.descriptor.generation,
      profileId: generation.descriptor.profileId,
      profileDirectory: generation.descriptor.profileDirectory,
      checkedAtMs: now(),
      thresholds,
      accounts: Object.freeze(generation.accounts.map((account) => account.state)),
    })
    if (published !== undefined && isDeepStrictEqual({ ...published, checkedAtMs: 0 }, { ...snapshot, checkedAtMs: 0 })) return published
    published = snapshot
    for (const listener of publishedListeners) listener(snapshot)
    return snapshot
  }

  /** The account as the auth store holds it now. Other owners rotate its
   *  OAuth tokens too, such as a model request or the model catalog. A check
   *  that used the credential captured with its generation refreshed an
   *  expired token on every check after another owner rotated it, and could
   *  never save the result, because the store no longer held the token it
   *  replaced. The store is the one source, so every check reads it. */
  const currentAccount = (generation: RuntimeGeneration, captured: CapturedAccount): SubscriptionUsageRuntimeAccount | undefined =>
    usageCredentials([captured.definition], generation.descriptor.profileDirectory, generation.classifySlot)
      .get(captured.definition.id)
      ?.find((account) => account.instanceId === captured.view.instanceId)

  const readAccount = async (generation: RuntimeGeneration, captured: CapturedAccount): Promise<SubscriptionUsageAccountState> => {
    const view = captured.view
    if (view.identity === undefined || view.identity.trim() === "") return { kind: "identity-unavailable", account: view }
    if (captured.reader === undefined) return { kind: "unsupported", account: view }
    const accountRef: SubscriptionUsageAccount = { providerId: view.providerId, instanceId: view.instanceId, identity: view.identity }
    const before = currentUsage(store, accountRef)
    if (store === undefined) return stateForFailure(view, before.error ?? "subscription usage store is unavailable", before.snapshot)
    let lease
    try {
      lease = await store.acquireFetch(accountRef, { signal: generation.abort.signal })
    } catch {
      return stateForFailure(view, "subscription usage fetch could not start", before.snapshot)
    }
    if (lease === undefined) {
      const after = currentUsage(store, accountRef)
      return retainedState(view, after.error ?? "subscription usage fetch is busy; retained provider observation is inspection-only", after.snapshot)
    }
    let outcome: SubscriptionUsageOutcome
    try {
      // An account removed since the capture has nothing to check until the
      // next capture drops it.
      const account = currentAccount(generation, captured)
      outcome = account === undefined ? { kind: "fetch-failure" } : await captured.reader({
        providerId: view.providerId,
        authDir: generation.descriptor.profileDirectory,
        account,
        signal: generation.abort.signal,
        ...(deps.launcher === undefined ? {} : { launcher: deps.launcher }),
        compareAndSetTokens: async (expected, next, signal) => {
          signal?.throwIfAborted()
          return replaceCredentialInstance(view.providerId, view.instanceId, storedTokensToCredential(expected), storedTokensToCredential(next), generation.descriptor.profileDirectory, generation.classifySlot, signal)
        },
      })
    } catch {
      outcome = { kind: "fetch-failure" }
    }
    captured.providerReadAtMs = now()
    try {
      const completion = store.completeFetch(lease, outcome, thresholds)
      const snapshot = outcome.kind === "success" && completion.snapshot !== undefined && outcome.report.resetCredits !== undefined ? { ...completion.snapshot, resetCredits: outcome.report.resetCredits } : completion.snapshot
      return stateForOutcome(view, captured.definition.shortName, outcome, snapshot, completion.kind === "committed")
    } catch {
      return retainedState(view, "subscription usage result could not be stored; retained provider observation is inspection-only", before.snapshot)
    }
  }

  /** An ordinary check needs no read while the account's evidence is fresh,
   *  or while its last provider read gave no evidence and is more recent than
   *  the retry spacing. A check that found the fetch lease busy read nothing,
   *  so the next check tries again. */
  const settledRecently = (captured: CapturedAccount): boolean => captured.state.kind === "supported"
    ? isFresh(captured.state.snapshot, now(), freshnessMs)
    : captured.providerReadAtMs !== undefined && now() - captured.providerReadAtMs < SUBSCRIPTION_USAGE_FAILED_RETRY_MS

  const checkAccount = (generation: RuntimeGeneration, captured: CapturedAccount, forceRefresh: boolean): Promise<void> => {
    if (captured.inFlight !== undefined) return captured.inFlight
    if (!forceRefresh && settledRecently(captured)) return Promise.resolve()
    const operation = readAccount(generation, captured).then((state) => { captured.state = state }).finally(() => { captured.inFlight = undefined })
    captured.inFlight = operation
    return operation
  }

  const checkGeneration = async (generation: RuntimeGeneration, forceRefresh: boolean, accounts = generation.accounts): Promise<SubscriptionUsagePublishedSnapshot | undefined> => {
    if (closed || generation.closed || current !== generation) return undefined
    await Promise.all(accounts.map((captured) => checkAccount(generation, captured, forceRefresh)))
    return publish(generation)
  }

  const checkCurrent = (forceRefresh: boolean): Promise<SubscriptionUsagePublishedSnapshot | undefined> => {
    if (closed) return Promise.resolve(undefined)
    const generation = current
    if (generation === undefined) return Promise.resolve(undefined)
    return checkGeneration(generation, forceRefresh)
  }

  const scheduleMonitor = (): void => {
    if (closed || !started || monitorTimer !== undefined || monitorCycle !== undefined) return
    const randomValue = Math.min(1, Math.max(0, random()))
    const multiplier = 1 - SUBSCRIPTION_USAGE_JITTER_FRACTION + randomValue * SUBSCRIPTION_USAGE_JITTER_FRACTION * 2
    monitorTimer = scheduler.setTimer(() => {
      monitorTimer = undefined
      startMonitorCycle()
    }, Math.round(SUBSCRIPTION_USAGE_CHECK_INTERVAL_MS * multiplier))
  }

  const startMonitorCycle = (): void => {
    if (closed || !started || monitorCycle !== undefined) return
    monitorCycle = checkCurrent(false).catch(() => undefined).then(() => {}).finally(() => {
      monitorCycle = undefined
      if (closed) return
      if (monitorNeedsImmediateCheck) {
        monitorNeedsImmediateCheck = false
        startMonitorCycle()
      } else {
        scheduleMonitor()
      }
    })
  }

  const refresh = (): Promise<SubscriptionUsageProfileGeneration | undefined> => {
    const request = ++refreshSequence
    return transitions.run(async () => {
      if (closed || request !== refreshSequence) return current?.descriptor
      const candidate = capture()
      const previous = current
      if (previous !== undefined) await closeGeneration(previous)
      if (closed || request !== refreshSequence) {
        await closeGeneration(candidate)
        return current?.descriptor
      }
      current = candidate
      published = undefined
      if (started) {
        monitorNeedsImmediateCheck = true
        monitorTimer?.()
        monitorTimer = undefined
        if (monitorCycle === undefined) startMonitorCycle()
      }
      return candidate.descriptor
    })
  }

  current = capture()
  const store = existsSync(profile.directory)
    ? (deps.openStore ?? ((value) => createUsageAuthority({ profileDir: value.directory, profileId: value.id })))(profile)
    : undefined

  return {
    generation: () => current?.descriptor,
    currentAccounts: () => {
      const generation = current
      if (generation === undefined) return []
      const definitions = [...new Set(generation.accounts.map(({ definition }) => definition))]
      const credentials = captureSubscriptionCredentials(definitions, { kind: "persisted", authDir: generation.descriptor.profileDirectory, classifySlot: generation.classifySlot })
      return [...credentials].flatMap(([providerId, accounts]) => accounts.flatMap(({ instanceId, identity }) =>
        identity === undefined || identity.trim() === "" ? [] : [createSubscriptionAccountIdentity(providerId, instanceId, identity)]))
    },
    store: () => store,
    snapshot: () => published,
    metric: (providerId, instanceId, metricName) => {
      const generation = current
      const snapshot = published
      if (generation === undefined || snapshot === undefined || snapshot.generation !== generation.descriptor.generation) return { kind: "unknown" }
      const state = snapshot.accounts.find((entry) => entry.account.providerId === providerId && entry.account.instanceId === instanceId)
      if (state === undefined || !("snapshot" in state) || state.snapshot === undefined) return { kind: "unknown" }
      const metric = state.snapshot.metrics.find((entry) => entry.metricKey === metricName)
      if (metric === undefined) return { kind: "unknown" }
      return state.kind === "supported" && isFresh(state.snapshot, now(), freshnessMs)
        ? { kind: "fresh", metric }
        : { kind: "retained", metric }
    },
    applyReset: async (input) => {
      const generation = current
      if (closed || generation === undefined || generation.closed) return { kind: "noCredit" }
      if (generation.resetInFlight !== undefined) return generation.resetInFlight
      const operation = (async (): Promise<SubscriptionUsageResetOutcome | { readonly kind: "stale" }> => {
        let outcome: SubscriptionUsageResetOutcome | { readonly kind: "stale" } = { kind: "noCredit" }
        try {
          const captured = generation.accounts.find((entry) => entry.view.providerId === input.providerId && entry.view.instanceId === input.instanceId)
          const resetConsumer = captured?.resetConsumer
          const credential = captured === undefined ? undefined : currentAccount(generation, captured)?.credential
          const identity = captured?.view.identity
          if (store !== undefined && resetConsumer !== undefined && credential?.type === "oauth" && identity !== undefined) {
            const prepared = store.prepareReset({ account: { providerId: input.providerId, instanceId: input.instanceId, identity }, expectedIncarnation: input.authorityIncarnation, expectedRevision: input.revision, actionId: input.actionId, providerKey: crypto.randomUUID() })
            if (prepared.kind === "stale") outcome = { kind: "stale" }
            else if (prepared.kind === "no-credit") outcome = { kind: "noCredit" }
            else {
              outcome = await resetConsumer({ accessToken: credential.access, accountId: credential.accountId, creditId: prepared.checkpoint.creditId, providerKey: prepared.checkpoint.providerKey, signal: generation.abort.signal })
              if (outcome.kind !== "uncertain") store.completeReset(prepared.checkpoint)
            }
          }
        } catch {
          outcome = { kind: "uncertain" }
        }
        const accounts = generation.accounts.filter((entry) => entry.view.providerId === input.providerId && entry.view.instanceId === input.instanceId)
        // A pending reader can hold pre-reset metrics while it awaits credit details.
        await Promise.all(accounts.map((account) => account.inFlight))
        await checkGeneration(generation, true, accounts)
        return outcome
      })()
      generation.resetInFlight = operation
      try { return await operation } finally { if (generation.resetInFlight === operation) generation.resetInFlight = undefined }
    },
    refresh,
    replaceThresholds: (nextThresholds) => transitions.run(() => {
      const generation = current
      if (closed || generation === undefined) return generation?.descriptor
      const next = immutableThresholds(nextThresholds)
      if (published !== undefined) {
        for (const state of published.accounts) {
          if (!("snapshot" in state) || state.snapshot === undefined) continue
          for (const metric of state.snapshot.metrics) store?.setThresholds(state.snapshot, metric.metricKey, next)
        }
      }
      thresholds = next
      generation.descriptor = Object.freeze({ ...generation.descriptor, thresholds })
      if (published !== undefined) publish(generation)
      return generation.descriptor
    }),
    check: async (options) => {
      await transitions.settled()
      return checkCurrent(options?.forceRefresh === true)
    },
    checkAccounts: async (accounts, options) => {
      await transitions.settled()
      const generation = current
      if (closed || generation === undefined || generation.closed) return undefined
      const selected = generation.accounts.filter((captured) => accounts.some((account) => account.providerId === captured.view.providerId && account.instanceId === captured.view.instanceId))
      if (selected.length === 0) return published
      return checkGeneration(generation, options?.forceRefresh === true, selected)
    },
    onPublished: (listener) => {
      if (closed) return () => {}
      publishedListeners.add(listener)
      return () => { publishedListeners.delete(listener) }
    },
    start: () => {
      if (closed || started || deps.monitor !== true) return
      started = true
      startMonitorCycle()
    },
    pause: () => {
      started = false
      monitorNeedsImmediateCheck = false
      monitorTimer?.()
      monitorTimer = undefined
    },
    closeAdmission: () => {
      closed = true
      publishedListeners.clear()
      monitorTimer?.()
      monitorTimer = undefined
      current?.abort.abort()
    },
    settled: async () => {
      await transitions.settled()
      await monitorCycle?.catch(() => {})
      if (current !== undefined) await closeGeneration(current)
      store?.dispose()
    },
  }
}
