import { Result, Schema } from "effect";
import { isDeepStrictEqual } from "node:util";
import { ContainedPathError } from "../descriptor-directory.js";
import { accountSecretFile } from "../paths.js";
import { isRecord } from "../record.js";
import { type AuthProfileAccess, openExistingAuthProfileDirectory } from "./auth-profile-store.js";
import { credentialsEqual } from "./credential-comparison.js";
import { lockedJsonRevision, lockedJsonStorePath } from "./locked-json-store.js";
import { isCredentialCollection, PersistedAuthStoreSchema, type AuthStore, type Credential, type CredentialCollection, type CredentialInstance, type CredentialLineages, type CredentialProviderId, type CredentialSlotClassifier, type PersistedAuthStore } from "./auth-store-types.js";
import { AUTH_STORE_FILE, decodeAuthStoreWithDiagnostics, loadAuthStoreWithDiagnostics, type AuthStoreCondition, type AuthStoreLoadResult } from "./auth-store.js";

const MAX_AUTH_STORE_BYTES = 16 * 1024 * 1024;

/** A strict credential mutation preserves rejected bytes and exposes only safe evidence. */
export class AuthStoreMutationError extends Error {
  readonly _tag = "AuthStoreMutationError" as const;
  constructor(readonly conditions: readonly AuthStoreCondition[]) { super("Cannot update auth.json until its storage condition is repaired."); }
}

function emptyAuthStoreLoadResult(revision = lockedJsonRevision(undefined), conditions: readonly AuthStoreCondition[] = []): AuthStoreLoadResult { return { revision, store: {}, credentialLineages: {}, dropped: [], diagnostics: [], conditions }; }

function fileMalformedCondition(authDirectory: string, revision: string): AuthStoreCondition {
  return { kind: "malformed", scope: "file", authDirectory, path: lockedJsonStorePath(accountSecretFile(authDirectory, AUTH_STORE_FILE)), revision };
}

function readAuthStoreBytesForMutation(access: AuthProfileAccess): Buffer | undefined {
  try {
    return access.readFile(AUTH_STORE_FILE, MAX_AUTH_STORE_BYTES);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("-byte read limit")) throw error;
    throw new AuthStoreMutationError([{
      kind: "refused",
      category: "oversized",
      scope: "file",
      authDirectory: access.authDirectory,
      path: lockedJsonStorePath(accountSecretFile(access.authDirectory, AUTH_STORE_FILE)),
    }]);
  }
}

function openMutationAccess(destination: string | AuthProfileAccess): AuthProfileAccess {
  if (typeof destination !== "string") return destination;
  try {
    return openExistingAuthProfileDirectory(destination);
  } catch (error) {
    if (!(error instanceof ContainedPathError)) throw error;
    throw new AuthStoreMutationError([{
      kind: "refused",
      category: "unsafe_path",
      scope: "file",
      authDirectory: destination,
      path: lockedJsonStorePath(accountSecretFile(destination, AUTH_STORE_FILE)),
    }]);
  }
}

function withConditions(result: AuthStoreLoadResult, authDirectory: string, revision: string): AuthStoreLoadResult {
  const affected = new Set([
    ...result.dropped,
    ...result.diagnostics.flatMap((diagnostic) => diagnostic.kind === "invalid_instance" ? [diagnostic.providerId] : []),
  ]);
  return {
    ...result,
    revision,
    conditions: [...affected].map((providerId) => ({ kind: "malformed", scope: "provider", providerId, authDirectory, revision })),
  };
}

