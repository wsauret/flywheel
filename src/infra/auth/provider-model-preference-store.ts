import { createHash } from "node:crypto";
import type { AuthProfileAccess } from "./auth-profile-store.js";
import { authStoreRevision } from "./auth-store.js";
import { accessProviderAccountKey, type AccessProviderAccountIdentity } from "../llm/access-provider.js";
import { canonicalModelId } from "../llm/model-id.js";
import type { GroupedOfferingIndex } from "../llm/model-catalog-resolution.js";
import { transitionProviderAutoEnableNewModels, type ProviderModelDeltas } from "../llm/provider-model-preferences.js";

export const PROVIDER_MODEL_PREFERENCES_FILE = "model-preferences.json";
const MAX_BYTES = 1024 * 1024;
const PROVIDER_ID = /^[a-z][a-z0-9_-]{1,31}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/;

export type ProviderModelPreferenceState = "default" | "enabled" | "disabled";
export interface AccountProviderModelPreference extends ProviderModelDeltas {
  readonly account: AccessProviderAccountIdentity;
  readonly preferFreeRoutes: boolean;
}
export interface ProviderModelPreferences {
  readonly autoEnableNewModels: boolean;
  readonly accounts: ReadonlyMap<string, AccountProviderModelPreference>;
}

class MalformedProviderModelPreferencesError extends Error {
  override readonly name = "MalformedProviderModelPreferencesError";
}

export function readProviderModelPreferences(
  access: AuthProfileAccess,
  offeringIndexes: ReadonlyMap<string, GroupedOfferingIndex>,
): ProviderModelPreferences {
  const decoded = decode(access.readFile(PROVIDER_MODEL_PREFERENCES_FILE, MAX_BYTES), offeringIndexes);
  if (decoded.version === 1) throw malformed();
  return { autoEnableNewModels: decoded.autoEnableNewModels, accounts: decoded.accounts };
}

/** Digest for detecting a provider-model preference replacement. */
export function providerModelPreferencesRevision(access: AuthProfileAccess): string {
  const bytes = access.readFile(PROVIDER_MODEL_PREFERENCES_FILE, MAX_BYTES);
  const hash = createHash("sha256").update(bytes === undefined ? "absent" : "present");
  if (bytes !== undefined) hash.update(bytes);
  return hash.digest("hex");
}

/** Migrates legacy provider preferences only while the captured account set still matches auth.json. */
export async function prepareProviderModelPreferences(
  access: AuthProfileAccess,
  capturedAuthRevision: string,
  currentAccounts: readonly AccessProviderAccountIdentity[],
  currentAuthRevision: () => string,
  offeringIndexes: ReadonlyMap<string, GroupedOfferingIndex>,
  persistence: "persist" | "read-only" = "persist",
): Promise<ProviderModelPreferences | undefined> {
  if (persistence === "read-only") {
    const decoded = decode(access.readFile(PROVIDER_MODEL_PREFERENCES_FILE, MAX_BYTES), offeringIndexes);
    if (decoded.version !== 1) return { autoEnableNewModels: decoded.autoEnableNewModels, accounts: decoded.accounts };
    const accounts = new Map<string, MutableAccountPreference>();
    for (const [providerId, delta] of decoded.providers) {
      for (const account of currentAccounts.filter((candidate) => candidate.providerId === providerId)) {
        const key = accessProviderAccountKey(account);
        const preference = mutableAccount(account, convertDelta(delta, offeringIndexes.get(key)));
        if (!emptyPreference(preference)) accounts.set(key, preference);
      }
    }
    return { autoEnableNewModels: true, accounts: immutableAccounts(accounts) };
  }
  return access.withLock(() => {
    if (currentAuthRevision() !== capturedAuthRevision) return undefined;
    const bytes = access.readFile(PROVIDER_MODEL_PREFERENCES_FILE, MAX_BYTES);
    const decoded = decode(bytes, offeringIndexes);
    if (decoded.version !== 1) {
      const accounts = mutableAccounts(decoded.accounts);
      const canonical = encode(decoded.autoEnableNewModels, accounts);
      if (bytes !== undefined && bytes.toString("utf8") !== canonical) access.writeFile(PROVIDER_MODEL_PREFERENCES_FILE, canonical);
      return { autoEnableNewModels: decoded.autoEnableNewModels, accounts: immutableAccounts(accounts) };
    }
    const accounts = new Map<string, MutableAccountPreference>();
    for (const [providerId, delta] of decoded.providers) {
      const matching = currentAccounts.filter((account) => account.providerId === providerId);
      for (const account of matching) {
        const key = accessProviderAccountKey(account);
        const preference = mutableAccount(account, convertDelta(delta, offeringIndexes.get(key)));
        if (!emptyPreference(preference)) accounts.set(key, preference);
      }
    }
    if (accounts.size === 0) access.removeFile(PROVIDER_MODEL_PREFERENCES_FILE);
    else access.writeFile(PROVIDER_MODEL_PREFERENCES_FILE, encode(true, accounts));
    return { autoEnableNewModels: true, accounts: immutableAccounts(accounts) };
  });
}

