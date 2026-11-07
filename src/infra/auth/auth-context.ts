/**
 * AuthContext - resolved authentication state for the current process.
 *
 * Immutable snapshot factory. The active auth profile's store is the only
 * credential source: an api_key or oauth entry in auth.json, with `!command`
 * indirection resolved for stored keys. Environment variables never resolve
 * as credentials, so a key exported in the shell cannot leak into a profile
 * that did not store it. Status surfaces may still report set-but-ignored
 * env vars (see auth-actions).
 *
 * Callers produce new snapshots by calling resolveAuthContext() again
 * after mutations.
 */

import { Redacted } from "effect";
import { isCredentialCollection, type AuthStore, type Credential, type CredentialLineages, type CredentialSlotClassifier, type OAuthCredential } from "./auth-store-types.js";

import { authStoreObservationKey, loadAuthStoreWithDiagnostics, type AuthStoreCondition, type AuthStoreLoadResult } from "./auth-store.js";
import { apiKeyHint } from "./api-key-hint.js";
import type { KeyResolver } from "./resolve-key.js";
import { credentialIdOf, type AccessProviderAccountIdentity, type AccessProviderDefinition, type ExternalAccount } from "../llm/access-provider.js";
import type { ProviderModelAccessSnapshot } from "./provider-model-catalog-store.js";

/** What the account holds for one credential id. An `api_key` state carries
 *  the resolved key; an `oauth` state only says the provider is connected,
 *  because the runtime reads OAuth tokens from captured subscription
 *  instances, never from this snapshot. */
type ProviderAuthState =
  | { readonly kind: "api_key"; readonly key: Redacted.Redacted<string> }
  | { readonly kind: "oauth" };

export interface AuthContext {
  /** Every credential id the store holds a usable credential for, keyed by
   *  that id. A subscription collection of API keys names no state here: its
   *  accounts are captured as instances. */
  readonly providers: ReadonlyMap<string, ProviderAuthState>;
  /** Opaque auth-owned generations for metered profile credentials. */
  readonly credentialLineages: CredentialLineages;
  /** Provider IDs whose credentials in `auth.json` failed schema validation
   *  and were skipped on load. UI may surface these so users can re-auth. */
  readonly droppedCredentials: readonly string[];
  /** Safe storage conditions, absent when the credential snapshot is healthy. */
  readonly conditions?: readonly AuthStoreCondition[];
  readonly observation?: string;
  readonly subscriptionCredentials?: SubscriptionCredentials;
}

/** The stored API key for one credential id, or undefined when the account
 *  holds none or holds an OAuth credential there. */
export function apiKey(auth: AuthContext, providerId: string): Redacted.Redacted<string> | undefined {
  const state = auth.providers.get(providerId);
  return state?.kind === "api_key" ? state.key : undefined;
}

/** Everything provider selection and client construction read from the account,
 *  captured once and frozen. Capture is the authentication boundary of a client:
 *  after it, no selection or build step reads a credential file or a model cache
 *  again, so a runner can hand its connection to a child and have that child
 *  spend the same account without a secret being copied or serialized. */

export type OAuthPersistencePolicy = "profile" | "memory-only" | "access-only";
export type RuntimeCredential =
  | { readonly type: "api_key"; readonly key: Redacted.Redacted<string> }
  | { readonly type: "oauth"; readonly access: Redacted.Redacted<string>; readonly refresh?: Redacted.Redacted<string>; readonly expires: number; readonly accountId?: string; readonly enterpriseDomain?: string }
  /** A login that another program owns. It carries no secret: only the
   *  directory in which the program keeps the login. */
  | { readonly type: "external"; readonly configDir: string };

export type RuntimeOAuthCredential = Extract<RuntimeCredential, { readonly type: "oauth" }>;

/** One immutable runtime credential captured for a subscription instance. */
export interface CapturedSubscriptionCredential {
  readonly instanceId: string;
  /** Auth-owned stable generation. Token refresh preserves it; credential replacement changes it. */
  readonly lineageId?: string;
  readonly identity?: string;
  readonly label?: string;
  readonly billing?: "metered";
  readonly credential: RuntimeCredential;
}