function loadAuthStoreFromAccess(access: AuthProfileAccess, classifySlot: CredentialSlotClassifier | undefined, installedIds?: readonly string[]): AuthStoreLoadResult {
  const { authDirectory } = access;
  const bytes = readAuthStoreBytesForMutation(access);
  if (bytes === undefined) return emptyAuthStoreLoadResult();
  const revision = lockedJsonRevision(bytes);
  let result: AuthStoreLoadResult;
  try {
    result = decodeAuthStoreWithDiagnostics(JSON.parse(bytes.toString("utf8")), {
      classifySlot,
      installedIds,
      report: installedIds === undefined,
      rejectExcessProperties: true,
    });
  } catch {
    throw new AuthStoreMutationError([fileMalformedCondition(authDirectory, revision)]);
  }
  if (result.dropped.length > 0 || result.diagnostics.some((diagnostic) => diagnostic.kind === "invalid_instance")) {
    throw new AuthStoreMutationError(withConditions(result, authDirectory, revision).conditions);
  }
  if (result.diagnostics.some((diagnostic) => diagnostic.kind === "unknown_provider")) throw new AuthStoreMutationError([]);
  return result;
}

async function mutateAuthStoreAccess(
  access: AuthProfileAccess,
  mutate: (store: AuthStore) => readonly CredentialProviderId[] | void,
  classifySlot?: CredentialSlotClassifier,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await access.withLock(() => {
    const { store, lineages } = loadMutableAuthStoreFromAccess(access, classifySlot);
    signal?.throwIfAborted();
    const changedProviders = mutate(store);
    const renewals = changedProviders === undefined ? new Set<CredentialProviderId>() : new Set(changedProviders);
    writeAuthStoreAccess(access, store, lineages, renewals);
  });
}

function writeAuthStoreAccess(
  access: AuthProfileAccess,
  store: AuthStore,
  lineages: CredentialLineages,
  renewals: ReadonlySet<CredentialProviderId>,
): void {
  const ordered = Object.fromEntries(Object.entries(store).map(([providerId, value]) => [
    providerId,
    isCredentialCollection(value)
      ? [...value].sort((left, right) => left.id.localeCompare(right.id))
      : { ...value, lineageId: renewals.has(providerId) ? crypto.randomUUID() : lineages[providerId] ?? crypto.randomUUID() },
  ]));
  const encoded = JSON.stringify(ordered);
  if (Buffer.byteLength(encoded) > MAX_AUTH_STORE_BYTES) throw new RangeError(`auth.json exceeds ${MAX_AUTH_STORE_BYTES} bytes`);
  access.writeFile(AUTH_STORE_FILE, encoded);
}

function mintCredentialInstanceLineage(instance: CredentialInstance): CredentialInstance {
  return { ...instance, lineageId: crypto.randomUUID() };
}

function ensureInstanceLineage(instance: CredentialInstance): CredentialInstance {
  return instance.lineageId === undefined ? mintCredentialInstanceLineage(instance) : instance;
}

function persistedLoginReplacement(
  replacement: Credential | CredentialCollection,
  slot: "subscription" | "metered",
): PersistedAuthEntry {
  return slot === "subscription" && isCredentialCollection(replacement)
    ? replacement.map(mintCredentialInstanceLineage)
    : { ...replacement, lineageId: crypto.randomUUID() };
}

type PersistedAuthEntry = PersistedAuthStore[string];
const STRICT_SCHEMA_OPTIONS = { onExcessProperty: "error" as const };

function decodePersistedAuthEntry(providerId: CredentialProviderId, value: unknown): PersistedAuthEntry | undefined {
  const decoded = Schema.decodeUnknownResult(PersistedAuthStoreSchema, STRICT_SCHEMA_OPTIONS)({ [providerId]: value });
  return Result.isSuccess(decoded) ? decoded.success[providerId] : undefined;
}

function persistedAuthEntriesEqual(providerId: CredentialProviderId, left: unknown, right: unknown): boolean {
  const decodedLeft = decodePersistedAuthEntry(providerId, left);
  const decodedRight = decodePersistedAuthEntry(providerId, right);
  return decodedLeft !== undefined && decodedRight !== undefined && isDeepStrictEqual(decodedLeft, decodedRight);
}

/** Exact auth-entry state around one login write. The entry is intentionally
 * opaque to callers because it contains credential bytes. */