export async function setProviderModelPreference(
  access: AuthProfileAccess,
  account: AccessProviderAccountIdentity | string,
  modelId: string,
  state: ProviderModelPreferenceState,
  currentAccounts: readonly AccessProviderAccountIdentity[],
  expectedAuthRevision: string,
  expectedPreferenceRevision: string,
): Promise<string> {
  const normalizedAccount = typeof account === "string" ? { kind: "singleton" as const, providerId: account } : account;
  requireAccount(normalizedAccount);
  const canonicalModel = requireModelId(modelId);
  return access.withLock(() => {
    if (authStoreRevision(access) !== expectedAuthRevision || providerModelPreferencesRevision(access) !== expectedPreferenceRevision) {
      throw new Error("auth profile inputs changed during provider-model preference mutation");
    }
    const currentKeys = new Set(currentAccounts.map(accessProviderAccountKey));
    const key = accessProviderAccountKey(normalizedAccount);
    if (!currentKeys.has(key)) throw new Error("provider-model target is not a current account");
    const decoded = decode(access.readFile(PROVIDER_MODEL_PREFERENCES_FILE, MAX_BYTES), new Map());
    if (decoded.version !== 4) throw malformed();
    const preferences = mutableAccounts(decoded.accounts);
    const current = preferences.get(key) ?? mutableAccount(normalizedAccount);
    current.enabled.delete(canonicalModel);
    current.disabled.delete(canonicalModel);
    if (state === "enabled") current.enabled.add(canonicalModel);
    if (state === "disabled") current.disabled.add(canonicalModel);
    if (emptyPreference(current)) preferences.delete(key);
    else preferences.set(key, current);
    if (preferences.size === 0 && decoded.autoEnableNewModels) access.removeFile(PROVIDER_MODEL_PREFERENCES_FILE);
    else access.writeFile(PROVIDER_MODEL_PREFERENCES_FILE, encode(decoded.autoEnableNewModels, preferences));
    return providerModelPreferencesRevision(access);
  });
}

export async function deselectAllProviderModels(
  access: AuthProfileAccess,
  account: AccessProviderAccountIdentity,
  modelIds: readonly string[],
  currentAccounts: readonly AccessProviderAccountIdentity[],
  expectedAuthRevision: string,
  expectedPreferenceRevision: string,
): Promise<string> {
  const normalizedAccount = requireAccount(account);
  const disabled = new Set(modelIds.map(requireModelId));
  return access.withLock(() => {
    if (authStoreRevision(access) !== expectedAuthRevision || providerModelPreferencesRevision(access) !== expectedPreferenceRevision) {
      throw new Error("auth profile inputs changed during provider-model preference mutation");
    }
    const currentKeys = new Set(currentAccounts.map(accessProviderAccountKey));
    const key = accessProviderAccountKey(normalizedAccount);
    if (!currentKeys.has(key)) throw new Error("provider-model target is not a current account");
    const decoded = decode(access.readFile(PROVIDER_MODEL_PREFERENCES_FILE, MAX_BYTES), new Map());
    if (decoded.version !== 4) throw malformed();
    const preferences = mutableAccounts(decoded.accounts);
    const current = preferences.get(key) ?? mutableAccount(normalizedAccount);
    for (const modelId of disabled) {
      current.enabled.delete(modelId);
      current.disabled.add(modelId);
    }
    if (emptyPreference(current)) preferences.delete(key);
    else preferences.set(key, current);
    if (preferences.size === 0 && decoded.autoEnableNewModels) access.removeFile(PROVIDER_MODEL_PREFERENCES_FILE);
    else access.writeFile(PROVIDER_MODEL_PREFERENCES_FILE, encode(decoded.autoEnableNewModels, preferences));
    return providerModelPreferencesRevision(access);
  });
}

