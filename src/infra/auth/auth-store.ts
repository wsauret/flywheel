import { Result, Schema } from "effect";
import { Log } from "../log.js";
import { apiKeyHint } from "./api-key-hint.js";
import { accountSecretFile } from "../paths.js";
import { isRecord } from "../record.js";
import type { AuthProfileAccess } from "./auth-profile-store.js";
import { AccountStorageAccessError, lockedJsonRevision, lockedJsonStorePath, readLockedJsonStore, readLockedJsonStoreRevision, type LockedJsonStoreOptions } from "./locked-json-store.js";
import { PersistedAuthStoreSchema, createAuthStoreSchema, CredentialInstanceSchema, CredentialSchema, isCredentialCollection, MeteredCredentialRecordSchema, NestedMeteredCredentialRecordSchema, type AuthStore, type Credential, type CredentialCollection, type CredentialInstance, type CredentialLineages, type CredentialProviderId, type CredentialSlotClassifier, type PersistedAuthStore } from "./auth-store-types.js";

const log = Log.create({ service: "auth-store" });
export const AUTH_STORE_FILE = "auth.json";
const MAX_AUTH_STORE_BYTES = 16 * 1024 * 1024;

export type AuthStoreDiagnostic =
  | { readonly kind: "unknown_provider"; readonly providerId: string; readonly message: string }
  | { readonly kind: "invalid_instance"; readonly providerId: string; readonly index: number; readonly message: string };

export type AuthStoreCondition =
  | { readonly kind: "malformed"; readonly scope: "provider"; readonly providerId: string; readonly authDirectory: string; readonly revision: string }
  | { readonly kind: "malformed"; readonly scope: "file"; readonly authDirectory: string; readonly path: string; readonly revision: string }
  | { readonly kind: "refused"; readonly category: "oversized" | "unsafe_path"; readonly scope: "file"; readonly authDirectory: string; readonly path: string };

export interface AuthStoreLoadResult {
  readonly revision: string;
  readonly store: AuthStore;
  readonly credentialLineages: CredentialLineages;
  readonly dropped: readonly string[];
  readonly diagnostics: readonly AuthStoreDiagnostic[];
  readonly conditions: readonly AuthStoreCondition[];
  readonly legacyResetProviders?: readonly string[];
}

function emptyAuthStoreLoadResult(revision = lockedJsonRevision(undefined), conditions: readonly AuthStoreCondition[] = []): AuthStoreLoadResult {
  return { revision, store: {}, credentialLineages: {}, dropped: [], diagnostics: [], conditions };
}

function storeOptions(dir: string, installedIds: readonly string[] | undefined, classifySlot: CredentialSlotClassifier | undefined): LockedJsonStoreOptions<AuthStoreLoadResult> {
  return {
    location: accountSecretFile(dir, AUTH_STORE_FILE),
    empty: emptyAuthStoreLoadResult,
    decode: (value) => decodeAuthStoreWithDiagnostics(value, { installedIds, classifySlot, report: false }),
    encode: (value) => value.store,
    maxBytes: MAX_AUTH_STORE_BYTES,
  };
}

export function loadAuthStoreWithDiagnostics(dir: string, installedIds?: readonly string[], classifySlot?: CredentialSlotClassifier, report = true): AuthStoreLoadResult {
  const result = observeAuthStore(dir, installedIds, classifySlot);
  if (report) reportAuthStoreObservation(result);
  return result;
}

/** Secret-free identity includes refusals, whose byte revision can equal a missing file. */
export function authStoreObservationKey(result: Pick<AuthStoreLoadResult, "revision" | "conditions">): string {
  return JSON.stringify([result.revision, result.conditions]);
}

/** One-shot callers report immediately; runtime owners report only observation transitions. */
export function reportAuthStoreObservation(result: AuthStoreLoadResult): void {
  if (result.conditions.some((condition) => condition.kind === "malformed" && condition.scope === "file")) log.warn("Unparseable auth.json");
  for (const diagnostic of result.diagnostics) {
    if (diagnostic.kind === "unknown_provider") log.warn("credential entry rejected: provider id is not installed", { provider: diagnostic.providerId });
  }
  for (const provider of result.legacyResetProviders ?? []) log.warn("legacy subscription credential reset: reauthentication required", { provider });
}

