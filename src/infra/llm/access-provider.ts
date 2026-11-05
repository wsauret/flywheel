import { Schema } from "effect";
import type { AuthContext, CapturedSubscriptionCredential, OAuthPersistencePolicy, ProviderConnection, RuntimeCredential, RuntimeOAuthCredential, SubscriptionCredentials } from "../auth/auth-context.js";
import type { AuthProfileAccess } from "../auth/auth-profile-store.js";
import type { CredentialSlotClassifier } from "../auth/auth-store-types.js";
import type { ExternalUrlOpener } from "../open-external-url.js";
import type { NotificationOccurrence } from "../notification-episode.js";
import type { LauncherScope } from "../process-supervisor.js";
import { offeringTransportFamily, type CatalogDiscovery, type CatalogJsonValue, type ModelCatalogContribution, type OfferingTransport } from "./model-catalog-resolution.js";
import type { ModelFamily } from "./model-family.js";
import { canonicalModelId, type CatalogDataUse } from "./model-id.js";
import type { ModelInfo } from "./models.js";
import type { CacheRetentionPolicy } from "./provider-options.js";
/** Open provider identity. Installed membership belongs to the injected catalog. */
export type AccessProviderId = string;
export const AccessProviderIdSchema = Schema.NonEmptyString;

type AccessProviderSpendMode = "included" | "prepaid" | "automatic" | "direct_api" | "aggregator";
const SPEND_CLASS = { included: 0, prepaid: 1, automatic: 2, direct_api: 3, aggregator: 4 } satisfies { [Mode in AccessProviderSpendMode]: number };

/** The order automatic selection walks candidates in: cheapest spend class
 *  first, then provider rank. A subscription spend class always sorts before a
 *  metered one. Metadata merging reads routes in this same order. */
export function compareAutomaticSelection(
  left: { readonly spendMode: AccessProviderSpendMode; readonly rank: number },
  right: { readonly spendMode: AccessProviderSpendMode; readonly rank: number },
): number {
  return SPEND_CLASS[left.spendMode] - SPEND_CLASS[right.spendMode] || left.rank - right.rank;
}
export type AccessProviderAccountIdentity =
  | { readonly kind: "subscription"; readonly providerId: AccessProviderId; readonly instanceId: string }
  | { readonly kind: "singleton"; readonly providerId: AccessProviderId };
export type AccessProviderCandidate =
  | ({ readonly spendMode: "included" | "prepaid" | "automatic" | "direct_api" } & Extract<AccessProviderAccountIdentity, { readonly kind: "subscription" }>)
  | ({ readonly spendMode: "direct_api" | "aggregator" } & Extract<AccessProviderAccountIdentity, { readonly kind: "singleton" }>);

export type AccessProviderCatalogProvenance = "live" | "last-known-good" | "bundled" | "static";
export const AccessProviderCatalogProvenanceSchema = Schema.Union([
  Schema.Literal("live"), Schema.Literal("last-known-good"), Schema.Literal("bundled"), Schema.Literal("static"),
]);

export interface AccessProviderCandidateAttribution {
  readonly candidate: AccessProviderCandidate;
  readonly wireModelId: string;
  readonly dataUse: CatalogDataUse;
  readonly routeKind?: "free";
  readonly catalogProvenance?: AccessProviderCatalogProvenance;
  readonly catalogMetadata?: CatalogJsonValue;
  readonly resolvedModelMetadata?: ModelInfo;
  readonly transport?: OfferingTransport;
  readonly eligibilityProfileId?: string;
  readonly eligibilityRevision?: number;
}

export const AccessProviderCandidateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("subscription"), providerId: AccessProviderIdSchema, instanceId: Schema.NonEmptyString, spendMode: Schema.Literals(["included", "prepaid", "automatic", "direct_api"]) }),
  Schema.Struct({ kind: Schema.Literal("singleton"), providerId: AccessProviderIdSchema, spendMode: Schema.Literals(["direct_api", "aggregator"]) }),
]);

export function accessProviderCandidateKey(candidate: AccessProviderCandidate): string {
  return JSON.stringify([candidate.kind, candidate.providerId, candidate.kind === "subscription" ? candidate.instanceId : null, candidate.spendMode]);
}