/** Sets one exact account's free-route policy under the auth and preference revision fence. */
export async function setProviderFreeRoutePreference(
  access: AuthProfileAccess,
  account: AccessProviderAccountIdentity,
  preferFreeRoutes: boolean,
  currentAccounts: readonly AccessProviderAccountIdentity[],
  expectedAuthRevision: string,
  expectedPreferenceRevision: string,
): Promise<string> {
  const normalizedAccount = requireAccount(account);
  return access.withLock(() => {
    if (authStoreRevision(access) !== expectedAuthRevision || providerModelPreferencesRevision(access) !== expectedPreferenceRevision) {
      throw new Error("auth profile inputs changed during provider-model preference mutation");
    }
    const currentKeys = new Set(currentAccounts.map(accessProviderAccountKey));
    const key = accessProviderAccountKey(normalizedAccount);
    if (!currentKeys.has(key)) throw new Error("provider-model target is not a current account");
    const decoded = decode(access.readFile(PROVIDER_MODEL_PREFERENCES_FILE, MAX_BYTES), new Map());
    if (decoded.version !== 4) throw malformed();
    const preferences = mutableAccounts(decoded.accounts);
    const current = preferences.get(key) ?? mutableAccount(normalizedAccount);
    current.preferFreeRoutes = preferFreeRoutes;
    if (emptyPreference(current)) preferences.delete(key);
    else preferences.set(key, current);
    if (preferences.size === 0 && decoded.autoEnableNewModels) access.removeFile(PROVIDER_MODEL_PREFERENCES_FILE);
    else access.writeFile(PROVIDER_MODEL_PREFERENCES_FILE, encode(decoded.autoEnableNewModels, preferences));
    return providerModelPreferencesRevision(access);
  });
}

/** Changes how unseen catalog rows default while preserving every current check and explicit deselection. */
export async function setProviderAutoEnableNewModels(
  access: AuthProfileAccess,
  enabled: boolean,
  accountCatalogs: ReadonlyMap<string, { readonly account: AccessProviderAccountIdentity; readonly effectiveModelIds: readonly string[]; readonly catalogModelIds: readonly string[] }>,
  currentAccounts: readonly AccessProviderAccountIdentity[],
  expectedAuthRevision: string,
  expectedPreferenceRevision: string,
): Promise<string> {
  return access.withLock(() => {
    if (authStoreRevision(access) !== expectedAuthRevision || providerModelPreferencesRevision(access) !== expectedPreferenceRevision) {
      throw new Error("auth profile inputs changed during provider-model preference mutation");
    }
    const currentKeys = new Set(currentAccounts.map(accessProviderAccountKey));
    const decoded = decode(access.readFile(PROVIDER_MODEL_PREFERENCES_FILE, MAX_BYTES), new Map());
    if (decoded.version !== 4) throw malformed();
    const preferences = mutableAccounts(decoded.accounts);
    for (const [key, snapshot] of accountCatalogs) {
      if (!currentKeys.has(key) || accessProviderAccountKey(requireAccount(snapshot.account)) !== key) throw new Error("provider-model target is not a current account");
      const current = preferences.get(key) ?? mutableAccount(snapshot.account);
      const transition = transitionProviderAutoEnableNewModels(current, new Set(snapshot.effectiveModelIds.map(requireModelId)), new Set(snapshot.catalogModelIds.map(requireModelId)), enabled);
      const next = { ...current, enabled: new Set(transition.enabled), disabled: new Set(transition.disabled) };
      if (emptyPreference(next)) preferences.delete(key);
      else preferences.set(key, next);
    }
    if (preferences.size === 0 && enabled) access.removeFile(PROVIDER_MODEL_PREFERENCES_FILE);
    else access.writeFile(PROVIDER_MODEL_PREFERENCES_FILE, encode(enabled, preferences));
    return providerModelPreferencesRevision(access);
  });
}