/** The identity of what `loadAuthStoreWithDiagnostics(dir)` observes: the
 *  byte revision of a file it reads, and the observation key of a file it
 *  refuses, whose byte revision would alias a missing file. It reads the
 *  bytes and decodes nothing: every agent start compares this identity, and
 *  decoding the whole store for it cost each start the store's size. */
export function authStoreObservedRevision(dir: string): string {
  const options = storeOptions(dir, undefined, undefined);
  try {
    return readLockedJsonStoreRevision(options);
  } catch (error) {
    if (!(error instanceof AccountStorageAccessError)) throw error;
    return authStoreObservationKey(refusedAuthStore(dir, options, error));
  }
}

function observeAuthStore(dir: string, installedIds?: readonly string[], classifySlot?: CredentialSlotClassifier): AuthStoreLoadResult {
  const options = storeOptions(dir, installedIds, classifySlot);
  try {
    const state = readLockedJsonStore(options);
    if (state.tag === "valid") return withConditions(state.value, dir, state.revision);
    if (state.tag === "malformed") {
      return emptyAuthStoreLoadResult(state.revision, [fileMalformedCondition(dir, state.revision)]);
    }
    return emptyAuthStoreLoadResult(state.revision);
  } catch (error) {
    if (!(error instanceof AccountStorageAccessError)) throw error;
    return refusedAuthStore(dir, options, error);
  }
}

function refusedAuthStore(dir: string, options: LockedJsonStoreOptions<AuthStoreLoadResult>, error: AccountStorageAccessError): AuthStoreLoadResult {
  return emptyAuthStoreLoadResult(lockedJsonRevision(undefined), [{
    kind: "refused", category: error.category, scope: "file", authDirectory: dir, path: lockedJsonStorePath(options.location),
  }]);
}

function fileMalformedCondition(authDirectory: string, revision: string): AuthStoreCondition {
  return { kind: "malformed", scope: "file", authDirectory, path: lockedJsonStorePath(accountSecretFile(authDirectory, AUTH_STORE_FILE)), revision };
}

function withConditions(result: AuthStoreLoadResult, authDirectory: string, revision: string): AuthStoreLoadResult {
  const affected = new Set([...result.dropped, ...result.diagnostics.flatMap((diagnostic) => diagnostic.kind === "invalid_instance" ? [diagnostic.providerId] : [])]);
  return { ...result, revision, conditions: [...affected].map((providerId) => ({ kind: "malformed", scope: "provider", providerId, authDirectory, revision })) };
}

export function storedApiKeyHint(store: AuthStore, providerId: string): string | undefined {
  const entry = store[providerId];
  if (entry === undefined || isCredentialCollection(entry) || entry.type !== "api_key") return undefined;
  return apiKeyHint(entry.key);
}

export function authStoreRevision(access: AuthProfileAccess): string {
  return lockedJsonRevision(access.readFile(AUTH_STORE_FILE, MAX_AUTH_STORE_BYTES));
}

export function getCredential(providerId: CredentialProviderId, dir: string): Credential | undefined {
  const value = loadAuthStoreWithDiagnostics(dir).store[providerId];
  return isCredentialCollection(value) ? undefined : value;
}

interface MutableCredentialLineages { [providerId: string]: string }
interface DecodedMeteredCredential { readonly credential: Credential; readonly lineageId?: string }

function decodeMeteredCredential(value: unknown, rejectExcessProperties: boolean): DecodedMeteredCredential | undefined {
  const options = rejectExcessProperties ? { onExcessProperty: "error" as const } : undefined;
  const canonical = Schema.decodeUnknownResult(MeteredCredentialRecordSchema, options)(value);
  if (Result.isSuccess(canonical)) return { credential: Schema.decodeUnknownSync(CredentialSchema)(canonical.success), lineageId: canonical.success.lineageId };
  const nested = Schema.decodeUnknownResult(NestedMeteredCredentialRecordSchema, options)(value);
  if (Result.isSuccess(nested)) return nested.success;
  const direct = Schema.decodeUnknownResult(CredentialSchema, options)(value);
  return Result.isSuccess(direct) ? { credential: direct.success } : undefined;
}

