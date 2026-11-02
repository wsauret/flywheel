/** Provider model discovery with one first-party then models.dev fallback. */
import { createHash } from "node:crypto";
import { Redacted } from "effect";
import { apiKey, currentCredentialLineage, type AuthContext, type CapturedSubscriptionCredential, type OAuthPersistencePolicy, type RuntimeCredential, type SubscriptionCredentials } from "../auth/auth-context.js";
import type { CredentialLineages, CredentialSlotClassifier } from "../auth/auth-store-types.js";
import { deleteProviderModelCatalog, liveModelRefusals, readSavedProviderModels, recordProviderModelAccess, writeProviderModelCatalog, writeProviderModelCandidates, type CatalogProfile, type ModelRefusal, type ProviderModelAccessSnapshot, type SavedModelRefusals } from "../auth/provider-model-catalog-store.js";
import { openExistingAuthProfileDirectory } from "../auth/auth-profile-store.js";
import { createSavedListingEvidence } from "./model-listing-evidence.js";
import { BoundedJsonError, readBoundedJson, readBoundedJsonWithByteLength } from "../auth/bounded-json.js";
import { accessProviderAccountIdentity, accessProviderAccountKey, compareAutomaticSelection, type AccessProviderAccountIdentity, type AccessProviderAccessOutcome, type AccessProviderCandidate, type AccessProviderCatalogFetchResult, type AccessProviderDefinition, type AccessProviderId, type AccessProviderSelection } from "./access-provider.js";
import { customProviderById } from "./custom-provider-registry.js";
import { recordCatalogDiscoveryDiagnostics, recordProviderCatalogFailure, type CatalogDiscoveryDiagnostics } from "./model-catalog-diagnostics.js";
import { resolveModelCatalog, type CatalogCanonicalRow, type CatalogDiscovery, type CatalogLimits, type CatalogModelOffering, type ModelCatalogContribution, type ResolvedModelCatalog } from "./model-catalog-resolution.js";
import { catalogRowsToModelMap, decodeDiscoveryRows, joinCatalogRows, modelsDevBaseline, preferredCatalog, reconcileSavedCatalogRows, staticOfferingMap, withModelRefusals, type SharedModelsDevBaseline } from "./model-listing-rows.js";
import { settleTasks } from "./model-listing-settlement.js";
import type { ModelsClient } from "./models.js";
import { isMovingModelAlias } from "./model-id.js";
import { providerRequestHeaders } from "./provider-request-identity.js";
import type { LauncherScope } from "../process-supervisor.js";
import { fillCatalogRouteModelInfos, isListableRoute, sharedModelInfos } from "./provider-model-info.js";
import { DebugLog } from "../debug-log.js";

const REQUEST_TIMEOUT_MS = 10_000;
/** The shared deadline of one listing call. A caller about to route requests waits no longer than this for the
 *  access audit that follows a listing either. */
export const LISTING_SETTLEMENT_MS = 15_000;
const MAX_FETCH_CONCURRENCY = 4;

export interface RequestHeaders { [name: string]: string }

function singletonCredential(providerId: AccessProviderId, auth: AuthContext): RuntimeCredential | undefined {
  const key = apiKey(auth, providerId);
  return key ? { type: "api_key", key } : undefined;
}

export function classifyFetchFailure(error: unknown): CatalogDiscovery {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return { kind: "failed", reason: "timeout" };
  if (error instanceof BoundedJsonError) {
    return { kind: "failed", reason: error.kind === "body_too_large" ? "oversized" : "malformed" };
  }
  if (error instanceof Error && /exceeds|too large|content-length/i.test(error.message)) return { kind: "failed", reason: "oversized" };
  if (error instanceof SyntaxError || error instanceof TypeError) return { kind: "failed", reason: "malformed" };
  return { kind: "failed", reason: "transport" };
}