/** Moves the preferences of each `from` account to its `to` account, and returns how many moved. A `to` account
 *  that already holds preferences keeps its own. A version 1 document names providers, not accounts, so nothing in
 *  it moves. */
export async function transferProviderModelPreferences(access: AuthProfileAccess, transfers: readonly { readonly from: AccessProviderAccountIdentity; readonly to: AccessProviderAccountIdentity }[]): Promise<number> {
  return access.withLock(() => {
    const bytes = access.readFile(PROVIDER_MODEL_PREFERENCES_FILE, MAX_BYTES);
    if (bytes === undefined) return 0;
    const decoded = decode(bytes, new Map());
    if (decoded.version === 1) return 0;
    const accounts = mutableAccounts(decoded.accounts);
    let moved = 0;
    for (const { from, to } of transfers) {
      const entry = accounts.get(accessProviderAccountKey(from));
      if (entry === undefined) continue;
      accounts.delete(accessProviderAccountKey(from));
      const key = accessProviderAccountKey(requireAccount(to));
      if (!accounts.has(key)) accounts.set(key, { ...entry, account: to });
      moved += 1;
    }
    if (moved > 0) access.writeFile(PROVIDER_MODEL_PREFERENCES_FILE, encode(decoded.autoEnableNewModels, accounts));
    return moved;
  });
}

type Decoded = { readonly version: 1; readonly providers: ReadonlyMap<string, ProviderModelDeltas> }
  | { readonly version: 2 | 3 | 4; readonly autoEnableNewModels: boolean; readonly accounts: ReadonlyMap<string, AccountProviderModelPreference> };
interface MutableAccountPreference { account: AccessProviderAccountIdentity; enabled: Set<string>; disabled: Set<string>; preferFreeRoutes: boolean }

function decode(bytes: Buffer | undefined, offeringIndexes: ReadonlyMap<string, GroupedOfferingIndex>): Decoded {
  if (!bytes) return { version: 4, autoEnableNewModels: true, accounts: new Map() };
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isObject(value)) throw new Error("invalid preference document");
    if (value.version === 1) return decodeV1(value);
    if (value.version === 2 || value.version === 3 || value.version === 4) return decodeAccounts(value, offeringIndexes, value.version);
    throw new Error("unsupported preference version");
  } catch {
    throw malformed();
  }
}

function decodeV1(value: UnknownObject): Decoded {
  if (!hasExactKeys(value, ["version", "providers"]) || !isObject(value.providers)) throw new Error("invalid v1 preference document");
  const providers = new Map<string, ProviderModelDeltas>();
  for (const [providerId, raw] of Object.entries(value.providers)) {
    requireProviderId(providerId);
    providers.set(providerId, decodeDelta(raw, false));
  }
  return { version: 1, providers };
}