/** Runtime subscription credentials keyed by access-provider ID. */
export type SubscriptionCredentials = ReadonlyMap<string, readonly CapturedSubscriptionCredential[]>;
export interface ProviderConnection {
  /** Profile identity that owns this capture, when the host has one. */
  readonly profileId?: string;
  /** Identity of this capture. A chain plan states the connection it was planned
   *  against, and construction refuses a plan from another one. */
  readonly id: string;
  /** Account credential directory this connection was captured from (ARCH-DIRECTORIES-001).
   *  Adapters that rotate a token or dump a failed request write under it. */
  readonly authDir: string;
  readonly auth: AuthContext;
  /** Immutable subscription instances keyed by access-provider ID. */
  readonly subscriptionCredentials: SubscriptionCredentials;
  /** Controls token refresh ownership: profile persists rotation, memory-only retains it in this connection, and access-only never refreshes. */
  readonly oauthPersistence: OAuthPersistencePolicy;
  /** Read-only access checks carried by a credential snapshot, never persisted or reprobed. */
  readonly modelAccess?: readonly ProviderModelAccessSnapshot[];
}

/** The one constructor of a connection: it names the capture, so every plan and
 *  every client can be traced to the account state they were decided on. */
export function captureProviderConnection(captured: Omit<ProviderConnection, "id" | "oauthPersistence" | "subscriptionCredentials" | "profileId"> & { readonly profileId: string; readonly oauthPersistence?: OAuthPersistencePolicy; readonly subscriptionCredentials?: SubscriptionCredentials }): ProviderConnection & { readonly profileId: string };
export function captureProviderConnection(captured: Omit<ProviderConnection, "id" | "oauthPersistence" | "subscriptionCredentials"> & { readonly oauthPersistence?: OAuthPersistencePolicy; readonly subscriptionCredentials?: SubscriptionCredentials }): ProviderConnection;
export function captureProviderConnection(captured: Omit<ProviderConnection, "id" | "oauthPersistence" | "subscriptionCredentials"> & { readonly oauthPersistence?: OAuthPersistencePolicy; readonly subscriptionCredentials?: SubscriptionCredentials }): ProviderConnection {
  const subscriptionCredentials = new Map<string, readonly CapturedSubscriptionCredential[]>([...captured.subscriptionCredentials ?? []].map(([providerId, instances]) => [
    providerId,
    Object.freeze([...instances].sort((a, b) => a.instanceId.localeCompare(b.instanceId))),
  ]));
  return Object.freeze({ id: crypto.randomUUID(), oauthPersistence: "profile", ...captured, subscriptionCredentials });
}

/** Returns the sole account for a provider-scoped feature with no admitted model candidate. Ambiguous collections require explicit account selection. */
export function canonicalSubscriptionAccount(connection: ProviderConnection, providerId: string): CapturedSubscriptionCredential | undefined {
  const accounts = connection.subscriptionCredentials.get(providerId);
  return accounts?.length === 1 ? accounts[0] : undefined;
}

/** Captures every configured subscription instance once, in stable instance
 *  order. Only credentials matching the definition's auth strategy count: a
 *  wrong-typed store entry (an api_key under an oauth provider) must not admit
 *  the provider into a chain its factory will reject. An external login
 *  stores nothing, so its instances are the accounts that its program holds
 *  for the profile in `authDir`. */
export function captureSubscriptionCredentials(
  definitions: readonly AccessProviderDefinition[],
  source:
    | { readonly kind: "persisted"; readonly authDir: string; readonly classifySlot: CredentialSlotClassifier; readonly report?: boolean }
    | { readonly kind: "decoded"; readonly store: AuthStore; readonly authDir: string },
): SubscriptionCredentials {
  const store = source.kind === "decoded"
    ? source.store
    : loadAuthStoreWithDiagnostics(source.authDir, undefined, source.classifySlot, source.report).store
  const credentials = new Map<string, readonly CapturedSubscriptionCredential[]>();
  for (const definition of definitions) {
    if (definition.billing !== "subscription") continue;
    const captured = definition.auth.kind === "external"
      ? externalInstances(definition.auth.accounts(source.authDir))
      : storedInstances(store[credentialIdOf(definition)], definition.auth.kind);
    if (captured.length === 0) continue;
    credentials.set(definition.id, Object.freeze(captured.toSorted((left, right) => left.instanceId.localeCompare(right.instanceId))));
  }
  return credentials;
}

