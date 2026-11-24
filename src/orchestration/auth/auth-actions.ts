/**
 * Orchestration auth actions - all credential mutation flows.
 *
 * TUI and CLI call these functions, never the store directly.
 * Each mutation writes to the unified auth store, then returns
 * a fresh AuthContext snapshot.
 */

import type { AuthAccountAttention, AuthProviderAttention } from "../../protocol/auth-status-protocol-types.js";
import { Redacted } from "effect";
import { oauthCredentialDto, resolveAuthContext, runtimeCredential, type AuthContext } from "../../infra/auth/auth-context.js";
import type { AuthProfileAccess } from "../../infra/auth/auth-profile-store.js";
import type { KeyResolver } from "../../infra/auth/resolve-key.js";
import {
  appendCredentialInstanceWithReceipt,
  AuthStoreMutationError,
  CredentialCollectionChangedError,
  deleteCredentialInstance,
  deleteProviderCredentials,
  renameCredentialInstance,
  replaceCredentialInstance,
  replaceCredentialInstanceWithReceipt,
  replaceRejectedProviderCredentialsWithReceipt,
  rollbackAuthStoreMutation,
  setMeteredCredentialWithReceipt,
  type AuthStoreMutationReceipt,
  type CredentialCollectionReview,
} from "../../infra/auth/auth-store-mutations.js";
import { loadAuthStoreWithDiagnostics, storedApiKeyHint, type AuthStoreCondition, type AuthStoreDiagnostic, type AuthStoreLoadResult } from "../../infra/auth/auth-store.js";
import { isCredentialCollection, type AuthStore, type Credential, type CredentialInstance, type CredentialProviderId } from "../../infra/auth/auth-store-types.js";
import { isWebProviderId } from "../../infra/auth/web-providers.js";
import { storedTokensToCredential } from "../../infra/auth/openai-auth-types.js";
import { FREE_PLAN_REPLACE_QUESTION, isFreePlan } from "../../infra/llm/free-plan-accounts.js";
import type { SubscriptionUsageReader, SubscriptionUsageReport } from "../../infra/llm/subscription-usage.js";
import { createUsageAuthority, type UsageAuthority } from "../../infra/llm/usage-authority.js";
import type { SubscriptionUsageSnapshot } from "../../infra/llm/subscription-usage-store-codec.js";
import { keptFreePlanMessage } from "../../protocol/client/auth-login.js";
import { errorMessage } from "../../infra/error-message.js";
import { apiKeyRejectionReason, type AccessProviderDefinition, type BrowserLoginPorts, type DeviceCodeLoginPorts, type ExternalLoginDefinition, type OAuthLoginResult } from "../../infra/llm/access-provider.js";
import type { LauncherScope } from "../../infra/process-supervisor.js";
import { Log } from "../../infra/log.js";
import { customProviderRejections } from "../../infra/llm/custom-provider-registry.js";
// Auth reads the credential provider registry alone: a login loads the
// provider definitions it needs and never a tool or another module. Each read
// is per call, not at module load: the installed vocabulary includes
// [custom_providers] entries that exist only after config load, and this
// module is imported before any config is read.
// Stored accounts keep their classification and labels while their module is
// off. Login lookup describes a flow; CLI and runtime callers admit the provider
// through their effective selection before they invoke it.
import { installedAccessProviderDefinitions, installedAccessProviderSelection, installedCredentialProviderIds, installedCredentialSlotClassifier, installedUsageReader, installedWebAuthProviderDefinitions } from "../credential-provider-modules.js";
import { credentialIdOf, isExternalLoginDefinition, type AccessProviderAccountIdentity } from "../../infra/auth/provider-account.js";
const destination = (authDir: string, writeAccess?: AuthProfileAccess) => writeAccess ?? authDir;
const log = Log.create({ service: "auth-actions" });

/** The installed definition of `providerId` when another program owns its login. */
const externalLogin = (providerId: string) => installedAccessProviderDefinitions().filter(isExternalLoginDefinition).find(({ id }) => id === providerId);
const freshContext = (authDir: string, resolveKey: KeyResolver) => resolveAuthContext({ authDir, resolveKey, credentialProviderIds: installedCredentialProviderIds(), credentialSlotClassifier: installedCredentialSlotClassifier() });

/** A rule refused the account that a sign-in named, and nothing was stored. The message states why and what the
 *  person can do. */
export class LoginRefusedError extends Error {
  readonly _tag = "LoginRefusedError" as const;
}

