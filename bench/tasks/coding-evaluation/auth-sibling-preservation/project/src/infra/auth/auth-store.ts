import { Result, Schema } from "effect";
import { Log } from "../log.js";
import { accountSecretFile } from "../paths.js";
import { isRecord } from "../record.js";
import type { AuthProfileAccess } from "./auth-profile-store.js";
import { AccountStorageAccessError, lockedJsonRevision, lockedJsonStorePath, readLockedJsonStore, type LockedJsonStoreOptions } from "./locked-json-store.js";
import { PersistedAuthStoreSchema, createAuthStoreSchema, CredentialInstanceSchema, CredentialSchema, isCredentialCollection, MeteredCredentialRecordSchema, NestedMeteredCredentialRecordSchema, type AuthStore, type Credential, type CredentialCollection, type CredentialInstance, type CredentialLineages, type CredentialProviderId, type CredentialSlotClassifier, type PersistedAuthStore } from "./auth-store-types.js";

const log = Log.create({ service: "auth-store" });
const AUTH_STORE_FILE = "auth.json";
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
}

function emptyAuthStoreLoadResult(revision = lockedJsonRevision(undefined), conditions: readonly AuthStoreCondition[] = []): AuthStoreLoadResult {
  return { revision, store: {}, credentialLineages: {}, dropped: [], diagnostics: [], conditions };
}

function storeOptions(dir: string, installedIds: readonly string[] | undefined, classifySlot: CredentialSlotClassifier | undefined): LockedJsonStoreOptions<AuthStoreLoadResult> {
  return {
    location: accountSecretFile(dir, AUTH_STORE_FILE),
    empty: emptyAuthStoreLoadResult,
    decode: (value) => decodeAuthStoreWithDiagnostics(value, { installedIds, classifySlot }),
    encode: (value) => value.store,
    maxBytes: MAX_AUTH_STORE_BYTES,
  };
}

export function loadAuthStoreWithDiagnostics(dir: string, installedIds?: readonly string[], classifySlot?: CredentialSlotClassifier): AuthStoreLoadResult {
  const options = storeOptions(dir, installedIds, classifySlot);
  try {
    const state = readLockedJsonStore(options);
    if (state.tag === "valid") return withConditions(state.value, dir, state.revision);
    if (state.tag === "malformed") {
      log.warn("Unparseable auth.json");
      return emptyAuthStoreLoadResult(state.revision, [fileMalformedCondition(dir, state.revision)]);
    }
    return emptyAuthStoreLoadResult(state.revision);
  } catch (error) {
    if (!(error instanceof AccountStorageAccessError)) throw error;
    return emptyAuthStoreLoadResult(lockedJsonRevision(undefined), [{
      kind: "refused", category: error.category, scope: "file", authDirectory: dir, path: lockedJsonStorePath(options.location),
    }]);
  }
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
  if (entry.key.startsWith("!")) return "!command";
  return `••••${entry.key.slice(-4)}`;
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
  options: { readonly installedIds?: readonly string[]; readonly classifySlot?: CredentialSlotClassifier; readonly rejectExcessProperties?: boolean } = {},
): AuthStoreLoadResult {
  if (!isRecord(raw)) throw new Error("auth.json must contain an object");
  const { classifySlot, installedIds, rejectExcessProperties = false } = options;
  const installed = installedIds ? new Set(installedIds) : undefined;
  const unknown = installed ? Object.keys(raw).filter((key) => !installed.has(key)) : [];
  const schema = installedIds ? createAuthStoreSchema(installedIds) : PersistedAuthStoreSchema;
  const schemaOptions = rejectExcessProperties ? { onExcessProperty: "error" as const } : undefined;
  const result = Schema.decodeUnknownResult(schema, schemaOptions)(raw);
  if (Result.isSuccess(result) && unknown.length === 0 && classifySlot === undefined) return { revision: lockedJsonRevision(undefined), ...projectPersistedStore(result.success), dropped: [], diagnostics: [], conditions: [] };
  const store: AuthStore = {};
  const dropped: string[] = [];
  const credentialLineages: MutableCredentialLineages = {};
  const diagnostics: AuthStoreDiagnostic[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (installed !== undefined && !installed.has(key)) {
      log.warn("credential entry rejected: provider id is not installed", { provider: key });
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
  return { revision: lockedJsonRevision(undefined), store: withoutLegacyInstances(store), credentialLineages, dropped, diagnostics, conditions: [] };
}

function projectPersistedStore(store: PersistedAuthStore): Pick<AuthStoreLoadResult, "store" | "credentialLineages"> {
  const projected: AuthStore = {};
  const credentialLineages: MutableCredentialLineages = {};
  for (const [providerId, value] of Object.entries(store)) {
    if (isCredentialCollection(value)) projected[providerId] = value;
    else {
      projected[providerId] = Schema.decodeUnknownSync(CredentialSchema)(value);
      credentialLineages[providerId] = value.lineageId;
    }
  }
  return { store: withoutLegacyInstances(projected), credentialLineages };
}

function withoutLegacyInstances(store: { readonly [providerId: string]: Credential | CredentialCollection }): AuthStore {
  const next: AuthStore = {};
  for (const [providerId, value] of Object.entries(store)) {
    if (!isCredentialCollection(value)) next[providerId] = value;
    else {
      const remaining = value.filter((instance) => instance.id !== "legacy");
      if (remaining.length !== value.length) log.warn("legacy subscription credential reset: reauthentication required", { provider: providerId });
      next[providerId] = remaining;
    }
  }
  return next;
}