/** Canonical account identity for catalogs, credentials, and eligibility shared by all spend modes. */
export function accessProviderAccountIdentity(candidate: AccessProviderCandidate): AccessProviderAccountIdentity {
  return candidate.kind === "subscription"
    ? { kind: "subscription", providerId: candidate.providerId, instanceId: candidate.instanceId }
    : { kind: "singleton", providerId: candidate.providerId };
}

export function accessProviderAccountKey(account: AccessProviderAccountIdentity | AccessProviderCandidate): string {
  return account.kind === "subscription"
    ? JSON.stringify([account.kind, account.providerId, account.instanceId])
    : JSON.stringify([account.kind, account.providerId]);
}


export function candidateProviderId(candidate: AccessProviderCandidate): AccessProviderId {
  return candidate.providerId;
}

type AccessProviderBilling = "subscription" | "metered";

/** How the terminal names a credential provider: the `flywheel auth login
 *  --<flag>` spelling and the provider's plain name, which the command line
 *  joins with the sign-in method that the provider's login flow declares. A
 *  provider without a flag is reached by `--provider <id>`. */
export interface CredentialProviderCli {
  readonly name: string;
  readonly flag?: string;
}

/** A key format a provider owns. A login that receives a key carrying another
 *  provider's prefix is refused before it is stored, because the store would
 *  report success and then serve no models. */
interface ApiKeyPrefix {
  readonly prefix: string;
  readonly description: string;
}

export interface OAuthLoginPrompt {
  readonly message: string;
  readonly placeholder?: string;
  readonly allowEmpty?: boolean;
}

/** The ports every OAuth login draws on. The client supplies them per attempt:
 *  the browser its placement allows and the abort signal of the one
 *  outstanding flow. */
interface OAuthLoginPorts {
  /** Opens a page in a browser on the machine that runs the login. Absent
   *  when the person started the login from a client that can be on another
   *  machine, such as the phone: that client opens the reported page itself,
   *  and nothing opens a page on this machine. */
  readonly openBrowser?: ExternalUrlOpener;
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
  /** The credential being reconnected, so a flow keeps what the account
   *  answered before (an enterprise domain) instead of asking again. */
  readonly previous?: RuntimeOAuthCredential;
}

export interface DeviceCodeLoginPorts extends OAuthLoginPorts {
  readonly onUserCode?: (instructions: { readonly userCode?: string; readonly url: string }) => void;
  /** Answers a question the flow asks before it starts. Absent, the flow uses
   *  its default answer. */
  readonly onPrompt?: (prompt: OAuthLoginPrompt) => Promise<string>;
}

export interface BrowserLoginPorts extends OAuthLoginPorts {
  readonly onAuthorizeUrl?: (instructions: { readonly url: string }) => void;
  /** A user-pasted authorization code or redirect URL, raced against the
   *  callback the browser delivers. */
  readonly onManualCodeInput?: () => Promise<string>;
  readonly loginHint?: string;
}

/** What a completed OAuth flow yields: the account identity as the provider
 *  names it, and the credential still redacted. The auth store serializes it
 *  at its own boundary. */
export interface OAuthLoginResult {
  readonly identity?: string;
  readonly credential: RuntimeOAuthCredential;
}

/** The flow discriminant states what a client must show, a device code or an
 *  authorize URL, and selects the ports the flow receives. */
type AccessProviderOAuthLogin =
  | { readonly flow: "device-code"; readonly start: (ports: DeviceCodeLoginPorts) => Promise<OAuthLoginResult> }
  | { readonly flow: "browser"; readonly start: (ports: BrowserLoginPorts) => Promise<OAuthLoginResult> };

/** One account of a login that another program owns. Flywheel holds none of
 *  the login's secrets: it knows only which account it is and where the
 *  program keeps it. */
export interface ExternalAccount {
  /** The program's stable id for the account. */
  readonly accountId: string;
  /** The account as a person reads it, such as an email address. */
  readonly identity: string;
  /** The directory in which the program keeps this login. */
  readonly configDir: string;
  /** The account's plan as the program names it, such as "Claude Max", when the program states it. */
  readonly plan?: string;
  /** The program explicitly classifies this account as usage-only, with no included allowance or paid rollover. */
  readonly billing?: "metered";
}