/** Completes provider catalog reconciliation after a credential commit. */
export type AuthCatalogSettlement = (account: AccessProviderAccountIdentity, authDirectory: string, signal?: AbortSignal) => Promise<void>;

class AuthSettlementConflictError extends Error {
  constructor(options: { readonly cause: unknown }) {
    super("Catalog settlement failed after the credential changed concurrently", options);
    this.name = "AuthSettlementConflictError";
  }
}

async function settleOrRollback(
  settle: AuthCatalogSettlement,
  account: AccessProviderAccountIdentity,
  authDirectory: string,
  rollback: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await settle(account, authDirectory, signal);
  } catch (error) {
    if (!await rollback()) throw new AuthSettlementConflictError({ cause: error });
    throw error;
  }
}

/** One stored account of a provider with a subscription credential slot. */
type SubscriptionAccount = Omit<Extract<AccessProviderAccountIdentity, { readonly kind: "subscription" }>, "kind">;

function selectedInstance({ providerId, instanceId }: SubscriptionAccount, authDir: string): CredentialInstance {
  const loaded = loadAuthStoreWithDiagnostics(authDir, installedCredentialProviderIds(), installedCredentialSlotClassifier());
  if (loaded.diagnostics.length > 0) throw new Error(`Cannot reconnect ${providerId}: auth store is invalid`);
  const collection = loaded.store[providerId];
  if (!isCredentialCollection(collection)) throw new Error(`Credential instance ${instanceId} does not exist for ${providerId}`);
  const instance = collection.find((candidate) => candidate.id === instanceId);
  if (!instance) throw new Error(`Credential instance ${instanceId} does not exist for ${providerId}`);
  return instance;
}

interface SubscriptionPersistResult {
  readonly instanceId: string;
  readonly persisted: boolean;
  readonly receipt?: AuthStoreMutationReceipt;
}

/** Replaces one account's credential in place. An identity the flow reported
 *  replaces the stored one, because reconnecting as another account is the
 *  account changing; a flow that reported none keeps it. */
function reconnectPersistence(instanceId: string, expected: Credential, replaced: (value: boolean) => void): SubscriptionPersist {
  return async (providerId, credential, target, instance, signal) => {
    const receipt = await replaceCredentialInstanceWithReceipt(providerId, instanceId, expected, credential, target, installedCredentialSlotClassifier(), signal, instance.identity);
    replaced(receipt !== undefined);
    return {
      instanceId,
      persisted: receipt !== undefined,
      ...(receipt === undefined ? {} : { receipt }),
    };
  };
}

type SubscriptionPersist = (providerId: CredentialProviderId, credential: Credential, destination: string | AuthProfileAccess, instance: { id: string; identity: string | undefined }, signal?: AbortSignal, review?: CredentialCollectionReview) => Promise<SubscriptionPersistResult>;

/** Appends a new account. An account the flow could not name gets a stable
 *  label from the provider and its id, so the list never shows a blank row. */
const persistSubscription: SubscriptionPersist = async (providerId, credential, target, instance, signal, review) => {
  const replacement = { id: instance.id, identity: instance.identity ?? `${credentialProviderDisplayName(providerId)} ${instance.id.slice(0, 8)}`, credential };
  try {
    const receipt = await appendCredentialInstanceWithReceipt(providerId, replacement, target, installedCredentialSlotClassifier(), signal, review);
    return { instanceId: instance.id, persisted: true, receipt };
  } catch (error) {
    if (!(error instanceof AuthStoreMutationError)) throw error;
    const receipt = await replaceRejectedProviderCredentialsWithReceipt(providerId, [replacement], target, installedCredentialSlotClassifier(), signal);
    if (receipt === undefined) throw error;
    return { instanceId: instance.id, persisted: true, receipt };
  }
};

async function appendSubscription(providerId: CredentialProviderId, identity: string | undefined, credential: Credential, authDir: string, writeAccess: AuthProfileAccess | undefined, persist: SubscriptionPersist, signal?: AbortSignal, review?: CredentialCollectionReview): Promise<SubscriptionPersistResult> {
  signal?.throwIfAborted();
  return persist(providerId, credential, destination(authDir, writeAccess), { id: crypto.randomUUID(), identity }, signal, review);
}

/** Display name across both credential id spaces (model access and web). */
export function credentialProviderDisplayName(id: CredentialProviderId): string {
  return isWebProviderId(id)
    ? installedWebAuthProviderDefinitions().find((definition) => definition.id === id)?.displayName ?? id
    : installedAccessProviderSelection().displayName(id);
}