export function decodeAuthStoreWithDiagnostics(
  raw: unknown,
  options: { readonly installedIds?: readonly string[]; readonly classifySlot?: CredentialSlotClassifier; readonly rejectExcessProperties?: boolean; readonly report?: boolean } = {},
): AuthStoreLoadResult {
  if (!isRecord(raw)) throw new Error("auth.json must contain an object");
  const { classifySlot, installedIds, rejectExcessProperties = false } = options;
  const installed = installedIds ? new Set(installedIds) : undefined;
  const unknown = installed ? Object.keys(raw).filter((key) => !installed.has(key)) : [];
  const schema = installedIds ? createAuthStoreSchema(installedIds) : PersistedAuthStoreSchema;
  const schemaOptions = rejectExcessProperties ? { onExcessProperty: "error" as const } : undefined;
  const result = Schema.decodeUnknownResult(schema, schemaOptions)(raw);
  const diagnostics: AuthStoreDiagnostic[] = [];
  const legacyResetProviders: string[] = [];
  if (Result.isSuccess(result) && unknown.length === 0 && classifySlot === undefined) {
    const loaded = { revision: lockedJsonRevision(undefined), ...projectPersistedStore(result.success, legacyResetProviders), dropped: [], diagnostics, conditions: [], legacyResetProviders };
    if (options.report !== false) reportAuthStoreObservation(loaded);
    return loaded;
  }
  const store: AuthStore = {};
  const dropped: string[] = [];
  const credentialLineages: MutableCredentialLineages = {};
  for (const [key, value] of Object.entries(raw)) {
    if (installed !== undefined && !installed.has(key)) {
      continue;
    }
    const slot = classifySlot?.(key);
    if (slot !== "metered" && Array.isArray(value)) {
      const instances: CredentialInstance[] = [];
      const ids = new Set<string>();
      const identities = new Set<string>();
      for (const [index, candidate] of value.entries()) {
        const decoded = Schema.decodeUnknownResult(CredentialInstanceSchema, schemaOptions)(candidate);
        if (Result.isFailure(decoded) || ids.has(decoded.success.id) || identities.has(decoded.success.identity)) {
          diagnostics.push({ kind: "invalid_instance", providerId: key, index, message: `Credential instance ${index} for provider "${key}" is invalid.` });
          continue;
        }
        ids.add(decoded.success.id);
        identities.add(decoded.success.identity);
        instances.push(decoded.success);
      }
      store[key] = instances.sort((left, right) => left.id.localeCompare(right.id));
      continue;
    }
    if (slot !== "subscription") {
      const entry = decodeMeteredCredential(value, rejectExcessProperties);
      if (entry !== undefined) {
        store[key] = entry.credential;
        if (entry.lineageId !== undefined) credentialLineages[key] = entry.lineageId;
        continue;
      }
    }
    dropped.push(key);
  }
  diagnostics.push(...unknown.map((providerId) => ({ kind: "unknown_provider" as const, providerId, message: `Credential provider "${providerId}" is not installed. Remove its entry from auth.json.` })));
  const loaded = { revision: lockedJsonRevision(undefined), store: withoutLegacyInstances(store, legacyResetProviders), credentialLineages, dropped, diagnostics, conditions: [], legacyResetProviders };
  if (options.report !== false) reportAuthStoreObservation(loaded);
  return loaded;
}

function projectPersistedStore(store: PersistedAuthStore, legacyResetProviders: string[]): Pick<AuthStoreLoadResult, "store" | "credentialLineages"> {
  const projected: AuthStore = {};
  const credentialLineages: MutableCredentialLineages = {};
  for (const [providerId, value] of Object.entries(store)) {
    if (isCredentialCollection(value)) projected[providerId] = value;
    else {
      projected[providerId] = Schema.decodeUnknownSync(CredentialSchema)(value);
      credentialLineages[providerId] = value.lineageId;
    }
  }
  return { store: withoutLegacyInstances(projected, legacyResetProviders), credentialLineages };
}

function withoutLegacyInstances(store: { readonly [providerId: string]: Credential | CredentialCollection }, legacyResetProviders: string[]): AuthStore {
  const next: AuthStore = {};
  for (const [providerId, value] of Object.entries(store)) {
    if (!isCredentialCollection(value)) next[providerId] = value;
    else {
      const remaining = value.filter((instance) => instance.id !== "legacy");
      if (remaining.length !== value.length) legacyResetProviders.push(providerId);
      next[providerId] = remaining;
    }
  }
  return next;
}