/** The routes an account's captured billing classification permits, before admission checks. */
function accountSpendModes(account: { readonly billing?: "metered" }, paidModes: readonly ("prepaid" | "automatic")[]): readonly Extract<AccessProviderCandidate, { readonly kind: "subscription" }>["spendMode"][] {
  return account.billing === "metered" ? ["direct_api"] : ["included", ...paidModes];
}

/** The ports an external login draws on: a browser flow's, and the launch
 *  authority that runs the program. The program opens the browser itself
 *  when `openBrowser` is present and opens none when it is absent, so
 *  `onAuthorizeUrl` reports the URL that the program prints, and
 *  `onManualCodeInput` supplies a code the person pastes. */
export interface ExternalLoginPorts extends BrowserLoginPorts {
  readonly launcher: LauncherScope;
  /** Automatic recovery defers renewal until the runtime settles this exact question's complete login flow. */
  readonly loginQuestionId?: string;
}

export type LoginWaitAnswer = "renewed" | "declined";

/** A process-local refusal episode. Paths stay inside the runtime; clients receive only the opaque id and display data. */
export interface ExternalLoginQuestion {
  readonly id: string;
  readonly authDir: string;
  readonly account: ExternalAccount;
  readonly phase: "asking" | "logging-in";
}

/** What keeps one account of an external login from serving, with the step that repairs it in `message`. */
export type ExternalLoginProblem =
  /** The provider refused the account's login at its last request. */
  | { readonly kind: "login-rejected"; readonly accountId: string; readonly message: string }
  /** The program exited while it served a request of the account. */
  | { readonly kind: "program-exited"; readonly accountId: string; readonly message: string }
  /** The program could not start for a request of the account: it is missing or cannot run on this machine. */
  | { readonly kind: "program-cannot-start"; readonly accountId: string; readonly message: string };

/** A login that another program owns: the program runs the OAuth flow,
 *  stores the token, and refreshes it. Flywheel finds the program's accounts
 *  and runs the program's own login and logout commands. It never reads,
 *  stores, or sends a token of such a login.
 *  The program's own login outside Flywheel is never one. */
interface AccessProviderExternalLogin {
  /** The program as a person reads it: the product name of the vendor CLI that owns the login. Each client names it
   *  when it says what a logout leaves in place. */
  readonly program: string;
  /** The accounts of the program's logins inside the auth profile directory
   *  `authDir`, each once. A read of the program's files with no launch, so
   *  it is safe at startup. */
  readonly accounts: (authDir: string) => readonly ExternalAccount[];
  /** The problems of the auth profile in `authDir`, with no launch: a program that is missing or that this
   *  process found unable to serve, and each account whose last request in this process failed for its login or
   *  for its program. A later response of the account, or a new login, clears its problem. */
  readonly problems: (authDir: string) => readonly ExternalLoginProblem[];
  /** Calls `listener` when `accounts` or `problems` can answer differently, because this process observed
   *  something that no file shows. Returns the unsubscribe. */
  readonly observe: (listener: () => void) => () => void;
  /** Joins this account's refusal, or renews immediately if it cleared. Abort rejects with signal.reason and removes only this waiter. */
  readonly awaitLogin: (authDir: string, accountId: string, signal: AbortSignal) => Promise<LoginWaitAnswer>;
  /** Active refusal episodes, including a claimed login. Declined episodes remain private until real recovery. */
  readonly loginQuestions: () => readonly ExternalLoginQuestion[];
  /** Claims only the exact asking episode, once. Renewed starts login; declined ends its waits. Stale answers return undefined. */
  readonly answerLogin: (questionId: string, answer: LoginWaitAnswer) => ExternalLoginQuestion | undefined;
  /** Settles only the exact claimed logging-in episode after the complete runtime login flow. Stale settlements do nothing. */
  readonly settleLogin: (questionId: string, answer: LoginWaitAnswer) => void;
  /** Runs the program's login. With `account`, the account logs in again in
   *  its own place; without it, the login adds an account. Resolves with the
   *  account that the program then holds, and rejects when the program holds
   *  none. */
  readonly login: (authDir: string, ports: ExternalLoginPorts, account?: ExternalAccount) => Promise<ExternalAccount>;
  /** Disconnects the account from the auth profile in `authDir` through provider-owned behavior: every place of the
   *  profile that holds `accountId` ends, and the program forgets what it observed about each login that ended. An
   *  account that the profile no longer holds is already gone. */
  readonly logout: (authDir: string, accountId: string, ports: { readonly launcher: LauncherScope; readonly signal?: AbortSignal }) => Promise<void>;
  /** Ends every login that the program keeps inside the auth profile directory `authDir`, before Flywheel removes
   *  that directory with the profile. The program keeps each token in its own store, such as the macOS keychain,
   *  so removing the directory alone would leave a token that no surface can show or end. Rejects after it tried
   *  every login when one of them did not end. */
  readonly logoutProfile: (authDir: string, ports: { readonly launcher: LauncherScope }) => Promise<void>;
}