/** Stores one API key. A provider whose credential slot is a subscription
 *  collection (an API-key plan with accounts) gets a new instance named by
 *  the resolved key's tail; a metered provider's one key is replaced.
 *
 *  Mutations can use a manager-issued descriptor while the returned context
 *  remains a fresh immutable snapshot of the startup-resolved directory. */
export async function loginWithApiKey(providerId: CredentialProviderId, key: string, authDir: string, resolveKey: KeyResolver, writeAccess: AuthProfileAccess | undefined, settle: AuthCatalogSettlement): Promise<AuthContext> {
  const original = key.trim();
  if (!original) throw new Error("API key must not be empty");
  // Reject a key that visibly belongs to a different provider: storing it
  // would toast success and then silently serve no models. `!command`
  // indirection resolves later, so its shape cannot be checked here.
  if (!original.startsWith("!")) {
    const rejection = apiKeyRejectionReason(installedAccessProviderDefinitions(), providerId, original);
    if (rejection) throw new Error(rejection);
  }
  const credential = await apiKeyLoginCredential(providerId, original, resolveKey);
  let account: AccessProviderAccountIdentity = { kind: "singleton", providerId };
  let receipt: AuthStoreMutationReceipt | undefined;
  const target = destination(authDir, writeAccess);
  if (installedCredentialSlotClassifier()(providerId) === "subscription") {
    const value = Redacted.value(await resolveLoginKey(providerId, original, resolveKey));
    const persisted = await appendSubscription(providerId, `••••${value.slice(-4)}`, credential, authDir, writeAccess, persistSubscription);
    account = { kind: "subscription", providerId, instanceId: persisted.instanceId };
    receipt = persisted.receipt;
  } else {
    try {
      receipt = await setMeteredCredentialWithReceipt(providerId, credential, target, installedCredentialSlotClassifier());
    } catch (error) {
      if (!(error instanceof AuthStoreMutationError)) throw error;
      receipt = await replaceRejectedProviderCredentialsWithReceipt(providerId, credential, target, installedCredentialSlotClassifier());
      if (receipt === undefined) throw error;
    }
  }
  if (receipt === undefined) throw new Error(`Credential mutation receipt is unavailable for ${providerId}`);
  await settleOrRollback(settle, account, authDir, () => rollbackAuthStoreMutation(receipt, target, installedCredentialSlotClassifier()));
  return freshContext(authDir, resolveKey);
}

async function resolveLoginKey(providerId: CredentialProviderId, key: string, resolveKey: KeyResolver): Promise<Redacted.Redacted<string>> {
  const resolved = await resolveKey(key);
  if (resolved === undefined) throw new Error(`${credentialProviderDisplayName(providerId)} credential could not be resolved`);
  return resolved;
}

/** The credential that an entered key stores: the key as entered and, for a provider that addresses every request to
 *  the key's project, the project that the provider finds from the resolved key (ARCH-PROVIDERS-082). A discovery that
 *  fails throws its cause, and the login stores nothing. */
async function apiKeyLoginCredential(providerId: CredentialProviderId, key: string, resolveKey: KeyResolver): Promise<Credential> {
  const definition = installedAccessProviderDefinitions().find((candidate) => candidate.auth.kind === "api_key" && credentialIdOf(candidate) === providerId);
  const discoverProject = definition?.auth.kind === "api_key" ? definition.auth.discoverProject : undefined;
  if (discoverProject === undefined) return { type: "api_key", key };
  return { type: "api_key", key, project: await discoverProject(await resolveLoginKey(providerId, key, resolveKey)) };
}

/** Re-authenticates one API-key account and replaces it only if the selected
 *  instance still has the credential captured when the flow started. Only a
 *  provider with a subscription credential slot has instances to reconnect. */
export async function reconnectWithApiKey({ providerId, instanceId }: SubscriptionAccount, key: string, authDir: string, resolveKey: KeyResolver, settle: AuthCatalogSettlement): Promise<boolean> {
  if (installedCredentialSlotClassifier()(providerId) !== "subscription") throw new Error(`Credential provider ${providerId} does not support instance reconnect`);
  const expected = selectedInstance({ providerId, instanceId }, authDir).credential;
  const original = key.trim();
  if (!original) throw new Error("API key must not be empty");
  await resolveLoginKey(providerId, original, resolveKey);
  const replacement = { type: "api_key", key: original } as const;
  const receipt = await replaceCredentialInstanceWithReceipt(providerId, instanceId, expected, replacement, authDir, installedCredentialSlotClassifier());
  if (receipt === undefined) return false;
  await settleOrRollback(
    settle,
    { kind: "subscription", providerId, instanceId },
    authDir,
    () => rollbackAuthStoreMutation(receipt, authDir, installedCredentialSlotClassifier()),
  );
  return true;
}