/** One unpaginated provider listing request, classified for the resolver. Provider modules call it from their catalog fetch. */
export async function fetchCatalog(url: string, headers: RequestHeaders | undefined, contribution: Pick<ModelCatalogContribution, "limits" | "extractRows">, signal: AbortSignal): Promise<CatalogDiscovery> {
  try {
    const response = await fetch(url, { headers: { ...await providerRequestHeaders(), ...headers }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
    if (response.status === 401 || response.status === 403) return { kind: "auth-invalid", status: response.status };
    if (!response.ok) return { kind: "failed", reason: "http", status: response.status };
    const body = await readBoundedJson(response, contribution.limits.responseBytes);
    const rows = contribution.extractRows(body);
    if (rows.length > contribution.limits.canonicalRows) throw new TypeError("model catalog exceeds the row limit");
    return { kind: "rows", rows };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return classifyFetchFailure(error);
  }
}

/** A provider listing that pages: `nextPage` reads the page's cursor from its body, or ends the walk. */
export async function fetchPaginatedCatalog(
  url: string,
  headers: RequestHeaders,
  contribution: Pick<ModelCatalogContribution, "limits" | "extractRows">,
  signal: AbortSignal,
  nextPage: (body: unknown, currentUrl: string) => string | undefined,
): Promise<CatalogDiscovery> {
  const rows: unknown[] = [];
  const visited = new Set<string>();
  let pageUrl: string | undefined = url;
  let pages = 0;
  let retainedBytes = 0;
  while (pageUrl !== undefined) {
    try {
      if (visited.has(pageUrl) || pages >= contribution.limits.canonicalRows) {
        throw new TypeError("model catalog pagination did not make bounded progress");
      }
      visited.add(pageUrl);
      pages += 1;
      const response = await fetch(pageUrl, { headers: { ...await providerRequestHeaders(), ...headers }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
      if (response.status === 401 || response.status === 403) return { kind: "auth-invalid", status: response.status };
      if (!response.ok) return { kind: "failed", reason: "http", status: response.status };
      const page = await readBoundedJsonWithByteLength(response, contribution.limits.responseBytes);
      retainedBytes += page.byteLength;
      if (retainedBytes > contribution.limits.responseBytes) throw new BoundedJsonError("body_too_large");
      const body = page.value;
      const pageRows = contribution.extractRows(body);
      if (rows.length + pageRows.length > contribution.limits.canonicalRows) {
        throw new TypeError("model catalog pagination exceeds the row limit");
      }
      rows.push(...pageRows);
      const nextUrl = nextPage(body, pageUrl);
      if (nextUrl !== undefined && visited.has(nextUrl)) {
        throw new TypeError("model catalog pagination cursor did not advance");
      }
      pageUrl = nextUrl;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return classifyFetchFailure(error);
    }
  }
  return { kind: "rows", rows };
}

/** Runs the definition's own listing fetch for one candidate, or nothing when
 *  the provider has no first-party listing or the account holds no credential. */
async function fetchProviderCatalog(
  definition: AccessProviderDefinition,
  auth: AuthContext,
  instance: CapturedSubscriptionCredential | undefined,
  options: ModelListingClientOptions,
  signal: AbortSignal,
  launcher: LauncherScope | undefined,
): Promise<AccessProviderCatalogFetchResult | undefined> {
  const contribution = definition.dynamicCatalog;
  const credential = instance?.credential ?? singletonCredential(definition.id, auth);
  if (contribution?.fetch === undefined || !credential) return undefined;
  return contribution.fetch({
    credential,
    ...(instance === undefined ? {} : { instance }),
    authDir: options.authDir,
    classifySlot: options.classifySlot,
    oauthPersistence: options.oauthPersistence ?? "profile",
    signal,
    ...(launcher === undefined ? {} : { launcher }),
  });
}

function runtimeCredentialIdentity(credential: RuntimeCredential): string {
  const material = credential.type === "api_key" ? Redacted.value(credential.key)
    : credential.type === "external" ? credential.configDir
    : `${Redacted.value(credential.access)}\0${credential.refresh === undefined ? "" : Redacted.value(credential.refresh)}`;
  return createHash("sha256").update(material).digest("hex");
}

interface AccessProviderCandidateModels {
  readonly models: ReadonlyMap<string, readonly CatalogModelOffering[]> | null;
  readonly visibleModels?: ReadonlyMap<string, readonly CatalogModelOffering[]>;
  readonly outcome?: ResolvedModelCatalog;
  readonly diagnostics?: CatalogDiscoveryDiagnostics;
  /** Present for an audited subscription, including candidates without saved results. */
  readonly audit?: AccessAuditStatus;
}

/** Candidate-key map entries carry the typed candidate: the key is an opaque
 *  identity string, so readers take the candidate from the value and never
 *  decode the key. */
interface AccessProviderCandidateCatalog extends AccessProviderCandidateModels {
  readonly candidate: AccessProviderCandidate;
}

interface AccessProviderModelCatalogs {
  readonly providers: ReadonlyMap<AccessProviderId, ReadonlySet<string>>;
  readonly candidates: ReadonlyMap<string, AccessProviderCandidateCatalog>;
}

type ModelsDevBaselineForListing = (contribution: ModelCatalogContribution) => SharedModelsDevBaseline;

export interface ModelListingClient {
  getModelCatalogs(auth: AuthContext, request?: ModelListingRequest): Promise<AccessProviderModelCatalogs>;
  /** Saves what a served request proved about one wire model for the exact account generation that `auth` and
   *  `subscriptions` hold, and the next listing applies it. Returns false, and saves nothing, for an access-only
   *  connection, a provider without a saved catalog, or a credential that is no longer current. A failed write is a
   *  warning, never an error. */
  recordModelRefusal(input: ModelRefusalInput): Promise<boolean>;
}

interface ModelRefusalInput {
  readonly auth: AuthContext;
  readonly subscriptions: SubscriptionCredentials;
  readonly candidate: AccessProviderCandidate;
  readonly wireModelId: string;
  readonly refusal: ModelRefusal;
}

/** One candidate's listing and the live and ended refusals saved for its account generation. */
interface ListedCandidate {
  readonly listed: AccessProviderCandidateModels;
  readonly refusals: SavedModelRefusals;
}

/** The inputs that belong to one listing call. */
interface ModelListingRequest {
  readonly signal?: AbortSignal;
  /** `cached-first` when absent. */
  readonly mode?: ModelDiscoveryMode;
  /** Reports each conclusive probe result of an `audit` listing; no other mode probes. */
  readonly onAccessAudit?: AccessAuditProgressListener;
  /** Scopes an `audit` listing to that one exact account and marks it manual: every current candidate of the account is probed again, and no other account is probed. */
  readonly recheckAccount?: AccessProviderAccountIdentity;
  /** The caller's launch authority. A provider whose listing runs a local process launches it only in this scope, so
   *  the process ends with the caller; without a scope that listing fails and its fallback applies. */
  readonly launcher?: LauncherScope;
}

/** What every candidate of one listing call shares. */
interface ListingPass {
  readonly mode: ModelDiscoveryMode;
  readonly baselineForListing: ModelsDevBaselineForListing;
  readonly onAccessAudit: AccessAuditProgressListener | undefined;
  readonly recheckAccount: AccessProviderAccountIdentity | undefined;
  readonly launcher: LauncherScope | undefined;
}
/** `cached-first` reads saved evidence only. `fresh` (interactive) and `refresh`
 *  (owned) fetch the provider listing and record audit candidates, and probe
 *  nothing. `audit` fetches no listing and probes what saved audits leave due;
 *  every other provider reads as it does under `cached-first`. */
export type ModelDiscoveryMode = "cached-first" | "refresh" | "fresh" | "audit";

export interface ModelListingClientOptions {
  readonly authDir: string;
  readonly classifySlot: CredentialSlotClassifier;
  readonly providers: AccessProviderSelection;
  readonly oauthPersistence?: OAuthPersistencePolicy;
  readonly modelAccess?: readonly ProviderModelAccessSnapshot[];
  readonly modelsClient?: ModelsClient;
  readonly captureSubscriptions?: () => SubscriptionCredentials;
  readonly captureCredentialLineages?: () => CredentialLineages;
  readonly settlementTimeoutMs?: number;
  readonly maxFetchConcurrency?: number;
  /** The latest discovery diagnostic recorded for each provider. A process
   *  shares one across the listing generations it replaces, so an unchanged
   *  condition records once per process, not once per generation. */
  readonly diagnosedDiscoveries?: Map<string, string>;
  /** The clock that decides whether a saved refusal still applies. */
  readonly now?: () => number;
}

/** One conclusive probe result, reported after its durable commit. `remaining` counts the probes still due. */
export interface AccessAuditProgress {
  readonly account: AccessProviderAccountIdentity;
  readonly remaining: number;
  readonly modelId: string;
  readonly outcome: "completed" | "refused";
}
export type AccessAuditProgressListener = (progress: AccessAuditProgress) => Promise<void> | void;

/** What the saved audit of one account leaves: probes still due and models refused (a recheck can retry either). */
export interface AccessAuditStatus {
  readonly remaining: number;
  readonly refused: number;
}

function isDiscoveredListing(discovery: CatalogDiscovery | undefined): boolean {
  return discovery?.kind === "rows" || discovery?.kind === "decoded-rows" || discovery?.kind === "resolved-rows";
}

/** Whether the shared settlement deadline, not a caller, ended the signal. */
function settlementTimedOut(signal: AbortSignal): boolean {
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
}

/** The usable, stable-id models.dev rows an audited account lists.
 *  The SuperGrok factory selects Responses independently of this catalog metadata. */
function auditCandidateRows(rows: readonly CatalogCanonicalRow[]): readonly CatalogCanonicalRow[] {
  return rows.flatMap((row) => {
    const offerings = row.offerings
      .filter((offering) => isListableRoute(offering) && !isMovingModelAlias(offering.wireModelId));
    return offerings.length === 0 ? [] : [{ modelId: row.modelId, offerings }];
  });
}

export function createModelListingClient(options: ModelListingClientOptions): ModelListingClient {
  const captureSubscriptions: () => SubscriptionCredentials = options.captureSubscriptions
    ?? (() => new Map<string, readonly CapturedSubscriptionCredential[]>());
  const definitions = new Map(options.providers.definitions.map((definition) => [definition.id, definition]));
  const now = options.now ?? Date.now;
  const diagnosedDiscoveries = options.diagnosedDiscoveries ?? new Map<string, string>();
  function capturedCredentialLineage(candidate: AccessProviderCandidate, auth: AuthContext, instance: CapturedSubscriptionCredential | undefined): string | undefined {
    return candidate.kind === "subscription" ? instance?.lineageId : auth.credentialLineages[candidate.providerId];
  }

  function credentialIsCurrent(candidate: AccessProviderCandidate, auth: AuthContext, instance: CapturedSubscriptionCredential | undefined, effectiveCredential?: RuntimeCredential): boolean {
    const expected = capturedCredentialLineage(candidate, auth, instance);
    if (expected === undefined) {
      if (candidate.kind !== "subscription" || instance === undefined || effectiveCredential === undefined) return false;
      const currentCredential = captureSubscriptions().get(candidate.providerId)?.find((entry) => entry.instanceId === candidate.instanceId)?.credential;
      return currentCredential !== undefined && runtimeCredentialIdentity(currentCredential) === runtimeCredentialIdentity(effectiveCredential);
    }
    const current = candidate.kind === "subscription"
      ? captureSubscriptions().get(candidate.providerId)?.find((entry) => entry.instanceId === candidate.instanceId)?.lineageId
      : undefined;
    const liveLineages = options.captureCredentialLineages?.();
    const actual = candidate.kind === "subscription"
      ? current ?? "removed"
      : (liveLineages === undefined ? auth.credentialLineages[candidate.providerId] : liveLineages[candidate.providerId]) ?? "removed";
    return actual === expected;
  }

  async function fetchSettled(
    definition: AccessProviderDefinition,
    auth: AuthContext,
    instance: CapturedSubscriptionCredential | undefined,
    credential: RuntimeCredential,
    signal: AbortSignal,
    launcher: LauncherScope | undefined,
  ): Promise<AccessProviderCatalogFetchResult | undefined> {
    const timedOut: AccessProviderCatalogFetchResult = { discovery: { kind: "failed", reason: "timeout" }, credential };
    if (signal.aborted) {
      if (settlementTimedOut(signal)) return timedOut;
      throw signal.reason;
    }
    try {
      return await fetchProviderCatalog(definition, auth, instance, options, signal, launcher);
    } catch (error) {
      if (!settlementTimedOut(signal)) throw error;
      return timedOut;
    }
  }

  async function withProfile<T>(use: (profile: CatalogProfile) => T | Promise<T>): Promise<T> {
    const access = openExistingAuthProfileDirectory(options.authDir);
    try {
      return await use({ access, currentLineage: (account) => currentCredentialLineage(options.providers.definitions, options.authDir, options.classifySlot, account) });
    } finally {
      access.close();
    }
  }

  const evidence = createSavedListingEvidence({ withProfile, now });
  const readSaved = (account: AccessProviderAccountIdentity, lineage: string, limits: CatalogLimits) =>
    options.oauthPersistence === "access-only" ? Promise.resolve(undefined) : evidence.read(account, lineage, limits);

  async function recordModelRefusal(input: ModelRefusalInput): Promise<boolean> {
    const { candidate, wireModelId, refusal } = input;
    const instance = candidate.kind === "subscription" ? input.subscriptions.get(candidate.providerId)?.find(({ instanceId }) => instanceId === candidate.instanceId) : undefined;
    const lineage = capturedCredentialLineage(candidate, input.auth, instance);
    const limits = definitions.get(candidate.providerId)?.dynamicCatalog?.limits;
    if (lineage === undefined || limits === undefined || options.oauthPersistence === "access-only") return false;
    const saved = await evidence.recordRefusal(accessProviderAccountIdentity(candidate), lineage, wireModelId, refusal, limits);
    DebugLog.record({ type: "model.refusal.recorded", payload: {
      providerId: candidate.providerId, wireModelId, kind: refusal.kind, ...(refusal.kind === "extended-context" ? { contextLimit: refusal.contextLimit } : {}), saved,
    } });
    return saved;
  }

  /** Lists models.dev candidates immediately, pending until the account's probe succeeds.
   *  An audit commits each conclusive result before the next probe, so an interrupted audit resumes with the remainder. */
  async function resolveAudited(
    definition: AccessProviderDefinition,
    contribution: NonNullable<AccessProviderDefinition["dynamicCatalog"]>,
    probe: NonNullable<NonNullable<AccessProviderDefinition["dynamicCatalog"]>["probeAccess"]>,
    auth: AuthContext,
    candidate: AccessProviderCandidate,
    instance: CapturedSubscriptionCredential | undefined,
    capturedCredential: RuntimeCredential,
    lineage: string | undefined,
    signal: AbortSignal,
    { mode, baselineForListing, onAccessAudit, recheckAccount, launcher }: ListingPass,
  ): Promise<AccessProviderCandidateModels> {
    const account = accessProviderAccountIdentity(candidate);
    const durableLineage = options.oauthPersistence === "access-only" ? undefined : lineage;
    const fallback = baselineForListing(contribution);
    const candidates = auditCandidateRows(fallback.canonicalRows);
    const readAudit = async () => durableLineage === undefined ? undefined : withProfile(({ access }) => readSavedProviderModels(access, account, durableLineage, contribution.limits)?.audit);
    let audit = await readAudit();
    const visibleCandidates = catalogRowsToModelMap(candidates, definition.defaultChatTransport);
    const invalid: AccessProviderCandidateModels = { models: null, visibleModels: visibleCandidates, outcome: { kind: "unavailable", reason: "authentication-invalid" }, audit: { remaining: candidates.length, refused: 0 } };
    let discoveryFailure: AccessProviderCandidateModels["outcome"];
    let credential = capturedCredential;
    if (mode === "fresh" || mode === "refresh") {
      const fetched = await fetchSettled(definition, auth, instance, credential, signal, launcher);
      if (fetched?.discovery.kind === "auth-invalid") {
        if (durableLineage !== undefined) await withProfile((profile) => deleteProviderModelCatalog(profile, account, durableLineage, contribution.limits));
        return invalid;
      }
      credential = fetched?.credential ?? credential;
      if (!credentialIsCurrent(candidate, auth, instance, credential)) return invalid;
      // An interactive listing states whether the account answered; an owned refresh keeps saved candidates through a failed listing.
      if (mode === "fresh" && contribution.fetch !== undefined && !isDiscoveredListing(fetched?.discovery)) {
        discoveryFailure = { kind: "unavailable", reason: "discovery-failed", discoveryReason: fetched?.discovery.kind === "failed" ? fetched.discovery.reason : "malformed" };
      }
      if (discoveryFailure === undefined && durableLineage !== undefined && candidates.length > 0
        && await withProfile((profile) => writeProviderModelCandidates(profile, account, durableLineage, candidates, candidates.map((row) => row.modelId), contribution.limits))) {
        audit = await readAudit();
      }
    } else if (mode === "audit" && durableLineage !== undefined && (recheckAccount === undefined ? audit !== undefined : accessProviderAccountKey(recheckAccount) === accessProviderAccountKey(account))) {
      if (!credentialIsCurrent(candidate, auth, instance, credential)) return invalid;
      let current = audit;
      if (recheckAccount !== undefined) {
        // A manual recheck makes every current candidate due again but keeps saved outcomes until a conclusive probe replaces them. The store refuses a stale credential lineage under the profile lock, and then nothing is probed.
        const armed = candidates.length > 0
          && await withProfile((profile) => writeProviderModelCandidates(profile, account, durableLineage, candidates, candidates.map((row) => row.modelId), contribution.limits, true));
        if (armed) {
          current = await readAudit();
          audit = current;
        }
        else current = undefined;
      }
      for (const modelId of current?.dueIds ?? []) {
        if (current === undefined) break;
        const wireModelId = candidates.find((row) => row.modelId === modelId)?.offerings[0]?.wireModelId;
        if (wireModelId === undefined || signal.aborted) break;
        let outcome: AccessProviderAccessOutcome;
        try {
          outcome = await probe({ credential, ...(instance === undefined ? {} : { instance }), wireModelId, authDir: options.authDir, classifySlot: options.classifySlot, oauthPersistence: options.oauthPersistence ?? "profile", signal, ...(launcher === undefined ? {} : { launcher }) });
        } catch (error) {
          if (signal.aborted) break;
          throw error;
        }
        if (outcome === "inconclusive") continue;
        const { generation } = current;
        if (!await withProfile((profile) => recordProviderModelAccess(profile, account, durableLineage, generation, modelId, outcome, contribution.limits))) break;
        current = { ...current, dueIds: current.dueIds.filter((id) => id !== modelId), outcomes: { ...current.outcomes, [modelId]: outcome } };
        await onAccessAudit?.({ account, remaining: current.dueIds.length, modelId, outcome });
      }
      if (current !== undefined) audit = current;
      signal.throwIfAborted();
    }
    const transferred = options.oauthPersistence === "access-only"
      ? options.modelAccess?.find((entry) => entry.lineage === lineage && accessProviderAccountKey(entry.account) === accessProviderAccountKey(account))
      : undefined;
    const outcomes = transferred?.outcomes ?? audit?.outcomes ?? {};
    const remaining = transferred === undefined ? audit?.dueIds.length ?? candidates.length : candidates.filter((row) => outcomes[row.modelId] === undefined).length;
    const auditStatus = { audit: { remaining, refused: Object.values(outcomes).filter((outcome) => outcome === "refused").length } };
    const visible = candidates.filter((row) => outcomes[row.modelId] !== "refused");
    const admitted = visible.filter((row) => outcomes[row.modelId] === "completed");
    const visibleModels = catalogRowsToModelMap(visible, definition.defaultChatTransport);
    if (discoveryFailure !== undefined) return { models: null, visibleModels, outcome: discoveryFailure, ...auditStatus };
    if (visible.length === 0) return { models: null, outcome: { kind: "unavailable", reason: "unusable" }, ...auditStatus };
    if (admitted.length === 0) return { models: null, visibleModels, outcome: { kind: "unavailable", reason: "discovery-pending" }, ...auditStatus };
    const outcome = resolveModelCatalog({
      authenticated: true,
      live: { kind: "not-attempted" },
      contribution,
      canonicalFallback: admitted,
      fallbackProvenance: fallback.provenance,
    });
    return { models: catalogRowsToModelMap(admitted, definition.defaultChatTransport), visibleModels, outcome, ...auditStatus };
  }

  /** Lists one candidate with the evidence saved for its exact account generation, which is read once. */
  async function resolveCandidate(
    definition: AccessProviderDefinition,
    auth: AuthContext,
    candidate: AccessProviderCandidate,
    instance: CapturedSubscriptionCredential | undefined,
    signal: AbortSignal,
    pass: ListingPass,
  ): Promise<ListedCandidate> {
    const credential = instance?.credential ?? singletonCredential(definition.id, auth);
    const contribution = definition.dynamicCatalog;
    if (!credential || !contribution) return { listed: { models: null }, refusals: {} };
    const lineage = capturedCredentialLineage(candidate, auth, instance);
    const reading = lineage === undefined ? Promise.resolve(undefined) : readSaved(accessProviderAccountIdentity(candidate), lineage, contribution.limits);
    // A fresh listing never reads saved rows, so its fetch starts before the saved read settles.
    const listed = contribution.probeAccess !== undefined
      ? await resolveAudited(definition, contribution, contribution.probeAccess, auth, candidate, instance, credential, lineage, signal, pass)
      : await resolveListed(definition, contribution, auth, candidate, instance, credential, lineage, pass.mode === "fresh" ? undefined : (await reading)?.rows, signal, pass);
    return { listed, refusals: (await reading)?.refusals ?? {} };
  }

  async function resolveListed(
    definition: AccessProviderDefinition,
    contribution: NonNullable<AccessProviderDefinition["dynamicCatalog"]>,
    auth: AuthContext,
    candidate: AccessProviderCandidate,
    instance: CapturedSubscriptionCredential | undefined,
    credential: RuntimeCredential,
    lineage: string | undefined,
    savedRows: readonly CatalogCanonicalRow[] | undefined,
    signal: AbortSignal,
    pass: ListingPass,
  ): Promise<AccessProviderCandidateModels> {
    const { mode, baselineForListing } = pass;
    const account = accessProviderAccountIdentity(candidate);
    if (mode === "cached-first" || mode === "audit") {
      const fallback = baselineForListing(contribution);
      const metadataPreference = contribution.modelsDevMetadataFields === undefined
        ? undefined
        : { fields: contribution.modelsDevMetadataFields, rows: fallback.rows };
      const reconciledSaved = savedRows === undefined
        ? undefined
        : reconcileSavedCatalogRows(
            savedRows,
            fallback,
            contribution,
          );
      const outcome = resolveModelCatalog({
        authenticated: true,
        live: { kind: "not-attempted" },
        contribution,
        canonicalFallback: fallback.canonicalRows,
        fallbackProvenance: fallback.provenance,
        cachedFirstParty: reconciledSaved?.rows,
        firstPartyProvenance: "first-party-cached",
      });
      // A provider with no first-party listing takes its whole catalog from
      // models.dev, so the document the process holds is its saved evidence.
      if (outcome.kind === "catalog" && (outcome.provenance === "first-party-cached" || contribution.fetch === undefined)) {
        const models = catalogRowsToModelMap(outcome.rows, definition.defaultChatTransport, metadataPreference);
        return {
          models,
          visibleModels: models,
          outcome,
        };
      }
      return {
        models: null,
        visibleModels: catalogRowsToModelMap(preferredCatalog(undefined, reconciledSaved?.rows, fallback.canonicalRows), definition.defaultChatTransport, metadataPreference),
        outcome: { kind: "unavailable", reason: "discovery-pending" },
      };
    }
    const fetched = await fetchSettled(definition, auth, instance, credential, signal, pass.launcher);
    const decodedDiscovery = decodeDiscoveryRows(fetched?.discovery ?? { kind: "not-attempted" }, contribution);
    const fallback = baselineForListing(contribution);
    const metadataPreference = contribution.modelsDevMetadataFields === undefined
      ? undefined
      : { fields: contribution.modelsDevMetadataFields, rows: fallback.rows };
    const joinedDiscovery = decodedDiscovery === undefined ? undefined : joinCatalogRows(decodedDiscovery, fallback, contribution);
    const eligibleDiscovery: CatalogDiscovery = joinedDiscovery === undefined
      ? fetched?.discovery ?? { kind: "not-attempted" }
      : { kind: "resolved-rows", rows: joinedDiscovery.rows };
    const catalogInput = {
      authenticated: true,
      live: eligibleDiscovery,
      contribution,
    } as const;
    const discoveryCatalog = joinedDiscovery?.rows;
    const reconciledSaved = savedRows === undefined
      ? undefined
      : reconcileSavedCatalogRows(
          savedRows,
          fallback,
          contribution,
        );
    let outcome = resolveModelCatalog({
      ...catalogInput,
      canonicalFallback: fallback.canonicalRows,
      fallbackProvenance: fallback.provenance,
    });
    if (mode === "refresh" && reconciledSaved !== undefined && fetched?.discovery.kind !== "auth-invalid" && (outcome.kind !== "catalog" || outcome.provenance !== "first-party")) {
      outcome = resolveModelCatalog({
        authenticated: true,
        live: eligibleDiscovery,
        contribution,
        canonicalFallback: fallback.canonicalRows,
        fallbackProvenance: fallback.provenance,
        cachedFirstParty: reconciledSaved.rows,
        firstPartyProvenance: "first-party-cached",
      });
    }
    if (fetched) recordProviderCatalogFailure(definition.id, fetched.discovery, outcome);
    const effectiveCredential = fetched?.credential ?? credential;
    if (fetched?.discovery.kind === "auth-invalid" && lineage !== undefined && options.oauthPersistence !== "access-only") {
      await withProfile((profile) => deleteProviderModelCatalog(profile, account, lineage, contribution.limits));
      evidence.forget(account, lineage);
    }
    if (!credentialIsCurrent(candidate, auth, instance, effectiveCredential)) {
      return { models: null, outcome: { kind: "unavailable", reason: "authentication-invalid" } };
    }
    if (discoveryCatalog !== undefined && discoveryCatalog.length > 0 && lineage !== undefined && options.oauthPersistence !== "access-only"
      && await withProfile((profile) => writeProviderModelCatalog(profile, account, lineage, discoveryCatalog, contribution.limits))) {
      evidence.keepRows(account, lineage, discoveryCatalog);
    }
    if (outcome.kind !== "catalog") {
      return {
        models: null,
        visibleModels: catalogRowsToModelMap(preferredCatalog(discoveryCatalog, reconciledSaved?.rows, fallback.canonicalRows), definition.defaultChatTransport, metadataPreference),
        outcome,
        ...(joinedDiscovery === undefined ? {} : {
          diagnostics: {
            baselineGeneration: fallback.generation,
            unknownWireModelIds: joinedDiscovery.unknownWireModelIds,
            collisions: joinedDiscovery.collisions,
          },
        }),
      };
    }
    const models = catalogRowsToModelMap(outcome.rows, definition.defaultChatTransport, metadataPreference);
    return Object.freeze({
      models,
      visibleModels: models,
      outcome,
      ...(joinedDiscovery === undefined ? {} : {
        diagnostics: {
          baselineGeneration: fallback.generation,
          unknownWireModelIds: joinedDiscovery.unknownWireModelIds,
          collisions: joinedDiscovery.collisions,
        },
      }),
    });
  }

  async function getModelCatalogs(auth: AuthContext, request: ModelListingRequest = {}): Promise<AccessProviderModelCatalogs> {
    const mode = request.mode ?? "cached-first";
    const subscriptions = auth.subscriptionCredentials ?? captureSubscriptions();
    const configured = [...new Set([...options.providers.getConfigured(auth), ...subscriptions.keys()])];
    const tasks: Array<(signal: AbortSignal) => Promise<{ providerId: AccessProviderId; candidate?: AccessProviderCandidate; result: AccessProviderCandidateModels; refusals?: SavedModelRefusals }>> = [];
    const baselines = new Map<string, SharedModelsDevBaseline>();
    const baselineForListing: ModelsDevBaselineForListing = (contribution) => {
      const { limits } = contribution;
      const key = JSON.stringify([
        contribution.modelsDevCatalogIds,
        limits.responseBytes,
        limits.canonicalRows,
        limits.modelIdLength,
        limits.durableBytes,
        limits.metadataDepth ?? null,
        limits.metadataNodes ?? null,
      ]);
      let baseline = baselines.get(key);
      if (baseline === undefined) {
        baseline = modelsDevBaseline(contribution, options.modelsClient);
        baselines.set(key, baseline);
      }
      return baseline;
    };
    const pass: ListingPass = { mode, baselineForListing, onAccessAudit: request.onAccessAudit, recheckAccount: request.recheckAccount, launcher: request.launcher };
    for (const providerId of configured) {
      const custom = customProviderById(providerId);
      if (custom) {
        const candidate: AccessProviderCandidate = { kind: "singleton", providerId, spendMode: options.providers.spendMode(providerId) };
        const models = staticOfferingMap(custom.modelIds, "openai-completions");
        tasks.push(async () => ({ providerId, candidate, result: { models } }));
        continue;
      }
      const definition = definitions.get(providerId);
      if (!definition) continue;
      const instances = subscriptions.get(providerId);
      if (instances && instances.length > 0) {
        for (const instance of instances) {
          const candidate: AccessProviderCandidate = { kind: "subscription", providerId, instanceId: instance.instanceId, spendMode: "included" };
          tasks.push(async (signal) => {
            const { listed, refusals } = await resolveCandidate(definition, auth, candidate, instance, signal, pass);
            return { providerId, candidate, result: listed, refusals };
          });
        }
      } else {
        const candidate: AccessProviderCandidate = { kind: "singleton", providerId, spendMode: options.providers.spendMode(providerId) };
        tasks.push(async (signal) => {
          const { listed, refusals } = await resolveCandidate(definition, auth, candidate, undefined, signal, pass);
          return { providerId, candidate, result: listed, refusals };
        });
      }
    }
    const settled = await settleTasks(tasks, request.signal, mode === "audit" ? undefined : options.settlementTimeoutMs ?? LISTING_SETTLEMENT_MS, options.maxFetchConcurrency ?? MAX_FETCH_CONCURRENCY);
    recordCatalogDiscoveryDiagnostics(diagnosedDiscoveries, settled.map(({ providerId, result }) => ({ providerId, diagnostics: result.diagnostics })));
    const byProvider = new Map<AccessProviderId, ReadonlySet<string>>();
    const byCandidate = new Map<string, AccessProviderCandidateCatalog>();
    const at = now();
    // Refusals apply after the shared metadata fill, so a narrowed window stays with its own account.
    for (const { providerId, candidate, result: filled, refusals } of completeRouteMetadata(settled)) {
      const result = refusals === undefined ? filled : withModelRefusals(filled, liveModelRefusals(refusals, at));
      if (result.models && result.models.size > 0) byProvider.set(providerId, new Set([...(byProvider.get(providerId) ?? []), ...result.models.keys()]));
      if (candidate) byCandidate.set(accessProviderAccountKey(candidate), { candidate, ...result });
    }
    return { providers: byProvider, candidates: byCandidate };
  }

  /** Resolves each model once across every account that offers it, then fills
   *  what a route's own provider and catalog left as defaults from that shared
   *  record. A provider that lists only model IDs thereby still carries the
   *  price, efforts, and limits another source states for the same model. */
  function completeRouteMetadata<Settled extends { readonly providerId: AccessProviderId; readonly candidate?: AccessProviderCandidate; readonly result: AccessProviderCandidateModels }>(
    settled: readonly Settled[],
  ): readonly Settled[] {
    const rank = ({ providerId, candidate }: Settled) => ({ spendMode: candidate?.spendMode ?? "aggregator" as const, rank: definitions.get(providerId)?.rank ?? Number.MAX_SAFE_INTEGER });
    const ordered = settled.toSorted((left, right) => compareAutomaticSelection(rank(left), rank(right)));
    const shared = sharedModelInfos(ordered.flatMap(({ result }) => [...(result.visibleModels ?? result.models ?? [])]));
    return settled.map((entry) => {
      const provider = definitions.get(entry.providerId)?.dynamicCatalog?.modelsDevCatalogIds[0] ?? entry.providerId;
      const fill = (catalog: ReadonlyMap<string, readonly CatalogModelOffering[]>) => fillCatalogRouteModelInfos(catalog, shared, provider);
      const models = entry.result.models === null ? null : fill(entry.result.models);
      const visibleModels = entry.result.visibleModels === entry.result.models ? models ?? undefined : entry.result.visibleModels && fill(entry.result.visibleModels);
      return { ...entry, result: { ...entry.result, models, ...(visibleModels === undefined ? {} : { visibleModels }) } };
    });
  }

  return { getModelCatalogs, recordModelRefusal };
}