type AccessProviderAuthStrategy =
  | { readonly kind: "api_key"; readonly statusRank: number; readonly keyPrefix?: ApiKeyPrefix }
  | ({ readonly kind: "oauth"; readonly credentialId: string; readonly statusRank: number } & AccessProviderOAuthLogin)
  | ({ readonly kind: "external"; readonly statusRank: number } & AccessProviderExternalLogin);

/** A definition whose login another program owns. */
export type ExternalLoginDefinition = AccessProviderDefinition & { readonly auth: { readonly kind: "external" } };

export function isExternalLoginDefinition(definition: AccessProviderDefinition): definition is ExternalLoginDefinition {
  return definition.auth.kind === "external";
}

/** One immutable user eligibility revision captured for a provider-chain plan. */
export interface AccessProviderModelEligibility {
  /** Canonical identities in this immutable exact-account catalog revision. Planning still decides reachability. */
  readonly modelIds?: ReadonlySet<string>;
  readonly profileId?: string;
  readonly revision?: number;
  readonly modelUnavailableReason: (provider: AccessProviderId, model: string) => string | undefined;
  readonly candidateModelUnavailableReason?: (candidate: AccessProviderCandidate, model: string) => string | undefined;
  readonly candidateOffering?: (candidate: AccessProviderCandidate, model: string, allowTrainingRoutes: boolean) => AccessProviderCandidateAttribution | undefined;
  readonly candidateOfferings?: (candidate: AccessProviderCandidate, model: string, allowTrainingRoutes: boolean) => readonly AccessProviderCandidateAttribution[];
  /** Whether no account can serve a request yet because a configured account's model access is still being checked. */
  readonly accessPending?: (allowTrainingRoutes?: boolean) => boolean;
}

export interface AccessProviderCatalogFetchInput {
  /** The credential the listing is fetched with: the subscription instance's
   *  own, or the singleton key. */
  readonly credential: RuntimeCredential;
  /** The subscription instance the candidate is, when it is one. A fetch that
   *  rotates its token replaces this instance's stored credential. */
  readonly instance?: CapturedSubscriptionCredential;
  readonly authDir: string;
  /** Classifies every credential in the profile when a token rotation persists the whole store. */
  readonly classifySlot: CredentialSlotClassifier;
  readonly oauthPersistence: OAuthPersistencePolicy;
  readonly signal: AbortSignal;
  /** The listing caller's launch authority, for a fetch that runs a local process. Absent when the caller holds
   *  none; such a fetch then reports a failed discovery. */
  readonly launcher?: LauncherScope;
}

export interface AccessProviderCatalogFetchResult {
  readonly discovery: CatalogDiscovery;
  /** The credential the listing settled on: the input credential, or the
   *  rotated one when the fetch refreshed a token. */
  readonly credential: RuntimeCredential;
}

/** A provider's dynamic model discovery: the one fetch that reaches the
 *  provider, plus the contribution that extracts, canonicalizes, limits, and
 *  falls back. A provider with no first-party listing omits the fetch; its
 *  catalog is its models.dev rows, which the process always holds. */