/** The ports a client supplies to an OAuth login beside the flow's own: the
 *  profile the credential lands in, the settlement that confirms it, and the
 *  launch authority that runs an external login's program. */
interface OAuthLoginOptions {
  /** The claimed external-login episode. Its owner renews only after catalog settlement. */
  readonly loginQuestionId?: string;
  readonly authDir: string;
  /** The auth profile that `authDir` holds, whose usage authority keeps the plan of each account (PI-MODEL-038, PI-MODEL-069). */
  readonly profileId: string;
  /** Resolves the stored key of the fresh snapshot this flow returns. */
  readonly resolveKey: KeyResolver;
  readonly writeAccess?: AuthProfileAccess;
  readonly settle: AuthCatalogSettlement;
  readonly launcher: LauncherScope;
  /** Asks the person `question` before a paid account replaces the free-plan accounts of its provider
   *  (PI-MODEL-069). Resolves true to replace them. Absent, such a login stores nothing. */
  readonly confirmReplace?: (question: string, signal?: AbortSignal) => Promise<boolean>;
}

/** What a client supplies to remove an account: the profile access that
 *  writes the store, and the launch authority that runs an external login's
 *  logout. */
export interface ProviderAccountPorts {
  readonly writeAccess?: AuthProfileAccess;
  readonly launcher: LauncherScope;
}

/** The definition whose OAuth flow a client drives, with the ports that flow declares. */
export type ProviderOAuthLogin =
  | { readonly flow: "device-code"; readonly login: (options: OAuthLoginOptions & DeviceCodeLoginPorts) => Promise<AuthContext>; readonly reconnect: (instanceId: string, options: OAuthLoginOptions & DeviceCodeLoginPorts) => Promise<boolean> }
  | { readonly flow: "browser"; readonly login: (options: OAuthLoginOptions & BrowserLoginPorts) => Promise<AuthContext>; readonly reconnect: (instanceId: string, options: OAuthLoginOptions & BrowserLoginPorts) => Promise<boolean> };

type OAuthDefinition = AccessProviderDefinition & { readonly auth: { readonly kind: "oauth" } };

function isOAuthDefinition(definition: AccessProviderDefinition): definition is OAuthDefinition {
  return definition.auth.kind === "oauth";
}

/** One provider that a login can run on: its definition, and the usage reader that reads the plan of its accounts. */
interface LoginProvider {
  readonly definition: AccessProviderDefinition;
  readonly usageReader?: SubscriptionUsageReader | undefined;
}

/** Every installed access provider with its usage reader, also of a module that is off. */
const installedLoginProviders = (): readonly LoginProvider[] =>
  installedAccessProviderDefinitions().map((definition) => ({ definition, usageReader: installedUsageReader(definition.id) }));

/** A login that adds an account, with the usage reader of its provider. */
interface AccountAddition {
  readonly usageReader: SubscriptionUsageReader | undefined;
}

/** Runs one provider's declared OAuth flow and stores the account it yields.
 *  The flow answers its own ports (a device code, an authorize URL); this
 *  function owns what every flow shares: the abort check, the append, the
 *  catalog settlement, and the fresh snapshot.
 *
 *  A login that adds an account passes `addition`: a new account of a provider that declares a free plan first
 *  passes the free-plan rule (PI-MODEL-069), and the plan that its sign-in read is saved in the profile's usage
 *  authority under the stored account. A reconnect replaces an account in its own place and passes no addition. */