/** The stored key of a metered provider as one usage account. Its instance id
 *  is the key's credential lineage, which is also the key's metered Usage
 *  source id, so replacing the key starts a new account. A `!command` key is
 *  absent: resolving it launches a helper, which a usage read never does. */
export function meteredKeyAccount(
  load: Pick<AuthStoreLoadResult, "store" | "credentialLineages">,
  definition: Pick<AccessProviderDefinition, "id" | "auth">,
): CapturedSubscriptionCredential | undefined {
  const id = credentialIdOf(definition);
  const entry = load.store[id];
  const lineageId = load.credentialLineages[id];
  if (entry === undefined || isCredentialCollection(entry) || entry.type !== "api_key" || entry.key.startsWith("!") || lineageId === undefined) return undefined;
  return Object.freeze({ instanceId: lineageId, lineageId, identity: apiKeyHint(entry.key), credential: runtimeCredential(entry) });
}

function storedInstances(value: AuthStore[string] | undefined, kind: Credential["type"]): readonly CapturedSubscriptionCredential[] {
  if (!isCredentialCollection(value)) return [];
  return value.flatMap(({ id, identity, label, lineageId, credential }) => lineageId === undefined || credential.type !== kind ? [] : [Object.freeze({
    instanceId: id, identity, lineageId, ...(label === undefined ? {} : { label }), credential: runtimeCredential(credential),
  })]);
}

/** The program owns an external login's token and its refreshes, so the
 *  account is its own lineage: what a catalog proved for the account stays
 *  the account's across every token the program holds for it. */
function externalInstances(accounts: readonly ExternalAccount[]): readonly CapturedSubscriptionCredential[] {
  return accounts.map(({ accountId, identity, configDir, billing }) => Object.freeze({
    instanceId: accountId, identity, lineageId: accountId, ...(billing === undefined ? {} : { billing }), credential: Object.freeze({ type: "external", configDir }),
  }));
}

/** The current credential lineage of one account in the profile at
 *  `authDir`, read now, or undefined when the account holds no credential or
 *  the store is not healthy. A saved catalog is written only for the lineage
 *  that is current under the profile lock, so the caller reads it under that
 *  lock. Lineages are keyed by account: two accounts of one provider each
 *  have their own. */
export function currentCredentialLineage(
  definitions: readonly AccessProviderDefinition[],
  authDir: string,
  classifySlot: CredentialSlotClassifier,
  account: AccessProviderAccountIdentity,
): string | undefined {
  const definition = definitions.find(({ id }) => id === account.providerId);
  if (definition === undefined) return undefined;
  const { store, credentialLineages, conditions } = loadAuthStoreWithDiagnostics(authDir, undefined, classifySlot, false);
  if (conditions.length > 0) return undefined;
  if (account.kind === "singleton") return credentialLineages[credentialIdOf(definition)];
  return captureSubscriptionCredentials([definition], { kind: "decoded", store, authDir })
    .get(definition.id)?.find(({ instanceId }) => instanceId === account.instanceId)?.lineageId;
}

/** The redacted runtime form of a stored credential DTO. */
export function runtimeCredential(credential: OAuthCredential): RuntimeOAuthCredential;
export function runtimeCredential(credential: Credential): RuntimeCredential;
export function runtimeCredential(credential: Credential): RuntimeCredential {
  return credential.type === "api_key"
    ? Object.freeze({ type: "api_key", key: Redacted.make(credential.key) })
    : Object.freeze({
        type: "oauth",
        access: Redacted.make(credential.access),
        ...(credential.refresh === undefined ? {} : { refresh: Redacted.make(credential.refresh) }),
        expires: credential.expires,
        ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
        ...(credential.enterpriseDomain === undefined ? {} : { enterpriseDomain: credential.enterpriseDomain }),
      });
}