type AccessProviderDynamicCatalog = ModelCatalogContribution & {
  readonly fetch?: (input: AccessProviderCatalogFetchInput) => Promise<AccessProviderCatalogFetchResult>;
  /** Marks an account whose listing is its usable models.dev candidates
   *  and whose optional fetch only validates the credential. The listing audits each
   *  candidate through this one probe and persists every conclusive result. */
  readonly probeAccess?: (input: AccessProviderAccessProbeInput) => Promise<AccessProviderAccessOutcome>;
};

/** `completed` admits the model, `refused` hides it, and `inconclusive`
 *  leaves the model as it was. Only a conclusive outcome is persisted. */
export type AccessProviderAccessOutcome = "completed" | "refused" | "inconclusive";

interface AccessProviderAccessProbeInput extends AccessProviderCatalogFetchInput {
  readonly wireModelId: string;
}

/** A provider's numeric settings for one profile, keyed by the declared
 *  setting key, with declared defaults filled in. */
export interface ProviderSettingValues {
  readonly [key: string]: number;
}

/** How usage views read this provider's metrics. */
interface AccessProviderUsage {
  /** A metric that is provider detail most readers never need; both clients
   *  hide it until asked. */
  readonly metricDetail?: (metricKey: string) => boolean;
  /** Flywheel's own cap on the provider's allowance metric, read from the
   *  provider's settings for the profile; undefined when no cap applies. */
  readonly allowanceCap?: (settings: ProviderSettingValues) => number | undefined;
  /** The metric of the window whose included quota expires at its reset,
   *  for a provider whose accounts reset it at different moments. Included
   *  use spends the account that resets it soonest first (PI-MODEL-058). */
  readonly expiringWindow?: string;
  /** Whether the plan that a usage reading of an account names is a free plan. A free-plan account never rotates
   *  (PI-MODEL-038). Absent, every account of the provider counts as paid. */
  readonly freePlan?: (reading: SubscriptionPlanReading) => boolean;
}

/** The plan and tier that a provider's usage reading names for one account. */
export interface SubscriptionPlanReading {
  readonly plan?: string;
  readonly tier?: string;
}

/** What a profile conversion reads and writes: the profile, under whose locks it writes, the slot classifier, and
 *  the complete installed credential vocabulary that the store decodes with. */
export interface AuthProfileConversionInput {
  readonly access: AuthProfileAccess;
  readonly classifySlot: CredentialSlotClassifier;
  readonly installedIds: readonly string[];
  /** The notify seam (ARCH-STRUCTURE-034), where a conversion states a condition that the person must act on, such as an
   *  account whose saved choices could not move. Absent where no person reads notifications, such as a headless
   *  run, which states the condition in its log only. */
  readonly notify?: (occurrence: NotificationOccurrence) => void;
}

/** A dated conversion of state that the provider stored in an auth profile in an earlier shape. Profile
 *  normalization runs every installed provider's conversions, also of a provider whose module is off. A
 *  `before-decode` conversion runs before the credential store is decoded, so it can take out an entry that the
 *  current decoder refuses. An `after-decode` conversion runs on a decoded store whose lineages are in place. */
export interface AuthProfileConversion {
  readonly phase: "before-decode" | "after-decode";
  readonly convert: (profile: AuthProfileConversionInput) => Promise<void>;
}

interface AccessProviderDefinitionBase {
  readonly id: AccessProviderId;
  readonly displayName: string;
  readonly shortName: string;
  readonly billingUrl?: string;
  readonly rank: number;
  readonly supportedFamilies: readonly ModelFamily[];
  /** Chat transport for first-party rows that predate their models.dev metadata. */
  readonly defaultChatTransport?: OfferingTransport;
  /** Configurable cache policies accepted by this provider's request protocol.
   *  Individual models can still refuse a policy at the provider boundary. */
  readonly cacheRetentionPolicies?: readonly CacheRetentionPolicy[];
  readonly configHints: readonly string[];
  readonly cli: CredentialProviderCli;
  readonly catalogId: string | undefined;
  readonly dynamicCatalog?: AccessProviderDynamicCatalog;
  readonly auth: AccessProviderAuthStrategy;
  /** Configured providers use this predicate to keep their user-authored static membership. */
  readonly staticModelUnavailableReason?: (model: string) => string | undefined;
  readonly usage?: AccessProviderUsage;
  /** Conversions of the state that this provider stored in an earlier shape, each with its removal date. */
  readonly profileConversions?: readonly AuthProfileConversion[];
}

