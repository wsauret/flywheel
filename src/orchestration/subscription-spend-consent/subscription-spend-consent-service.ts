import type { SubscriptionSpendConsentStatus, SubscriptionSpendEnvelope } from "../../infra/auth/subscription-spend-consent.js";
import { createSubscriptionSpendEnvelope } from "../../infra/auth/subscription-spend-consent.js";
import { SubscriptionSpendConsentCorruptError, SubscriptionSpendConsentStaleError, type SubscriptionSpendConsentStore } from "../../infra/auth/subscription-spend-consent-store.js";
import { createSubscriptionAccountIdentity, type SubscriptionAccountIdentity } from "../../infra/llm/subscription-account-identity.js";
import type { SubscriptionUsageSpendSource } from "../../infra/llm/subscription-usage.js";
import type { SubscriptionUsageService } from "../auth/provider-observations/subscription-usage-service.js";
import { SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE, subscriptionSpendAccountCorrelationId, type SubscriptionSpendConsentMutation, type SubscriptionSpendConsentMutationResult, type SubscriptionSpendConsentView } from "../../protocol/subscription-spend-consent-protocol-types.js";

interface SubscriptionSpendConsentRow {
  readonly envelope: SubscriptionSpendEnvelope;
  readonly status: SubscriptionSpendConsentStatus;
  readonly label?: string;
}

export interface SubscriptionSpendAuthorization {
  readonly envelope: SubscriptionSpendEnvelope;
  readonly profileId: string;
  readonly account: SubscriptionAccountIdentity;
  readonly authorityIncarnation: string;
  readonly authorityRevision: number;
}

export interface SubscriptionSpendConsentCapture {
  readonly profileId: string;
  readonly usageGeneration?: number;
  readonly authorityIncarnation?: string;
  readonly authorityRevision?: number;
  readonly rows: readonly SubscriptionSpendConsentRow[];
  readonly authorizations: ReadonlyMap<string, SubscriptionSpendAuthorization>;
  readonly message?: typeof SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE;
}

export interface SubscriptionSpendConsentService {
  /** Captures saved permissions for verified auth identities without reading usage evidence. */
  capture(): Promise<SubscriptionSpendConsentCapture>;
  view(): Promise<SubscriptionSpendConsentView>;
  mutate(mutation: SubscriptionSpendConsentMutation): Promise<SubscriptionSpendConsentMutationResult>;
}

interface SubscriptionSpendConsentServiceOptions {
  readonly profileId: string;
  readonly usage: Pick<SubscriptionUsageService, "generation" | "snapshot">;
  readonly paidModes: (providerId: string) => readonly SubscriptionSpendEnvelope["mode"][];
  readonly consent: SubscriptionSpendConsentStore;
  readonly providerPresentation?: (providerId: string) => { readonly providerDisplayName: string; readonly billingUrl?: string };
}

class FrozenAuthorizationMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(entries: readonly (readonly [K, V])[]) {
    this.#values = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#values.size; }
  get(key: K): V | undefined { return this.#values.get(key); }
  has(key: K): boolean { return this.#values.has(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
}

const EMPTY_AUTHORIZATIONS: ReadonlyMap<string, SubscriptionSpendAuthorization> = new FrozenAuthorizationMap([]);

function failedCapture(profileId: string): SubscriptionSpendConsentCapture {
  return Object.freeze({
    profileId,
    rows: Object.freeze([]),
    authorizations: EMPTY_AUTHORIZATIONS,
    message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE,
  });
}

function evidenceFor(mode: SubscriptionSpendEnvelope["mode"], sources: readonly SubscriptionUsageSpendSource[]): SubscriptionUsageSpendSource {
  const source = sources.find((candidate) => mode === "prepaid" ? candidate.kind === "prepaid" : candidate.kind === "automatic-billing");
  return source ?? (mode === "prepaid" ? { kind: "prepaid", availability: "unknown" } : { kind: "automatic-billing", enablement: "unknown" });
}

function immutableSpendSource(source: SubscriptionUsageSpendSource): SubscriptionUsageSpendSource {
  return Object.freeze({
    ...source,
    ...(source.kind === "automatic-billing" || source.availability === "funded"
      ? {
          ...(source.used === undefined ? {} : { used: Object.freeze({ ...source.used }) }),
          ...(source.limit === undefined ? {} : { limit: Object.freeze({ ...source.limit }) }),
          ...(source.remaining === undefined ? {} : { remaining: Object.freeze({ ...source.remaining }) }),
        }
      : {}),
  });
}

function protocolView(capture: SubscriptionSpendConsentCapture, options: SubscriptionSpendConsentServiceOptions): SubscriptionSpendConsentView {
  if (capture.authorityIncarnation === undefined || capture.authorityRevision === undefined || capture.usageGeneration === undefined) return Object.freeze({ kind: "unavailable", profileId: capture.profileId, message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE });
  const accounts = new Map<string, {
    accountCorrelationId: string;
    providerId: string;
    providerDisplayName: string;
    billingUrl?: string;
    label?: string;
    plan?: string;
    tier?: string;
    providerStatus: "ok" | "warning" | "exhausted" | "unknown";
    modes: Array<{ mode: "prepaid" | "automatic"; envelopeId: string; evidence: SubscriptionUsageSpendSource; decision: SubscriptionSpendConsentStatus }>;
  }>();
  const usage = options.usage.snapshot();
  const usageAccounts = new Map(usage?.profileId === capture.profileId && usage.generation === capture.usageGeneration
    ? usage.accounts.map((state) => [`${state.account.providerId}\0${state.account.instanceId}`, state] as const)
    : []);
  for (const row of capture.rows) {
    const accountCorrelationId = subscriptionSpendAccountCorrelationId(capture.profileId, row.envelope.providerId, row.envelope.instanceId);
    const state = usageAccounts.get(`${row.envelope.providerId}\0${row.envelope.instanceId}`);
    // Any retained reading of this subject is shown, whatever its age: readings track spend and never gate it (PI-MODEL-018).
    const snapshot = state !== undefined && "snapshot" in state && state.snapshot?.subjectDigest === row.envelope.subjectDigest ? state.snapshot : undefined;
    let account = accounts.get(accountCorrelationId);
    if (account === undefined) {
      const presentation = options.providerPresentation?.(row.envelope.providerId) ?? { providerDisplayName: row.envelope.providerId };
      account = {
        accountCorrelationId,
        providerId: row.envelope.providerId,
        providerDisplayName: presentation.providerDisplayName,
        ...(presentation.billingUrl === undefined ? {} : { billingUrl: presentation.billingUrl }),
        ...(row.label === undefined ? {} : { label: row.label }),
        ...(snapshot?.plan === undefined ? {} : { plan: snapshot.plan }),
        ...(snapshot?.tier === undefined ? {} : { tier: snapshot.tier }),
        providerStatus: snapshot?.providerStatus ?? "unknown",
        modes: [],
      };
      accounts.set(accountCorrelationId, account);
    }
    account.modes.push({ mode: row.envelope.mode, envelopeId: row.envelope.id, evidence: immutableSpendSource(evidenceFor(row.envelope.mode, snapshot?.spendSources ?? [])), decision: row.status });
  }
  return Object.freeze({
    kind: "available",
    profileId: capture.profileId,
    usageGeneration: capture.usageGeneration,
    authorityIncarnation: capture.authorityIncarnation,
    authorityRevision: capture.authorityRevision,
    accounts: Object.freeze([...accounts.values()].map((account) => Object.freeze({ ...account, modes: Object.freeze(account.modes.map((mode) => Object.freeze(mode))) }))),
  });
}

interface CurrentEnvelopes {
  readonly generation: number;
  readonly derived: readonly { readonly envelope: SubscriptionSpendEnvelope; readonly label?: string }[];
}

function currentEnvelopes(options: SubscriptionSpendConsentServiceOptions): CurrentEnvelopes | undefined {
  const generation = options.usage.generation();
  if (generation === undefined || generation.profileId !== options.profileId) return undefined;
  const derived: Array<{ readonly envelope: SubscriptionSpendEnvelope; readonly label?: string }> = [];
  const envelopeIds = new Set<string>();
  // The generation contains auth identities before any usage read and excludes usage-only accounts.
  for (const accountView of generation.accounts) {
    if (accountView.identity === undefined || accountView.identity.trim() === "") continue;
    const account = createSubscriptionAccountIdentity(accountView.providerId, accountView.instanceId, accountView.identity);
    for (const mode of options.paidModes(accountView.providerId)) {
      const envelope = Object.freeze(createSubscriptionSpendEnvelope(options.profileId, account, mode));
      if (envelopeIds.has(envelope.id)) continue;
      envelopeIds.add(envelope.id);
      derived.push({ envelope, ...(accountView.label === undefined ? {} : { label: accountView.label }) });
    }
  }
  return { generation: generation.generation, derived };
}
/** Joins verified auth identities to durable consent. Usage evidence is read only for the review view. */
export function createSubscriptionSpendConsentService(options: SubscriptionSpendConsentServiceOptions): SubscriptionSpendConsentService {
  if (options.profileId.length === 0) throw new Error("subscription spend consent profileId must be non-empty");

  const capture = async (): Promise<SubscriptionSpendConsentCapture> => {
    const current = currentEnvelopes(options);
    if (current === undefined) return failedCapture(options.profileId);
    const { derived, generation } = current;

    const consent = await options.consent.read(derived.map(({ envelope }) => envelope));
    if (consent.profileId !== options.profileId) return failedCapture(options.profileId);
    const decisions = new Map(consent.envelopes.map((state) => [state.envelope.id, state.status]));
    const rows = Object.freeze(derived.map(({ envelope, label }): SubscriptionSpendConsentRow => Object.freeze({
      envelope,
      status: decisions.get(envelope.id) ?? "unreviewed",
      ...(label === undefined ? {} : { label }),
    })));
    const authorizations = new FrozenAuthorizationMap(rows.flatMap((row): readonly (readonly [string, SubscriptionSpendAuthorization])[] => row.status !== "accepted" ? [] : [[row.envelope.id, Object.freeze({
      envelope: row.envelope,
      profileId: options.profileId,
      account: Object.freeze({ providerId: row.envelope.providerId, instanceId: row.envelope.instanceId, subjectDigest: row.envelope.subjectDigest }),
      authorityIncarnation: consent.incarnation,
      authorityRevision: consent.revision,
    })]]));
    return Object.freeze({ profileId: options.profileId, usageGeneration: generation, authorityIncarnation: consent.incarnation, authorityRevision: consent.revision, rows, authorizations });
  };

  return {
    capture,
    view: async () => protocolView(await capture(), options),
    mutate: async (mutation) => {
      if (mutation.profileId !== options.profileId) return { kind: "stale" };
      try {
        const current = await capture();
        if (current.usageGeneration !== mutation.usageGeneration
          || current.authorityIncarnation !== mutation.authorityIncarnation
          || current.authorityRevision !== mutation.authorityRevision) return { kind: "stale" };
        const currentIds = current.rows.map((row) => row.envelope.id);
        if (currentIds.length !== mutation.envelopeIds.length || currentIds.some((id, index) => id !== mutation.envelopeIds[index])) return { kind: "invalid-envelope" };
        const envelopes = current.rows.map((row) => row.envelope);
        const reviewedIds = new Set(mutation.reviewedEnvelopeIds);
        const acceptedIds = new Set(mutation.acceptedEnvelopeIds);
        if (reviewedIds.size !== mutation.reviewedEnvelopeIds.length
          || acceptedIds.size !== mutation.acceptedEnvelopeIds.length
          || [...acceptedIds].some((id) => !reviewedIds.has(id))
          || [...reviewedIds].some((id) => !current.rows.some((row) => row.envelope.id === id))) return { kind: "invalid-envelope" };
        const isEvidenceCurrent = (): boolean => {
          const evidence = currentEnvelopes(options);
          if (evidence === undefined || evidence.generation !== mutation.usageGeneration) return false;
          const ids = evidence.derived.map(({ envelope }) => envelope.id);
          return ids.length === envelopes.length && ids.every((id, index) => id === envelopes[index]?.id);
        };
        await options.consent.save({ expectedIncarnation: mutation.authorityIncarnation, expectedRevision: mutation.authorityRevision, envelopes, reviewedEnvelopeIds: mutation.reviewedEnvelopeIds, acceptedEnvelopeIds: mutation.acceptedEnvelopeIds, isEvidenceCurrent });
        return { kind: "committed", consent: protocolView(await capture(), options) };
      } catch (error) {
        if (error instanceof SubscriptionSpendConsentStaleError) return { kind: error.message.includes("envelope") || error.message.includes("account") ? "invalid-envelope" : "stale" };
        if (error instanceof SubscriptionSpendConsentCorruptError) return { kind: "storage-failure" };
        if (error instanceof Error && /lock|busy|contention/i.test(error.message)) return { kind: "contention" };
        return { kind: "storage-failure" };
      }
    },
  };
}