export interface AuthStoreMutationReceipt { readonly providerId: CredentialProviderId; readonly before: unknown; readonly after: unknown }

function persistedEntry(store: AuthStore, lineages: CredentialLineages, providerId: CredentialProviderId): PersistedAuthEntry | undefined {
  const value = store[providerId];
  if (value === undefined) return undefined;
  if (isCredentialCollection(value)) return structuredClone(value);
  const lineageId = lineages[providerId];
  if (lineageId === undefined) throw new Error(`Credential lineage is unavailable for ${providerId}`);
  return { ...structuredClone(value), lineageId };
}

async function mutateWithReceipt(
  access: AuthProfileAccess,
  providerId: CredentialProviderId,
  classifySlot: CredentialSlotClassifier,
  renewLineage: boolean,
  mutate: (store: AuthStore) => boolean,
  signal?: AbortSignal,
): Promise<AuthStoreMutationReceipt | undefined> {
  signal?.throwIfAborted();
  return access.withLock(() => {
    const { store, lineages } = loadMutableAuthStoreFromAccess(access, classifySlot);
    const before = persistedEntry(store, lineages, providerId);
    signal?.throwIfAborted();
    if (!mutate(store)) return undefined;
    writeAuthStoreAccess(access, store, lineages, renewLineage ? new Set([providerId]) : new Set());
    const loaded = loadMutableAuthStoreFromAccess(access, classifySlot);
    return { providerId, before, after: persistedEntry(loaded.store, loaded.lineages, providerId) };
  });
}

/** Restores the complete pre-login entry only if the complete written entry,
 * including its metered lineage or subscription identity and label, is current. */
export async function rollbackAuthStoreMutation(
  receipt: AuthStoreMutationReceipt,
  destination: string | AuthProfileAccess,
  _classifySlot: CredentialSlotClassifier,
): Promise<boolean> {
  const access = openMutationAccess(destination);
  try {
    return await access.withLock(() => {
      const bytes = readAuthStoreBytesForMutation(access);
      const raw: unknown = bytes === undefined ? {} : JSON.parse(bytes.toString("utf8"));
      if (!isRecord(raw) || !persistedAuthEntriesEqual(receipt.providerId, raw[receipt.providerId], receipt.after)) return false;
      const restored = { ...raw };
      if (receipt.before === undefined) Reflect.deleteProperty(restored, receipt.providerId);
      else restored[receipt.providerId] = receipt.before;
      access.writeFile(AUTH_STORE_FILE, JSON.stringify(restored));
      return true;
    });
  } finally {
    if (typeof destination === "string") access.close();
  }
}

export async function setMeteredCredentialWithReceipt(
  providerId: CredentialProviderId,
  credential: Credential,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
): Promise<AuthStoreMutationReceipt> {
  if (classifySlot(providerId) !== "metered") throw new Error(`Credential provider ${providerId} is not a metered slot`);
  const access = openMutationAccess(destination);
  try {
    const receipt = await mutateWithReceipt(access, providerId, classifySlot, true, (store) => {
      store[providerId] = credential;
      return true;
    });
    if (receipt === undefined) throw new Error(`Credential mutation did not write ${providerId}`);
    return receipt;
  } finally {
    if (typeof destination === "string") access.close();
  }
}

/** The accounts of a provider that a caller reviewed before it adds one, by instance id and identity, and the
 *  reviewed accounts that the addition replaces. */
export interface CredentialCollectionReview { readonly reviewed: readonly { readonly id: string; readonly identity: string }[]; readonly replaces: readonly string[] }

/** The accounts of a provider are no longer the ones that the caller reviewed, so its decision no longer holds. */
export class CredentialCollectionChangedError extends Error { readonly _tag = "CredentialCollectionChangedError" as const }

/** Appends one account. With `review`, the append and the removal of the accounts it replaces are one write under the
 *  store's lock, and it throws `CredentialCollectionChangedError` without a write when the provider's accounts are no
 *  longer exactly the reviewed ones. */