/** A subscription declares each rollover mode its adapter supports. An omitted list offers no paid rollover. */
export type AccessProviderDefinition = AccessProviderDefinitionBase & (
  | { readonly billing: "subscription"; readonly spendMode?: never; readonly paidModes?: readonly ("prepaid" | "automatic")[] }
  | { readonly billing: "metered"; readonly spendMode: "direct_api" | "aggregator" }
);

/** The auth store key this provider's credentials live under. An external
 *  login stores nothing, and its accounts are known under the provider id. */
export function credentialIdOf(definition: Pick<AccessProviderDefinition, "id" | "auth">): string {
  return definition.auth.kind === "oauth" ? definition.auth.credentialId : definition.id;
}

/** Whether the account holds a usable credential for this provider. A
 *  subscription provider's API-key accounts are captured as instances, not as
 *  an account state, so they never configure a singleton candidate. */
function isProviderConfigured(definition: Pick<AccessProviderDefinition, "id" | "auth">, auth: AuthContext): boolean {
  return auth.providers.has(credentialIdOf(definition));
}

/** Reason to refuse `key` for `providerId`, or undefined to accept.
 *
 *  Refuses only on positive evidence of mis-slotting: the key carries another
 *  installed provider's prefix. A key that matches no known prefix is always
 *  accepted, so a new key format never locks a user out, and a provider that
 *  owns no prefix (a [custom_providers] entry, a web provider) accepts any
 *  format. The longest prefix wins, so a specific prefix claims its keys
 *  before a broad one does. */
export function apiKeyRejectionReason(definitions: readonly AccessProviderDefinition[], providerId: string, key: string): string | undefined {
  const owners = definitions.flatMap((definition) => definition.auth.kind === "api_key" && definition.auth.keyPrefix ? [{ definition, ...definition.auth.keyPrefix }] : []);
  const target = owners.find((owner) => owner.definition.id === providerId);
  if (target === undefined) return undefined;
  const match = owners.filter((owner) => key.startsWith(owner.prefix)).toSorted((a, b) => b.prefix.length - a.prefix.length)[0];
  if (match === undefined || match.definition.id === providerId) return undefined;
  return `This looks like ${match.description} ("${match.prefix}..."). Use the ${match.definition.displayName} provider for it, or enter a key for ${target.definition.displayName}.`;
}

export interface AdmittedFailoverPlan {
  readonly kind: "admitted";
  readonly connectionId: string;
  readonly model: string;
  readonly family: ModelFamily;
  readonly candidates: readonly AccessProviderCandidate[];
  readonly candidateAttributions: readonly AccessProviderCandidateAttribution[];
}

/** What a plan that admits no candidate lacks: any model provider at all, a
 *  provider that offers the model, or a finished check of the account's model
 *  access. Each needs a different remedy: setting up a provider, choosing
 *  another model, or trying again in a moment. */
export type ModelUnavailableMissing = "provider" | "offering" | "access";

export type FailoverPlan =
  | AdmittedFailoverPlan
  | { readonly kind: "unavailable"; readonly connectionId: string; readonly model: string; readonly reason: string; readonly missing: ModelUnavailableMissing };

export interface AccessProviderSelection {
  readonly definitions: readonly AccessProviderDefinition[];
  readonly getConfiguredForFamily: (family: ModelFamily, auth: AuthContext) => AccessProviderId[];
  readonly getConfigured: (auth: AuthContext) => AccessProviderId[];
  readonly displayName: (id: AccessProviderId) => string;
  readonly shortName: (id: AccessProviderId) => string;
  readonly billing: (id: AccessProviderId) => AccessProviderBilling;
  readonly billingUrl: (id: AccessProviderId) => string | undefined;
  /** models.dev source for provider-specific model metadata. */
  readonly catalogId: (id: AccessProviderId) => string | undefined;
  readonly spendMode: (id: AccessProviderId) => "direct_api" | "aggregator";
  readonly plan: (model: string, connection: ProviderConnection, eligibility?: AccessProviderModelEligibility, allowTrainingRoutes?: boolean) => FailoverPlan;
}