async function storeOAuthLogin(definition: OAuthDefinition, options: OAuthLoginOptions & DeviceCodeLoginPorts & BrowserLoginPorts, persist: SubscriptionPersist, addition?: AccountAddition): Promise<AuthContext> {
  const result = await definition.auth.start(options);
  if (options.signal?.aborted) throw new Error("Login cancelled");
  const credentialId = credentialIdOf(definition);
  const ruled = addition !== undefined && definition.usage?.freePlan !== undefined;
  // Opened only when the rule reads or saves a plan.
  let opened: UsageAuthority | undefined;
  const usage = (): UsageAuthority => {
    opened ??= createUsageAuthority({ profileDir: options.authDir, profileId: options.profileId });
    return opened;
  };
  try {
    const admission = ruled ? await admitFreePlanAddition(definition, result, options, addition.usageReader, usage) : undefined;
    const persisted = await appendSubscription(credentialId, result.identity, oauthCredentialDto(result.credential), options.authDir, options.writeAccess, persist, options.signal, admission?.review);
    if (persisted.persisted) {
      if (admission?.reading !== undefined) recordSignedInPlan(usage, admission.reading, persisted.instanceId);
      await settleOrRollback(
        options.settle,
        { kind: "subscription", providerId: definition.id, instanceId: persisted.instanceId },
        options.authDir,
        () => persisted.receipt === undefined
          ? Promise.resolve(false)
          : rollbackAuthStoreMutation(persisted.receipt, destination(options.authDir, options.writeAccess), installedCredentialSlotClassifier()),
        options.signal,
      );
      const replaced = admission?.review.replaces.length ?? 0;
      if (replaced > 0) log.info("free-plan accounts replaced by a paid account", { providerId: definition.id, replaced });
    }
  } catch (error) {
    if (!(error instanceof CredentialCollectionChangedError)) throw error;
    log.info("a sign-in was refused because the provider's accounts changed during it", { providerId: definition.id });
    throw new LoginRefusedError(`The ${definition.displayName} accounts of this profile changed during the sign-in. Nothing was stored. Sign in again.`, { cause: error });
  } finally {
    opened?.dispose();
  }
  return freshContext(options.authDir, options.resolveKey);
}

interface FreePlanAdmission {
  /** The provider's accounts that the decision read, and the free-plan accounts that the new account replaces. The
   *  append commits only while the accounts are still exactly these. */
  readonly review: CredentialCollectionReview;
  /** The usage reading of the new account, absent when its plan could not be read. */
  readonly reading?: SubscriptionUsageReport;
}

/** Applies the free-plan rule to an account that a flow signed in to, before anything is stored. Refuses a free-plan
 *  account, or an account whose plan cannot be read, beside another account of its provider, and asks before a paid
 *  account replaces free-plan ones; a refusal or a declined question throws with the reason, and nothing is stored. */
async function admitFreePlanAddition(definition: OAuthDefinition, result: OAuthLoginResult, options: OAuthLoginOptions & DeviceCodeLoginPorts & BrowserLoginPorts, reader: SubscriptionUsageReader | undefined, usage: () => UsageAuthority): Promise<FreePlanAdmission> {
  const reading = await readSignedInPlan(definition, result, options, reader);
  if (options.signal?.aborted) throw new Error("Login cancelled");
  const loaded = loadAuthStoreWithDiagnostics(options.authDir, installedCredentialProviderIds(), installedCredentialSlotClassifier());
  const collection = loaded.store[credentialIdOf(definition)];
  const stored = isCredentialCollection(collection) ? collection : [];
  const reviewed = stored.map(({ id, identity }) => ({ id, identity }));
  const read = reading === undefined ? {} : { reading };
  // The credential store refuses an account with the new account's identity as a duplicate.
  const others = stored.filter(({ identity }) => identity !== result.identity);
  if (others.length === 0) return { review: { reviewed, replaces: [] }, ...read };
  const name = definition.displayName;
  if (reading === undefined) {
    log.info("an account was refused because its plan was not read", { providerId: definition.id });
    throw new LoginRefusedError(`Flywheel could not read the plan of this ${name} account, so it cannot tell whether the account may sit beside the other ${name} account of this profile. Nothing was stored. Try again later.`);
  }
  if (isFreePlan(definition, reading)) {
    log.info("free-plan account refused beside another account", { providerId: definition.id });
    throw new LoginRefusedError(`This ${name} account is on a free plan, and this profile already holds a ${name} account. Only paid accounts rotate, so a free-plan account can be the only ${name} account of a profile. Nothing was stored.`);
  }
  const replaces: string[] = [];
  for (const other of others) {
    const plan = await storedPlan(definition, other, options, reader, usage);
    if (plan !== undefined && isFreePlan(definition, plan)) replaces.push(other.id);
  }
  if (replaces.length > 0 && await options.confirmReplace?.(FREE_PLAN_REPLACE_QUESTION, options.signal) !== true) throw new Error(keptFreePlanMessage(name));
  return { review: { reviewed, replaces }, reading };
}

/** Reads the usage of the account a flow signed in to, once, with the provider's usage reader. Undefined when the
 *  reading fails, so a caller can tell a plan it could not read from a reading that names no plan. The new
 *  credential is not stored yet, so the reader cannot save a refreshed token. */