export async function appendCredentialInstanceWithReceipt(
  providerId: CredentialProviderId,
  instance: CredentialInstance,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
  signal?: AbortSignal,
  review?: CredentialCollectionReview,
): Promise<AuthStoreMutationReceipt> {
  requireSubscription(providerId, classifySlot);
  const access = openMutationAccess(destination);
  try {
    const receipt = await mutateWithReceipt(access, providerId, classifySlot, false, (store) => {
      const current = collection(store, providerId);
      const reviewed = review === undefined || (current.length === review.reviewed.length && current.every(({ id, identity }) => review.reviewed.some((account) => account.id === id && account.identity === identity)));
      if (!reviewed) throw new CredentialCollectionChangedError(`The accounts of ${providerId} changed after they were reviewed`);
      if (current.some((item) => item.id === instance.id || item.identity === instance.identity)) throw new Error(`Credential instance already exists for ${providerId}`);
      store[providerId] = [...current.filter(({ id }) => review?.replaces.includes(id) !== true), mintCredentialInstanceLineage(instance)];
      return true;
    }, signal);
    if (receipt === undefined) throw new Error(`Credential mutation did not write ${providerId}`);
    return receipt;
  } finally {
    if (typeof destination === "string") access.close();
  }
}

export async function replaceCredentialInstanceWithReceipt(
  providerId: CredentialProviderId,
  instanceId: string,
  expected: Credential,
  credential: Credential,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
  signal?: AbortSignal,
  identity?: string,
): Promise<AuthStoreMutationReceipt | undefined> {
  requireSubscription(providerId, classifySlot);
  const access = openMutationAccess(destination);
  try {
    return await mutateWithReceipt(access, providerId, classifySlot, false, (store) => {
      const current = collection(store, providerId);
      const index = current.findIndex((instance) => instance.id === instanceId && credentialsEqual(instance.credential, expected));
      if (index < 0) return false;
      if (identity !== undefined && current.some((instance, currentIndex) => currentIndex !== index && instance.identity === identity)) throw new Error(`Credential identity already exists for ${providerId}`);
      store[providerId] = current.map((instance, currentIndex) => currentIndex === index
        ? mintCredentialInstanceLineage({ ...instance, ...(identity === undefined ? {} : { identity }), credential })
        : instance);
      return true;
    }, signal);
  } finally {
    if (typeof destination === "string") access.close();
  }
}

/** Adds stable opaque generations to legacy credentials before identity-scoped state is used. */
export async function ensureCredentialLineages(
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
  installedIds?: readonly string[],
): Promise<void> {
  const access = openMutationAccess(destination);
  try {
    await access.withLock(() => {
      const { store, credentialLineages: lineages } = loadAuthStoreFromAccess(access, classifySlot, installedIds);
      let changed = false;
      for (const [providerId, value] of Object.entries(store)) {
        if (classifySlot(providerId) !== "subscription" || !isCredentialCollection(value)) continue;
        const next = value.map(ensureInstanceLineage);
        if (next.some((instance, index) => instance !== value[index])) changed = true;
        store[providerId] = next;
      }
      const missingMetered = Object.entries(store)
        .filter(([providerId, value]) => !isCredentialCollection(value) && classifySlot(providerId) === "metered" && lineages[providerId] === undefined)
        .map(([providerId]) => providerId);
      if (!changed && missingMetered.length === 0) return;
      writeAuthStoreAccess(access, store, lineages, new Set(missingMetered));
    });
  } finally {
    if (typeof destination === "string") access.close();
  }
}

interface MutableAuthStore { readonly store: AuthStore; readonly lineages: CredentialLineages }

function loadMutableAuthStoreFromAccess(access: AuthProfileAccess, classifySlot?: CredentialSlotClassifier): MutableAuthStore {
  const { store, credentialLineages } = loadAuthStoreFromAccess(access, classifySlot);
  return { store, lineages: credentialLineages };
}