// Remove version-2 and version-3 conversion after 2027-09-19.
function decodeAccounts(value: UnknownObject, offeringIndexes: ReadonlyMap<string, GroupedOfferingIndex>, version: 2 | 3 | 4): Decoded {
  const documentKeys = version === 4 && value.autoEnableNewModels === false ? ["version", "autoEnableNewModels", "accounts"] : ["version", "accounts"];
  if (!hasExactKeys(value, documentKeys) || !Array.isArray(value.accounts)) throw new Error("invalid account preference document");
  const accounts = new Map<string, AccountProviderModelPreference>();
  for (const raw of value.accounts) {
    const allowed = version === 2 ? ["account", "enabled", "disabled"] : ["account", "enabled", "disabled", "preferFreeRoutes"];
    if (!isObject(raw) || !hasOnlyKeys(raw, allowed)
      || !isObject(raw.account) || (raw.preferFreeRoutes !== undefined && raw.preferFreeRoutes !== true)
    ) throw new Error("invalid account preference");
    const account = decodeAccount(raw.account);
    const key = accessProviderAccountKey(account);
    const savedPreferFreeRoutes = version >= 3 && raw.preferFreeRoutes === true;
    const { enabled, disabled, preferFreeRoutes } = decodeDelta(raw, true, offeringIndexes.get(key), savedPreferFreeRoutes);
    if (accounts.has(key)) throw new Error("duplicate account preference");
    const preference = { account, enabled, disabled, preferFreeRoutes: savedPreferFreeRoutes || preferFreeRoutes };
    // A conversion can drop every choice of an account; an empty entry would not decode again.
    if (enabled.size > 0 || disabled.size > 0 || preference.preferFreeRoutes) accounts.set(key, preference);
  }
  return { version, autoEnableNewModels: version < 4 || value.autoEnableNewModels !== false, accounts };
}

function decodeAccount(value: UnknownObject): AccessProviderAccountIdentity {
  if (value.kind === "singleton" && hasExactKeys(value, ["kind", "providerId"]) && typeof value.providerId === "string") return requireAccount({ kind: "singleton", providerId: value.providerId });
  if (value.kind === "subscription" && hasExactKeys(value, ["kind", "providerId", "instanceId"]) && typeof value.providerId === "string" && typeof value.instanceId === "string") return requireAccount({ kind: "subscription", providerId: value.providerId, instanceId: value.instanceId });
  throw new Error("invalid account identity");
}

type ConvertedDelta = ProviderModelDeltas & { readonly preferFreeRoutes: boolean };

function decodeDelta(value: unknown, allowAccount: boolean, offeringIndex?: GroupedOfferingIndex, allowEmpty = false): ConvertedDelta {
  if (!isObject(value) || !hasOnlyKeys(value, allowAccount ? ["account", "enabled", "disabled", "preferFreeRoutes", "autoEnableNewModels"] : ["enabled", "disabled"])) throw new Error("invalid preference delta");
  const delta = { enabled: decodeIds(value.enabled), disabled: decodeIds(value.disabled) };
  if (delta.enabled.size === 0 && delta.disabled.size === 0 && !allowEmpty) throw new Error("empty preference delta");
  return convertDelta(delta, offeringIndex);
}

/** Converts saved choices to the models that own them. A saved choice under an offering's wire spelling converts to
 *  the model that owns that offering: earlier releases saved snapshot-dated wires, and releases before 2026-10-24
 *  saved each OpenCode Go wire, free wires such as beam-free included, as its own model. A free wire was always
 *  served free, so a free wire that is now a free route of a model with a paid wire keeps that meaning: enabling it
 *  enables the model and makes the account prefer free routes, and disabling it never disabled the paid route, so
 *  that choice is dropped. Both conversions share this code: remove it, snapshot-dated and free wires alike, after
 *  2027-01-24. */
function convertDelta(delta: ProviderModelDeltas, offeringIndex: GroupedOfferingIndex | undefined): ConvertedDelta {
  const choices = new Map<string, { readonly state: "enabled" | "disabled"; readonly canonical: boolean }>();
  let preferFreeRoutes = false;
  for (const [state, rawIds] of [["enabled", delta.enabled], ["disabled", delta.disabled]] as const) {
    for (const rawId of rawIds) {
      const offering = offeringIndex?.get(requireModelId(rawId));
      if (offering?.freeRoute === true) {
        if (state === "disabled") continue;
        preferFreeRoutes = true;
      }
      const modelId = offering?.modelId ?? rawId;
      const candidate = { state, canonical: rawId === modelId };
      const current = choices.get(modelId);
      if (!current || (candidate.canonical && !current.canonical) || (candidate.canonical === current.canonical && state === "disabled")) {
        choices.set(modelId, candidate);
      }
    }
  }
  const enabled = new Set([...choices].filter(([, choice]) => choice.state === "enabled").map(([modelId]) => modelId));
  const disabled = new Set([...choices].filter(([, choice]) => choice.state === "disabled").map(([modelId]) => modelId));
  return { enabled, disabled, preferFreeRoutes };
}