/** Binds pure provider selection to one immutable enabled definition population. */
export function createAccessProviderSelection(installed: readonly AccessProviderDefinition[]): AccessProviderSelection {
  const accessProviderDefinitions = Object.freeze([...installed]);
  const ids = new Set<AccessProviderId>();
  for (const definition of accessProviderDefinitions) {
    if (ids.has(definition.id)) throw new Error(`Duplicate access provider definition: ${definition.id}`);
    ids.add(definition.id);
  }

  function providerDefinitions(): readonly AccessProviderDefinition[] {
    return accessProviderDefinitions;
  }

/** Automatic-selection order derives from provider billing and rank. */
function orderedDefinitions(): AccessProviderDefinition[] {
  return [...providerDefinitions()]
    .sort((a, b) => Number(a.billing === "metered") - Number(b.billing === "metered") || a.rank - b.rank);
}

function definitionsForFamily(family: ModelFamily): AccessProviderDefinition[] {
  return orderedDefinitions().filter((definition) => definition.supportedFamilies.includes(family));
}

function definitionForProvider(id: AccessProviderId): AccessProviderDefinition {
  const definition = providerDefinitions().find((entry) => entry.id === id);
  if (!definition) throw new Error(`Missing access provider definition: ${id}`);
  return definition;
}

function getConfiguredAccessProvidersForFamily(
  family: ModelFamily,
  auth: AuthContext,
): AccessProviderId[] {
  return definitionsForFamily(family)
    .filter((definition) => isProviderConfigured(definition, auth))
    .map((definition) => definition.id);
}



function getConfiguredAccessProviders(auth: AuthContext): AccessProviderId[] {
  return orderedDefinitions()
    .filter((definition) => isProviderConfigured(definition, auth))
    .map((definition) => definition.id);
}

function accessProviderDisplayName(id: AccessProviderId): string {
  return providerDefinitions().find((d) => d.id === id)?.displayName ?? id;
}

function accessProviderShortName(id: AccessProviderId): string {
  return providerDefinitions().find((d) => d.id === id)?.shortName ?? id;
}

function accessProviderBilling(id: AccessProviderId): AccessProviderBilling {
  return definitionForProvider(id).billing;
}

function accessProviderBillingUrl(id: AccessProviderId): string | undefined {
  return providerDefinitions().find((definition) => definition.id === id)?.billingUrl;
}

function accessProviderSpendMode(id: AccessProviderId): "direct_api" | "aggregator" {
  const definition = definitionForProvider(id);
  if (definition.billing !== "metered") throw new Error(`Subscription provider has no singleton spend mode: ${id}`);
  return definition.spendMode;
}

/** Resolves the provider's explicit pricing catalog or its declared models.dev source. */
function providerCatalogId(id: AccessProviderId): string | undefined {
  const definition = definitionForProvider(id);
  return definition.catalogId ?? definition.dynamicCatalog?.modelsDevCatalogIds[0];
}

/** A model id may carry a context-window suffix (`gpt-5.4[large]`), which names
 *  a runtime variant rather than a model any provider serves. */
const CONTEXT_SUFFIX_RE = /\[\w+\]$/;


/** Why the capture cannot build `provider`, or undefined when it can. */
function missingSubscriptionCredentialReason(provider: AccessProviderId, credentials: SubscriptionCredentials): string | undefined {
  const definition = definitionForProvider(provider);
  if (definition.billing !== "subscription" || (credentials.get(provider)?.length ?? 0) > 0) return undefined;
  return `${definition.displayName} is logged in but its credentials were not captured. Run: ${definition.configHints[0]}.`;
}

function candidatesForProvider(provider: AccessProviderId, connection: ProviderConnection): AccessProviderCandidate[] {
  const definition = definitionForProvider(provider);
  if (definition.billing === "metered") return [{ kind: "singleton", providerId: provider, spendMode: definition.spendMode }];
  const accounts = connection.subscriptionCredentials.get(provider) ?? [];
  return accounts.flatMap((account) =>
    accountSpendModes(account, definition.paidModes ?? []).map((spendMode) => ({ kind: "subscription" as const, providerId: provider, instanceId: account.instanceId, spendMode })),
  );
}

/** Plans the candidate chain for `model` on one captured connection. Pure: it
 *  reads no credential file, no model cache and no provider, so the same plan
 *  serves a preflight check and the client build that follows it. */
function planProviderChain(model: string, connection: ProviderConnection, eligibility?: AccessProviderModelEligibility, allowTrainingRoutes = false): FailoverPlan {
  const normalized = canonicalModelId(model.replace(CONTEXT_SUFFIX_RE, ""));
  const configured = providerDefinitions().filter((definition) =>
    isProviderConfigured(definition, connection.auth)
    || (connection.subscriptionCredentials.get(definition.id)?.length ?? 0) > 0
  );
  const missing: ModelUnavailableMissing = configured.length === 0 ? "provider" : eligibility?.accessPending?.(allowTrainingRoutes) === true ? "access" : "offering";
  const unavailable = (reason: string): FailoverPlan =>
    Object.freeze({ kind: "unavailable" as const, connectionId: connection.id, model: normalized, reason, missing });
  if (eligibility?.candidateOffering !== undefined || eligibility?.candidateOfferings !== undefined) {
    const candidateAttributions = configured
      .flatMap((definition) => candidatesForProvider(definition.id, connection).map((candidate) => ({ candidate, rank: definition.rank })))
      .sort((left, right) => compareAutomaticSelection({ spendMode: left.candidate.spendMode, rank: left.rank }, { spendMode: right.candidate.spendMode, rank: right.rank }))
      .map(({ candidate }) => candidate)
      .flatMap((candidate) => {
        if (missingSubscriptionCredentialReason(candidate.providerId, connection.subscriptionCredentials) !== undefined) return [];
        if (eligibility.modelUnavailableReason(candidate.providerId, normalized) !== undefined) return [];
        if (eligibility.candidateModelUnavailableReason?.(candidate, normalized) !== undefined) return [];
        const selected = eligibility.candidateOfferings?.(candidate, normalized, allowTrainingRoutes);
        const offerings = selected ?? (() => {
          const offering = eligibility.candidateOffering?.(candidate, normalized, allowTrainingRoutes);
          return offering === undefined ? [] : [offering];
        })();
        return offerings.flatMap((offering) => {
          const transport = offering.transport ?? definitionForProvider(candidate.providerId).defaultChatTransport;
          return transport === undefined ? [] : [Object.freeze({
            ...offering,
            candidate: Object.freeze({ ...candidate }),
            transport,
            ...(eligibility.profileId === undefined ? {} : { eligibilityProfileId: eligibility.profileId }),
            ...(eligibility.revision === undefined ? {} : { eligibilityRevision: eligibility.revision }),
          })];
        });
      });
    const family = candidateAttributions[0]?.transport === undefined
      ? undefined
      : offeringTransportFamily(candidateAttributions[0].transport);
    if (family === undefined || candidateAttributions.length === 0) {
      return unavailable(`No captured provider catalog maps "${normalized}" to a wire model id.`);
    }
    return Object.freeze({
      kind: "admitted" as const,
      connectionId: connection.id,
      model: normalized,
      family,
      candidates: Object.freeze([...new Map(candidateAttributions.map(({ candidate }) => [accessProviderCandidateKey(candidate), candidate])).values()]),
      candidateAttributions: Object.freeze(candidateAttributions),
    });
  }
  return unavailable(`Provider catalog eligibility is not ready for "${normalized}".`);
}
  return Object.freeze({
    definitions: accessProviderDefinitions,
    getConfiguredForFamily: getConfiguredAccessProvidersForFamily,
    getConfigured: getConfiguredAccessProviders,
    displayName: accessProviderDisplayName,
    shortName: accessProviderShortName,
    billing: accessProviderBilling,
    billingUrl: accessProviderBillingUrl,
    catalogId: providerCatalogId,
    spendMode: accessProviderSpendMode,
    plan: planProviderChain,
  });
}