export async function setCredential(providerId: CredentialProviderId, credential: Credential, destination: string | AuthProfileAccess): Promise<void> {
  const access = openMutationAccess(destination);
  try {
    await mutateAuthStoreAccess(access, (store) => { store[providerId] = credential; return [providerId]; });
  } finally {
    if (typeof destination === "string") access.close();
  }
}

/** Replaces one credential only if the store still contains the version the
 *  caller refreshed. A concurrent login wins instead of being overwritten by
 *  a slower refresh from the previous account. */
export async function replaceCredential(
  providerId: CredentialProviderId,
  expected: Credential,
  credential: Credential,
  destination: string | AuthProfileAccess,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  let replaced = false;
  const access = openMutationAccess(destination);
  try {
    await mutateAuthStoreAccess(access, (store) => {
      const current = store[providerId];
      if (isCredentialCollection(current) || !credentialsEqual(current, expected)) return;
      store[providerId] = credential;
      replaced = true;
      return [providerId];
    }, undefined, signal);
    return replaced;
  } finally {
    if (typeof destination === "string") access.close();
  }
}

/** Restores or removes one metered credential only while the failed login's
 * exact credential is still current. A concurrent auth mutation always wins. */
export async function rollbackMeteredCredential(
  providerId: CredentialProviderId,
  failed: Credential,
  previous: Credential | undefined,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
): Promise<boolean> {
  if (classifySlot(providerId) !== "metered") throw new Error(`Credential provider ${providerId} is not a metered slot`);
  let rolledBack = false;
  const access = openMutationAccess(destination);
  try {
    await mutateAuthStoreAccess(access, (store) => {
      const current = store[providerId];
      if (isCredentialCollection(current) || !credentialsEqual(current, failed)) return;
      if (previous === undefined) Reflect.deleteProperty(store, providerId);
      else store[providerId] = previous;
      rolledBack = true;
      return previous === undefined ? undefined : [providerId];
    }, classifySlot);
    return rolledBack;
  } finally {
    if (typeof destination === "string") access.close();
  }
}

export async function deleteCredential(providerId: CredentialProviderId, destination: string | AuthProfileAccess): Promise<void> {
  const access = openMutationAccess(destination);
  try {
    if (readAuthStoreBytesForMutation(access) === undefined) return;
    await mutateAuthStoreAccess(access, (store) => { Reflect.deleteProperty(store, providerId); });
  } finally {
    if (typeof destination === "string") access.close();
  }
}

export async function setMeteredCredential(
  providerId: CredentialProviderId,
  credential: Credential,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
): Promise<void> {
  if (classifySlot(providerId) !== "metered") throw new Error(`Credential provider ${providerId} is not a metered slot`);
  const access = openMutationAccess(destination);
  try {
    await mutateAuthStoreAccess(access, (store) => { store[providerId] = credential; return [providerId]; }, classifySlot);
  } finally {
    if (typeof destination === "string") access.close();
  }
}

export async function deleteProviderCredentials(
  providerId: CredentialProviderId,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
): Promise<void> {
  const access = openMutationAccess(destination);
  try {
    if (readAuthStoreBytesForMutation(access) === undefined) return;
    await mutateAuthStoreAccess(access, (store) => { Reflect.deleteProperty(store, providerId); }, classifySlot);
  } finally {
    if (typeof destination === "string") access.close();
  }
}


function requireSubscription(providerId: CredentialProviderId, classifySlot: CredentialSlotClassifier): void {
  if (classifySlot(providerId) !== "subscription") throw new Error(`Credential provider ${providerId} is not a subscription slot`);
}

function collection(store: AuthStore, providerId: CredentialProviderId): CredentialCollection {
  const value = store[providerId];
  if (value === undefined) return [];
  if (isCredentialCollection(value)) return value;
  throw new Error(`Credential provider ${providerId} is not a collection`);
}