function decodeIds(value: unknown): ReadonlySet<string> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length === 0) throw new Error("invalid model preference list");
  const result = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error("invalid model preference");
    requireModelId(item);
    if (result.has(item)) throw new Error("duplicate model preference");
    result.add(item);
  }
  return result;
}

function encode(autoEnableNewModels: boolean, preferences: ReadonlyMap<string, MutableAccountPreference>): string {
  const accounts = [...preferences.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(([, entry]) => ({
    account: entry.account,
    ...(entry.enabled.size === 0 ? {} : { enabled: [...entry.enabled].toSorted() }),
    ...(entry.disabled.size === 0 ? {} : { disabled: [...entry.disabled].toSorted() }),
    ...(entry.preferFreeRoutes ? { preferFreeRoutes: true } : {}),
  }));
  return `${JSON.stringify({ version: 4, ...(autoEnableNewModels ? {} : { autoEnableNewModels: false }), accounts }, null, 2)}\n`;
}

/** Every write keeps the choices of each account it does not target, current or not. An account that is not
 *  current now can come back: a disabled provider, or an external login that discovery did not find while its
 *  program rewrote its files. */
function mutableAccounts(source: ReadonlyMap<string, AccountProviderModelPreference>): Map<string, MutableAccountPreference> {
  return new Map([...source].map(([key, value]) => [key, mutableAccount(value.account, value)]));
}
function immutableAccounts(source: ReadonlyMap<string, MutableAccountPreference>): ReadonlyMap<string, AccountProviderModelPreference> {
  return new Map([...source].map(([key, value]) => [key, { account: value.account, enabled: value.enabled, disabled: value.disabled, preferFreeRoutes: value.preferFreeRoutes }]));
}
function mutableAccount(account: AccessProviderAccountIdentity, delta?: ProviderModelDeltas | AccountProviderModelPreference): MutableAccountPreference {
  return {
    account,
    enabled: new Set(delta?.enabled),
    disabled: new Set(delta?.disabled),
    preferFreeRoutes: delta !== undefined && "preferFreeRoutes" in delta && delta.preferFreeRoutes,
  };
}
function emptyPreference(preference: MutableAccountPreference): boolean {
  return preference.enabled.size === 0 && preference.disabled.size === 0 && !preference.preferFreeRoutes;
}
function requireAccount(account: AccessProviderAccountIdentity): AccessProviderAccountIdentity {
  requireProviderId(account.providerId);
  if (account.kind === "subscription" && account.instanceId.length === 0) throw new Error("Subscription account instance id must not be empty");
  return account;
}
function requireProviderId(id: string): string {
  if (!PROVIDER_ID.test(id)) throw new Error(`Invalid provider id: ${JSON.stringify(id)}`);
  return id;
}
function requireModelId(id: string): string {
  const canonical = canonicalModelId(id);
  if (!MODEL_ID.test(canonical)) throw new Error(`Invalid model id: ${JSON.stringify(id)}`);
  return canonical;
}
function malformed(): MalformedProviderModelPreferencesError {
  return new MalformedProviderModelPreferencesError("model-preferences.json is malformed; repair or remove it before changing model preferences.");
}
interface UnknownObject { readonly [key: string]: unknown }
function isObject(value: unknown): value is UnknownObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasOnlyKeys(value: UnknownObject, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function hasExactKeys(value: UnknownObject, expected: readonly string[]): boolean { return Object.keys(value).length === expected.length && hasOnlyKeys(value, expected); }