/** The one plaintext crossing for an OAuth credential: the store persists the
 *  DTO, and nothing else reads a token's value. */
export function oauthCredentialDto(credential: RuntimeOAuthCredential): OAuthCredential {
  return {
    type: "oauth",
    access: Redacted.value(credential.access),
    ...(credential.refresh === undefined ? {} : { refresh: Redacted.value(credential.refresh) }),
    expires: credential.expires,
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
    ...(credential.enterpriseDomain === undefined ? {} : { enterpriseDomain: credential.enterpriseDomain }),
  };
}

interface ResolveAuthOptions {
  readonly load?: AuthStoreLoadResult;
  readonly definitions?: readonly AccessProviderDefinition[];
  /** Account credential directory, derived from the startup `userDataRoot`. */
  readonly authDir: string;
  /** Resolves a stored key, running the helper a leading `!` names. Injected:
   *  this module reads credentials and never launches. */
  readonly resolveKey: KeyResolver;
  /** Installed credential vocabulary supplied by the orchestration catalog. */
  readonly credentialProviderIds?: readonly string[];
  /** Canonical credential multiplicity from the exact installed module snapshot. */
  readonly credentialSlotClassifier: CredentialSlotClassifier;
}

/** Folds one stored entry into the account state it names, or nothing.
 *  Resolution runs the helper a `!command` key names; a key that does not
 *  resolve is absent, not misconfigured. */
async function providerAuthState(value: AuthStore[string], resolveKey: KeyResolver): Promise<ProviderAuthState | undefined> {
  if (isCredentialCollection(value)) {
    return value.some(({ credential }) => credential.type === "oauth") ? { kind: "oauth" } : undefined;
  }
  if (value?.type === "oauth") return { kind: "oauth" };
  if (value?.type !== "api_key") return undefined;
  const resolved = await resolveKey(value.key);
  return resolved === undefined ? undefined : { kind: "api_key", key: resolved };
}

export interface ResolveAuthContextFromStoreOptions {
  readonly store: AuthStore;
  readonly resolveKey: KeyResolver;
  readonly droppedCredentials?: readonly string[];
  readonly credentialLineages: CredentialLineages;
  readonly conditions?: readonly AuthStoreCondition[];
}

/** Resolves one already-decoded credential snapshot into redacted runtime
 *  authentication. The store's own keys are the vocabulary: the decoder that
 *  produced it already rejected ids the installed catalog does not know. */
export async function resolveAuthContextFromStore(options: ResolveAuthContextFromStoreOptions): Promise<AuthContext> {
  const { store, resolveKey } = options;
  const conditions = options.conditions ?? [];
  const states = await Promise.all(Object.entries(store).map(async ([providerId, value]) => [providerId, await providerAuthState(value, resolveKey)] as const));
  return Object.freeze({
    providers: new Map(states.flatMap(([providerId, state]) => (state === undefined ? [] : [[providerId, state] as const]))),
    credentialLineages: Object.freeze({ ...options.credentialLineages }),
    droppedCredentials: options.droppedCredentials ?? [],
    ...(conditions.length === 0 ? {} : { conditions }),
  });
}

export async function resolveAuthContext(options: ResolveAuthOptions): Promise<AuthContext> {
  const load = options.load ?? loadAuthStoreWithDiagnostics(options.authDir, options.credentialProviderIds, options.credentialSlotClassifier);
  const { store, credentialLineages, dropped, conditions } = load;
  const auth = await resolveAuthContextFromStore({ store, resolveKey: options.resolveKey, credentialLineages, droppedCredentials: dropped, conditions });
  return Object.freeze({
    ...auth, observation: authStoreObservationKey(load),
    ...(options.definitions === undefined ? {} : { subscriptionCredentials: captureSubscriptionCredentials(options.definitions, { kind: "decoded", store, authDir: options.authDir }) }),
  });
}