export async function appendCredentialInstance(
  providerId: CredentialProviderId,
  instance: CredentialInstance,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await appendCredentialInstanceWithReceipt(providerId, instance, destination, classifySlot, signal);
}

/** Replaces a wholly rejected provider entry, never a damaged account collection. */
export async function replaceRejectedProviderCredentials(
  providerId: CredentialProviderId,
  replacement: Credential | CredentialCollection,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const access = openMutationAccess(destination);
  try {
    return await access.withLock(() => {
      const bytes = readAuthStoreBytesForMutation(access);
      if (bytes === undefined) return false;
      const revision = lockedJsonRevision(bytes);
      let raw: unknown;
      try {
        raw = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new AuthStoreMutationError([fileMalformedCondition(access.authDirectory, revision)]);
      }
      if (!isRecord(raw)) throw new AuthStoreMutationError([fileMalformedCondition(access.authDirectory, revision)]);
      const decoded = decodeAuthStoreWithDiagnostics(raw, { classifySlot, rejectExcessProperties: true });
      if (!decoded.dropped.includes(providerId)) return false;
      const encoded = JSON.stringify({ ...raw, [providerId]: persistedLoginReplacement(replacement, classifySlot(providerId)) });
      if (Buffer.byteLength(encoded) > MAX_AUTH_STORE_BYTES) throw new RangeError(`auth.json exceeds ${MAX_AUTH_STORE_BYTES} bytes`);
      signal?.throwIfAborted();
      access.writeFile(AUTH_STORE_FILE, encoded);
      return true;
    });
  } finally {
    if (typeof destination === "string") access.close();
  }
}

/** Replaces a wholly rejected provider entry, never a damaged account collection.
 * The receipt retains the original entry for failed catalog settlement. */
export async function replaceRejectedProviderCredentialsWithReceipt(
  providerId: CredentialProviderId,
  replacement: Credential | CredentialCollection,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
  signal?: AbortSignal,
): Promise<AuthStoreMutationReceipt | undefined> {
  signal?.throwIfAborted();
  const access = openMutationAccess(destination);
  try {
    return await access.withLock(() => {
      const bytes = readAuthStoreBytesForMutation(access);
      if (bytes === undefined) return undefined;
      const revision = lockedJsonRevision(bytes);
      let raw: unknown;
      try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new AuthStoreMutationError([fileMalformedCondition(access.authDirectory, revision)]); }
      if (!isRecord(raw)) throw new AuthStoreMutationError([fileMalformedCondition(access.authDirectory, revision)]);
      const decoded = decodeAuthStoreWithDiagnostics(raw, { classifySlot, rejectExcessProperties: true });
      if (!decoded.dropped.includes(providerId)) return undefined;
      const before = raw[providerId];
      const after = persistedLoginReplacement(replacement, classifySlot(providerId));
      const encoded = JSON.stringify({ ...raw, [providerId]: after });
      if (Buffer.byteLength(encoded) > MAX_AUTH_STORE_BYTES) throw new RangeError(`auth.json exceeds ${MAX_AUTH_STORE_BYTES} bytes`);
      signal?.throwIfAborted();
      access.writeFile(AUTH_STORE_FILE, encoded);
      return { providerId, before, after };
    });
  } finally {
    if (typeof destination === "string") access.close();
  }
}

export async function replaceCredentialInstance(
  providerId: CredentialProviderId,
  instanceId: string,
  expected: Credential,
  credential: Credential,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
  signal?: AbortSignal,
  identity?: string,
): Promise<boolean> {
  requireSubscription(providerId, classifySlot);
  signal?.throwIfAborted();
  let replaced = false;
  const access = openMutationAccess(destination);
  try {
    await mutateAuthStoreAccess(access, (store) => {
      const current = collection(store, providerId);
      const index = current.findIndex((instance) => instance.id === instanceId && credentialsEqual(instance.credential, expected));
      if (index < 0) return;
      if (identity !== undefined && current.some((instance, currentIndex) => currentIndex !== index && instance.identity === identity)) {
        throw new Error(`Credential identity already exists for ${providerId}`);
      }
      store[providerId] = current.map((instance, currentIndex) => currentIndex === index ? { ...instance, ...(identity === undefined ? {} : { identity }), credential } : instance);
      replaced = true;
    }, classifySlot, signal);
    return replaced;
  } finally {
    if (typeof destination === "string") access.close();
  }
}