async function readSignedInPlan(definition: OAuthDefinition, result: OAuthLoginResult, options: OAuthLoginOptions & BrowserLoginPorts, reader: SubscriptionUsageReader | undefined): Promise<SubscriptionUsageReport | undefined> {
  if (reader === undefined || result.identity === undefined) return undefined;
  try {
    const outcome = await reader({
      providerId: definition.id,
      authDir: options.authDir,
      account: { instanceId: crypto.randomUUID(), identity: result.identity, credential: runtimeCredential(oauthCredentialDto(result.credential)) },
      signal: options.signal ?? new AbortController().signal,
      launcher: options.launcher,
      compareAndSetTokens: async () => false,
    });
    if (outcome.kind === "success") return outcome.report;
    log.info("the plan of a new account was not read", { providerId: definition.id, outcome: outcome.kind });
  } catch (error) {
    log.info("the plan of a new account was not read", { providerId: definition.id, error: errorMessage(error) });
  }
  return undefined;
}

/** The latest usage reading of a stored account's current identity, or a new one from the provider when the profile
 *  holds none, which the authority then keeps. Undefined when neither can be read. */
async function storedPlan(definition: OAuthDefinition, account: CredentialInstance, options: OAuthLoginOptions & BrowserLoginPorts, reader: SubscriptionUsageReader | undefined, usage: () => UsageAuthority): Promise<SubscriptionUsageSnapshot | undefined> {
  const ref = { providerId: definition.id, instanceId: account.id, identity: account.identity };
  try {
    const known = usage().current(ref);
    if (known !== undefined || reader === undefined) return known;
    return await usage().fetch(ref, (signal) => reader({
      providerId: definition.id,
      authDir: options.authDir,
      account: { instanceId: account.id, identity: account.identity, ...(account.label === undefined ? {} : { label: account.label }), credential: runtimeCredential(account.credential) },
      signal,
      launcher: options.launcher,
      compareAndSetTokens: (expected, next, tokenSignal) => replaceCredentialInstance(credentialIdOf(definition), account.id, storedTokensToCredential(expected), storedTokensToCredential(next), destination(options.authDir, options.writeAccess), installedCredentialSlotClassifier(), tokenSignal),
    }), { forceRefresh: true, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  } catch (error) {
    log.info("the plan of a stored account was not read", { providerId: definition.id, error: errorMessage(error) });
    return undefined;
  }
}

/** Saves the sign-in reading under the stored account, so the serving rule knows its plan without a usage poll. A
 *  reading that is not saved changes no decision already made, so its failure is recorded and the login goes on. */
function recordSignedInPlan(usage: () => UsageAuthority, reading: SubscriptionUsageReport, instanceId: string): void {
  try {
    usage().record({ ...reading, instanceId });
  } catch (error) {
    log.info("the plan of a new account was not saved", { providerId: reading.providerId, error: errorMessage(error) });
  }
}

/** Re-authenticates one account and replaces its credential only if the
 *  instance still holds the credential captured when the flow started. The
 *  flow's reported identity replaces the stored one, because reconnecting
 *  as another account is the account changing. */
async function reconnectWithOAuth(definition: OAuthDefinition, instanceId: string, options: OAuthLoginOptions & DeviceCodeLoginPorts & BrowserLoginPorts): Promise<boolean> {
  const credentialId = credentialIdOf(definition);
  const selected = selectedInstance({ providerId: credentialId, instanceId }, options.authDir);
  const previous = runtimeCredential(selected.credential);
  let replaced = false;
  await storeOAuthLogin(definition, { ...options, ...(previous.type === "oauth" ? { previous } : {}) }, reconnectPersistence(instanceId, selected.credential, (value) => { replaced = value; }));
  return replaced;
}

/** Runs the program that owns an external login, and confirms the account it
 *  then holds. With `instanceId`, that account logs in again in its own place.
 *  Flywheel stores nothing for the login, so nothing rolls back: a settlement
 *  that fails leaves the program's login as it is and reports the failure. */
async function loginWithExternal(definition: ExternalLoginDefinition, options: OAuthLoginOptions & BrowserLoginPorts, instanceId?: string): Promise<AuthContext> {
  const previous = instanceId === undefined ? undefined : definition.auth.accounts(options.authDir).find(({ accountId }) => accountId === instanceId);
  if (instanceId !== undefined && previous === undefined) throw new Error(`${definition.displayName} no longer holds this account. Add the account again.`);
  const account = await definition.auth.login(options.authDir, options, previous);
  if (options.signal?.aborted) throw new Error("Login cancelled");
  await options.settle({ kind: "subscription", providerId: definition.id, instanceId: account.accountId }, options.authDir, options.signal);
  return freshContext(options.authDir, options.resolveKey);
}

/** The login one provider declares, or undefined for an API-key provider and
 *  an unknown id. An external login is a browser flow: its program prints the
 *  URL and takes a pasted code. A fold over the installed definitions: adding
 *  a provider registers its flow on its definition and never edits a dispatch
 *  site. The caller must admit the provider through its effective module
 *  selection before invoking the returned flow. The provider's usage reader
 *  reads the plan of the account that a login adds, for the free-plan rule. */
export function providerLoginFlow(providerId: string, providers: readonly LoginProvider[] = installedLoginProviders()): ProviderOAuthLogin | undefined {
  const provider = providers.find(({ definition }) => definition.id === providerId);
  if (provider === undefined) return undefined;
  const { definition, usageReader } = provider;
  if (isExternalLoginDefinition(definition)) {
    return {
      flow: "browser",
      login: (options) => loginWithExternal(definition, options),
      reconnect: async (instanceId, options) => {
        await loginWithExternal(definition, options, instanceId);
        return true;
      },
    };
  }
  if (!isOAuthDefinition(definition)) return undefined;
  const login = (options: OAuthLoginOptions & DeviceCodeLoginPorts & BrowserLoginPorts) => storeOAuthLogin(definition, options, persistSubscription, { usageReader });
  const reconnect = (instanceId: string, options: OAuthLoginOptions & DeviceCodeLoginPorts & BrowserLoginPorts) => reconnectWithOAuth(definition, instanceId, options);
  return definition.auth.flow === "browser" ? { flow: "browser", login, reconnect } : { flow: "device-code", login, reconnect };
}

export async function renameProviderInstance({ providerId, instanceId }: SubscriptionAccount, label: string | undefined, authDir: string): Promise<void> {
  const external = externalLogin(providerId);
  if (external !== undefined) throw new Error(`${external.displayName} names each account by its email address and takes no label.`);
  await renameCredentialInstance(providerId, instanceId, label, authDir, installedCredentialSlotClassifier());
}

/** Removes one account. An external login's account logs out through its
 *  program; an account that the program no longer holds is already gone. */
export async function disconnectProviderInstance({ providerId, instanceId }: SubscriptionAccount, authDir: string, ports: Pick<ProviderAccountPorts, "launcher">): Promise<void> {
  const external = externalLogin(providerId);
  if (external === undefined) {
    await deleteCredentialInstance(providerId, instanceId, authDir, installedCredentialSlotClassifier());
    return;
  }
  await external.auth.logout(authDir, instanceId, { launcher: ports.launcher });
}

/** Removes every credential of a provider. Every account of an external login
 *  logs out through its program. */
export async function logoutProvider(providerId: CredentialProviderId, authDir: string, resolveKey: KeyResolver, ports: ProviderAccountPorts): Promise<AuthContext> {
  const external = externalLogin(providerId);
  if (external === undefined) await deleteProviderCredentials(providerId, destination(authDir, ports.writeAccess), installedCredentialSlotClassifier());
  else for (const { accountId } of external.auth.accounts(authDir)) await external.auth.logout(authDir, accountId, { launcher: ports.launcher });
  return freshContext(authDir, resolveKey);
}

/** Ends the external logins that live inside the auth profile directory `authDir`, before that directory is
 *  removed with the profile. A login that does not end is recorded by provider, and the removal goes on: a person
 *  who deletes a profile is not held back by a program that cannot run. */
export async function logoutProfileExternalLogins(authDir: string, launcher: LauncherScope, definitions: readonly AccessProviderDefinition[] = installedAccessProviderDefinitions()): Promise<void> {
  for (const definition of definitions.filter(isExternalLoginDefinition)) {
    try {
      await definition.auth.logoutProfile(authDir, { launcher });
    } catch (error) {
      log.warn("an external login of a removed auth profile did not end", { providerId: definition.id, failures: error instanceof AggregateError ? error.errors.length : 1 });
    }
  }
}

type AuthStatusSource = "stored_key" | "oauth" | "invalid" | "unconfigured" | "misconfigured";

interface ProviderAuthAccountStatus {
  readonly instanceId: string;
  readonly identity: string;
  readonly label?: string;
  readonly plan?: string;
  readonly expired: boolean;
  readonly source: Extract<AuthStatusSource, "stored_key" | "oauth">;
  readonly enterpriseDomain?: string;
  readonly attention?: AuthAccountAttention;
}

export interface ProviderAuthStatus {
  readonly providerId: CredentialProviderId;
  readonly source: AuthStatusSource;
  readonly expired?: boolean;
  readonly accounts: readonly ProviderAuthAccountStatus[];
  /** For a misconfigured [custom_providers] entry: the loader's rejection reason. */
  readonly detail?: string;
  /** Masked tail of a stored API key, so a user can tell which key is connected. */
  readonly keyHint?: string;
  /** For an external login: the program it runs is missing or cannot serve. */
  readonly attention?: AuthProviderAttention;
}

function accountStatus(instance: CredentialInstance): ProviderAuthAccountStatus {
  const source = instance.credential.type === "oauth" ? "oauth" : "stored_key";
  return {
    instanceId: instance.id,
    identity: instance.identity,
    ...(instance.label === undefined ? {} : { label: instance.label }),
    expired: instance.credential.type === "oauth" && Date.now() >= instance.credential.expires,
    source,
    ...(instance.credential.type === "oauth" && instance.credential.enterpriseDomain !== undefined ? { enterpriseDomain: instance.credential.enterpriseDomain } : {}),
  };
}

function providerStatus(
  providerId: CredentialProviderId,
  store: AuthStore,
  dropped: readonly string[],
): ProviderAuthStatus {
  const entry = store[providerId];
  if (isCredentialCollection(entry)) {
    const accounts = entry.map(accountStatus);
    return {
      providerId,
      source: accounts[0]?.source ?? "unconfigured",
      expired: accounts.length > 0 && accounts.every((account) => account.expired),
      accounts,
    };
  }
  if (entry?.type === "api_key") { const keyHint = storedApiKeyHint(store, providerId); return { providerId, source: "stored_key", accounts: [], ...(keyHint === undefined ? {} : { keyHint }) }; }
  if (entry?.type === "oauth") return { providerId, source: "oauth", expired: Date.now() >= entry.expires, accounts: [] };
  if (dropped.includes(providerId)) return { providerId, source: "invalid", accounts: [] };
  return { providerId, source: "unconfigured", accounts: [] };
}

export interface AuthStatusResult {
  readonly revision: string;
  readonly providers: readonly ProviderAuthStatus[];
  readonly diagnostics: readonly AuthStoreDiagnostic[];
  readonly conditions: readonly AuthStoreCondition[];
}

/** Identifies a rejected config row, never a credential slot. The colon is not valid in a custom provider id. */
export function rejectedCustomProviderStatusId(id: string): string {
  return `rejected-custom:${id}`;
}

/** An external login's accounts, as its program holds them, with the problems
 *  that this process observed. The program owns the token and its expiry, so
 *  an account reads as expired only after the provider refused its login: it
 *  must log in again before it serves. */
function externalProviderStatus(definition: ExternalLoginDefinition, authDir: string): ProviderAuthStatus {
  const problems = definition.auth.problems(authDir);
  const accounts = definition.auth.accounts(authDir).map(({ accountId, identity, plan }): ProviderAuthAccountStatus => {
    const problem = problems.find((candidate) => candidate.accountId === accountId);
    return {
      instanceId: accountId, identity, source: "oauth", expired: problem?.kind === "login-rejected",
      ...(plan === undefined ? {} : { plan }),
      ...(problem === undefined ? {} : { attention: { kind: problem.kind, message: problem.message } }),
    };
  });
  return {
    providerId: definition.id, source: accounts.length === 0 ? "unconfigured" : "oauth", expired: accounts.length > 0 && accounts.every((account) => account.expired), accounts,
  };
}

export function getAuthStatusWithDiagnostics(authDir: string, load?: AuthStoreLoadResult): AuthStatusResult {
  const { revision, store, dropped, diagnostics, conditions } = load ?? loadAuthStoreWithDiagnostics(authDir, installedCredentialProviderIds(), installedCredentialSlotClassifier());
  const providers = installedAccessProviderDefinitions();
  return {
    revision,
    providers: [
      ...providers.toSorted((left, right) => left.auth.statusRank - right.auth.statusRank)
        .map((definition) => isExternalLoginDefinition(definition) ? externalProviderStatus(definition, authDir) : providerStatus(definition.id, store, dropped)),
      ...installedWebAuthProviderDefinitions().map(({ id }) => providerStatus(id, store, dropped)),
      // Rejected [custom_providers] entries surface here so the auth modal can
      // show the user what is wrong instead of silently omitting the provider.
      ...customProviderRejections().map(({ id, reason }): ProviderAuthStatus => ({ providerId: rejectedCustomProviderStatusId(id), source: "misconfigured", accounts: [], detail: reason })),
    ],
    diagnostics,
    conditions,
  };
}

export function getAuthStatus(authDir: string): readonly ProviderAuthStatus[] {
  return getAuthStatusWithDiagnostics(authDir).providers;
}