/** Removes one newly appended instance only while its exact credential is
 * unchanged. This cannot delete or overwrite a concurrent reconnect. */
export async function rollbackAppendedCredentialInstance(
  providerId: CredentialProviderId,
  instanceId: string,
  credential: Credential,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
): Promise<boolean> {
  requireSubscription(providerId, classifySlot);
  let rolledBack = false;
  const access = openMutationAccess(destination);
  try {
    await mutateAuthStoreAccess(access, (store) => {
      const current = collection(store, providerId);
      const index = current.findIndex((instance) => instance.id === instanceId && credentialsEqual(instance.credential, credential));
      if (index < 0) return;
      store[providerId] = current.filter((_, currentIndex) => currentIndex !== index);
      rolledBack = true;
    }, classifySlot);
    return rolledBack;
  } finally {
    if (typeof destination === "string") access.close();
  }
}

export function credentialInstanceMatches(
  providerId: CredentialProviderId,
  instanceId: string,
  expected: Credential,
  source: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
): boolean {
  requireSubscription(providerId, classifySlot);
  const store = typeof source === "string"
    ? loadAuthStoreWithDiagnostics(source, undefined, classifySlot).store
    : loadAuthStoreFromAccess(source, classifySlot).store;
  return collection(store, providerId).some((instance) => instance.id === instanceId && credentialsEqual(instance.credential, expected));
}

export async function withSoleCredentialInstanceMatch(
  providerId: CredentialProviderId,
  instanceId: string,
  expected: Credential,
  source: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
  use: (access: AuthProfileAccess) => void,
): Promise<boolean> {
  requireSubscription(providerId, classifySlot);
  const access = typeof source === "string" ? openExistingAuthProfileDirectory(source) : source;
  try {
    return await access.withLock(() => {
      const store = loadAuthStoreFromAccess(access, classifySlot).store;
      const accounts = collection(store, providerId);
      const matches = accounts.length === 1 && accounts[0]?.id === instanceId && credentialsEqual(accounts[0].credential, expected);
      if (!matches) return false;
      use(access);
      return true;
    });
  } finally {
    if (typeof source === "string") access.close();
  }
}

export async function renameCredentialInstance(
  providerId: CredentialProviderId,
  instanceId: string,
  label: string | undefined,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
): Promise<void> {
  requireSubscription(providerId, classifySlot);
  const access = openMutationAccess(destination);
  try {
    await mutateAuthStoreAccess(access, (store) => {
      store[providerId] = collection(store, providerId).map((instance) =>
        instance.id === instanceId
          ? label === undefined ? (({ label: _label, ...rest }) => rest)(instance) : { ...instance, label }
          : instance);
    }, classifySlot);
  } finally {
    if (typeof destination === "string") access.close();
  }
}

export async function deleteCredentialInstance(
  providerId: CredentialProviderId,
  instanceId: string,
  destination: string | AuthProfileAccess,
  classifySlot: CredentialSlotClassifier,
): Promise<void> {
  requireSubscription(providerId, classifySlot);
  const access = openMutationAccess(destination);
  try {
    await mutateAuthStoreAccess(access, (store) => {
      const current = collection(store, providerId);
      const remaining = current.filter((instance) => instance.id !== instanceId);
      if (remaining.length === current.length) return;
      store[providerId] = remaining;
    }, classifySlot);
  } finally {
    if (typeof destination === "string") access.close();
  }
}
