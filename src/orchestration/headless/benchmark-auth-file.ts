import { Redacted, Schema } from "effect"
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, type Stats, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute } from "node:path"
import { windowsDirectoryIsOwnerOnly } from "../../infra/windows-private-directory-acl.js"
import { CredentialSchema, PersistentCredentialInstanceSchema, isCredentialCollection, type AuthStore, type Credential, type CredentialSlotClassifier, type OAuthCredential } from "../../infra/auth/auth-store-types.js"
import { decodeAuthStoreWithDiagnostics } from "../../infra/auth/auth-store.js"
import { replaceCredentialInstance } from "../../infra/auth/auth-store-mutations.js"
import type { AuthProfileAccess } from "../../infra/auth/auth-profile-store.js"
import { captureProviderConnection, captureSubscriptionCredentials, oauthCredentialDto, resolveAuthContextFromStore, runtimeCredential, type ProviderConnection } from "../../infra/auth/auth-context.js"
import type { KeyResolver } from "../../infra/auth/resolve-key.js"
import { requireAuthProfileName } from "../../infra/paths.js"
import { accessProviderAccountKey, credentialIdOf, type AccessProviderAccountIdentity, type AccessProviderDefinition } from "../../infra/llm/access-provider.js"
import { readSavedProviderModels, type ProviderModelAccessSnapshot } from "../../infra/auth/provider-model-catalog-store.js"
import { Log } from "../../infra/log.js"
import { AuthProfileManager } from "../auth/auth-profile-manager.js"
import { installedCredentialProviderIds } from "../credential-provider-modules.js"

const MAX_BYTES = 64 * 1024
const STAGE_PREFIX = "flywheel-auth-bundle-"
const log = Log.create({ service: "headless-auth-snapshot" })

function unlinkIfSameFile(path: string, opened: { readonly dev: number; readonly ino: number }): void {
  try {
    const current = lstatSync(path)
    if (current.dev === opened.dev && current.ino === opened.ino) unlinkSync(path)
  } catch {
    // The path disappeared or no longer names the opened snapshot. Never unlink a replacement.
  }
}

function requireSnapshotStage(path: string): void {
  if (!isAbsolute(path)) throw new Error("Headless auth snapshot path must be absolute")
  const stage = dirname(path)
  const metadata = lstatSync(stage)
  if (basename(path) !== "auth.json" || !basename(stage).startsWith(STAGE_PREFIX)
    || !metadata.isDirectory() || !stageAdmitsOwnerOnly(stage, metadata)) {
    throw new Error("Headless auth snapshot must be inside a private, owner-controlled dedicated stage")
  }
}

/** Whether the stage admits nobody but this account.
 *
 *  POSIX proves that with the mode bits and the owning uid. Windows publishes
 *  neither - it reports no uid at all and a fixed mode - so the owner-only ACL
 *  is the same property stated in the terms that platform keeps. */
function stageAdmitsOwnerOnly(stage: string, metadata: Stats): boolean {
  if (process.platform === "win32") return windowsDirectoryIsOwnerOnly(stage)
  const owner = process.getuid?.()
  return (metadata.mode & 0o077) === 0 && owner !== undefined && metadata.uid === owner
}

const AccessCredentialInstanceSchema = PersistentCredentialInstanceSchema
const AccessCredentialStoreSchema = Schema.Record(Schema.String, Schema.Union([CredentialSchema, Schema.Array(AccessCredentialInstanceSchema)]))
const ModelAccessSchema = Schema.Array(Schema.Struct({
  account: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("singleton"), providerId: Schema.NonEmptyString }),
    Schema.Struct({ kind: Schema.Literal("subscription"), providerId: Schema.NonEmptyString, instanceId: Schema.NonEmptyString }),
  ]),
  lineage: Schema.NonEmptyString,
  outcomes: Schema.Record(Schema.NonEmptyString, Schema.Literals(["completed", "refused"])),
}))
type AccessCredentialInstance = typeof AccessCredentialInstanceSchema.Type
type AccessCredentialStore = typeof AccessCredentialStoreSchema.Type

/** Raw credential transport for another process in the same trust domain. File privacy prevents accidental disclosure; it does not isolate credentials from the target OS user or root. */
export interface HeadlessAuthSnapshot {
  readonly profile: string
  readonly credentials: AccessCredentialStore
  readonly modelAccess?: readonly ProviderModelAccessSnapshot[]
}

function isAccessCredentialCollection(value: Credential | readonly AccessCredentialInstance[]): value is readonly AccessCredentialInstance[] {
  return Array.isArray(value)
}

function accessCredentialStore(store: AuthStore): AccessCredentialStore {
  return Object.fromEntries(Object.entries(store).map(([providerId, value]) => [
    providerId,
    isCredentialCollection(value) ? value.map((instance) => accessCredentialInstance(instance)) : value,
  ]))
}

function accessCredentialInstance(instance: Extract<AuthStore[string], readonly unknown[]>[number]): AccessCredentialInstance {
  if (instance.lineageId === undefined) throw new Error("credential instance lineage is unavailable")
  return {
    id: instance.id,
    identity: instance.identity,
    ...(instance.label === undefined ? {} : { label: instance.label }),
    lineageId: instance.lineageId,
    credential: instance.credential,
  }
}

function slotClassifier(providers: readonly AccessProviderDefinition[]): CredentialSlotClassifier {
  const subscriptionIds = subscriptionCredentialIds(providers)
  return (providerId) => subscriptionIds.has(providerId) ? "subscription" : "metered"
}

function validateCapturedStore(raw: unknown, providers: readonly AccessProviderDefinition[]) {
  const installedIds = installedCredentialProviderIds()
  const subscriptionIds = subscriptionCredentialIds(providers)
  const decoded = decodeAuthStoreWithDiagnostics(raw, {
    installedIds,
    classifySlot: slotClassifier(providers),
    rejectExcessProperties: true,
  })
  if (decoded.dropped.length > 0 || decoded.diagnostics.length > 0) throw new Error("credential store contains invalid entries")
  const store = decoded.store
  const credentialTypes = providerCredentialTypes(providers)
  const normalized: AuthStore = {}
  for (const [providerId, persisted] of Object.entries(store)) {
    const value = persisted
    const expectedType = credentialTypes.get(providerId)
    const credentials = isCredentialCollection(value) ? value.map(({ credential }) => credential) : [value]
    if (expectedType !== undefined && credentials.some(({ type }) => type !== expectedType)) throw new Error("credential type is invalid for provider")
    if (!subscriptionIds.has(providerId)) {
      if (isCredentialCollection(value)) throw new Error("credential collection shape is invalid")
      normalized[providerId] = value
      continue
    }
    if (!isCredentialCollection(value)) throw new Error("credential collection shape is invalid")
    const collection = value
    const ids = new Set<string>()
    const identities = new Set<string>()
    for (const instance of collection) {
      if (ids.has(instance.id) || identities.has(instance.identity)) throw new Error("credential collection is invalid")
      ids.add(instance.id)
      identities.add(instance.identity)
    }
    normalized[providerId] = collection
  }
  return { store: normalized, credentialLineages: decoded.credentialLineages }
}

/** The providers whose credentials a snapshot can carry. An external login's
 *  secrets stay with its program, so a snapshot carries nothing for it. */
function storedCredentialProviders(providers: readonly AccessProviderDefinition[]): readonly (AccessProviderDefinition & { readonly auth: { readonly kind: Credential["type"] } })[] {
  return providers.filter((provider): provider is AccessProviderDefinition & { readonly auth: { readonly kind: Credential["type"] } } => provider.auth.kind !== "external")
}

function subscriptionCredentialIds(providers: readonly AccessProviderDefinition[]): ReadonlySet<string> {
  return new Set(storedCredentialProviders(providers).filter(({ billing }) => billing === "subscription").map(credentialIdOf))
}

function providerCredentialTypes(providers: readonly AccessProviderDefinition[]): ReadonlyMap<string, Credential["type"]> {
  const credentialTypes = new Map<string, Credential["type"]>()
  for (const provider of storedCredentialProviders(providers)) {
    const credentialId = credentialIdOf(provider)
    const existing = credentialTypes.get(credentialId)
    if (existing !== undefined && existing !== provider.auth.kind) throw new Error("credential provider auth strategy is inconsistent")
    credentialTypes.set(credentialId, provider.auth.kind)
  }
  return credentialTypes
}

/** The host-side rotation of each provider whose refresh token serves nothing but that rotation, by credential id.
 *  An access-only run never rotates, so a snapshot carries no refresh token for these providers. A provider
 *  without one, such as GitHub Copilot, keeps its refresh field: its run consumes it to mint access tokens. */
function hostRefreshes(providers: readonly AccessProviderDefinition[]): ReadonlyMap<string, HostRefresh> {
  return new Map(providers.flatMap((provider) => provider.auth.kind === "oauth" && provider.auth.refresh !== undefined ? [[provider.auth.credentialId, provider.auth.refresh] as const] : []))
}
type HostRefresh = NonNullable<Extract<AccessProviderDefinition["auth"], { readonly kind: "oauth" }>["refresh"]>

function carriesRotatingRefresh(providerId: string, credential: Credential, refreshes: ReadonlyMap<string, HostRefresh>): credential is OAuthCredential {
  return credential.type === "oauth" && credential.refresh !== undefined && refreshes.has(providerId)
}

function accessOnlyCredential(providerId: string, credential: Credential, refreshes: ReadonlyMap<string, HostRefresh>): Credential {
  if (!carriesRotatingRefresh(providerId, credential, refreshes)) return credential
  const { refresh: _refresh, ...access } = credential
  return access
}

function validateAccessCredentialStore(store: AccessCredentialStore, providers: readonly AccessProviderDefinition[]): void {
  const subscriptionIds = subscriptionCredentialIds(providers)
  const credentialTypes = providerCredentialTypes(providers)
  const refreshes = hostRefreshes(providers)
  for (const [providerId, value] of Object.entries(store)) {
    if (subscriptionIds.has(providerId) !== isAccessCredentialCollection(value)) throw new Error("credential collection shape is invalid")
    const credentials = isAccessCredentialCollection(value) ? value.map(({ credential }) => credential) : [value]
    const expectedType = credentialTypes.get(providerId)
    if (expectedType !== undefined && credentials.some(({ type }) => type !== expectedType)) throw new Error("credential type is invalid for provider")
    if (credentials.some((credential) => credential.type === "api_key" && credential.key.startsWith("!"))) throw new Error("credential commands are not allowed")
    // A snapshot that an older binary wrote can carry a refresh token. It is a one-use transient file, not durable
    // user state, so the reader refuses it with no conversion, and the remedy is a new export.
    if (credentials.some((credential) => carriesRotatingRefresh(providerId, credential, refreshes))) throw new Error("refresh tokens are not allowed")
    if (isAccessCredentialCollection(value) && (new Set(value.map(({ id }) => id)).size !== value.length || new Set(value.map(({ identity }) => identity)).size !== value.length)) throw new Error("credential collection is invalid")
  }
}


/** Whether the opened snapshot admits nobody but this account.
 *
 *  POSIX proves it from the file's own mode and owning uid. Windows publishes
 *  neither, and it holds file privacy through the containing directory's ACL,
 *  which `requireSnapshotStage` has already proven owner-only. The link count
 *  and regular-file checks that surround this call carry the rest on both
 *  platforms. */
function fileAdmitsOwnerOnly(metadata: Stats): boolean {
  if (process.platform === "win32") return true
  const owner = process.getuid?.()
  return (metadata.mode & 0o077) === 0 && owner !== undefined && metadata.uid === owner
}

/** Access-only credentials never refresh and never persist an account choice,
 *  so the headless runtime cannot pick between two accounts of one
 *  subscription provider. The snapshot contract therefore carries one account
 *  for each such provider, and the export refuses a profile that holds more. */
function requireOneAccountPerSubscription(store: AuthStore | AccessCredentialStore): void {
  for (const [providerId, value] of Object.entries(store)) {
    if (Array.isArray(value) && value.length > 1) {
      throw new Error(`Headless auth snapshots carry one account for each subscription provider, but this profile has ${value.length} ${providerId} accounts. Export a profile that has one ${providerId} account.`)
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}

/** Opens the snapshot without following its name through a link. A missing
 *  file is almost always one that an earlier run consumed, so the refusal
 *  says that instead of a raw file-system error. */
function openSnapshot(path: string): number {
  try {
    requireSnapshotStage(path)
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (!isMissingFile(error)) throw error
    throw new Error(`Headless auth snapshot ${path} does not exist. A snapshot works for one run only, and that run deletes it. Export a new one with \`flywheel headless snapshot-auth\`.`, { cause: error })
  }
}

/** Consumes one owner-private headless credential snapshot without following its name through a link. */
export function readHeadlessAuthSnapshot(path: string, providers: readonly AccessProviderDefinition[]): HeadlessAuthSnapshot {
  const descriptor = openSnapshot(path)
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.nlink !== 1 || !fileAdmitsOwnerOnly(metadata)) {
      throw new Error("Headless auth snapshot must be a private, owner-controlled regular file")
    }
    if (metadata.size === 0 || metadata.size > MAX_BYTES) throw new Error("Headless auth snapshot size is invalid")
    const snapshot = decodeSnapshotContent(descriptor, providers)
    requireOneAccountPerSubscription(snapshot.credentials)
    return snapshot
  } finally {
    try {
      unlinkIfSameFile(path, fstatSync(descriptor))
    } finally {
      closeSync(descriptor)
    }
  }
}

/** Decodes and validates snapshot bytes. Every failure has one message, because a decode error can quote credential bytes. */
function decodeSnapshotContent(descriptor: number, providers: readonly AccessProviderDefinition[]): HeadlessAuthSnapshot {
  try {
    const schema = Schema.Struct({
      profile: Schema.String,
      credentials: AccessCredentialStoreSchema,
      // Remove the absent-field compatibility path after 2027-04-15.
      modelAccess: Schema.optional(ModelAccessSchema),
    })
    const snapshot = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(JSON.parse(readFileSync(descriptor, { encoding: "utf8" })))
    const installed = new Set(installedCredentialProviderIds())
    if (Object.keys(snapshot.credentials).some((provider) => !installed.has(provider))) throw new Error("unknown credential provider")
    validateAccessCredentialStore(snapshot.credentials, providers)
    const accounts = new Set<string>()
    for (const entry of snapshot.modelAccess ?? []) {
      const definition = providers.find(({ id }) => id === entry.account.providerId)
      if (definition?.dynamicCatalog?.probeAccess === undefined) throw new Error("unknown audited provider")
      const credential = snapshot.credentials[credentialIdOf(definition)]
      const key = accessProviderAccountKey(entry.account)
      if (accounts.has(key)) throw new Error("duplicate access account")
      accounts.add(key)
      if (entry.account.kind === "subscription") {
        const instanceId = entry.account.instanceId
        if (!credential || !isAccessCredentialCollection(credential) || !credential.some((instance) => instance.id === instanceId && instance.lineageId === entry.lineage)) throw new Error("access credential lineage mismatch")
      } else if (!credential || isAccessCredentialCollection(credential)) throw new Error("access credential is absent")
    }
    return { profile: requireAuthProfileName(snapshot.profile), credentials: snapshot.credentials, ...(snapshot.modelAccess === undefined ? {} : { modelAccess: snapshot.modelAccess }) }
  } catch {
    log.warn("Headless auth snapshot has an unreadable shape")
    throw new Error("Headless auth snapshot content is invalid")
  }
}

/** A refusal whose message names only provider ids and lifetimes, never a credential value. */
class SnapshotRefusal extends Error {}

/** The providers of `store` that `providerIds` names, or the whole store without a filter. */
function keptProviders(store: AuthStore, providerIds: readonly string[] | undefined): AuthStore {
  if (providerIds === undefined) return store
  return Object.fromEntries(Object.entries(store).filter(([providerId]) => providerIds.includes(providerId)))
}

interface OAuthToken {
  readonly providerId: string
  /** The subscription instance that holds the token; absent for a provider-level credential. */
  readonly instanceId?: string
  readonly credential: OAuthCredential
}

function oauthTokens(store: AuthStore): readonly OAuthToken[] {
  return Object.entries(store).flatMap(([providerId, value]) => {
    const entries = isCredentialCollection(value) ? value.map(({ id, credential }) => ({ instanceId: id, credential })) : [{ credential: value }]
    return entries.flatMap(({ credential, ...entry }) => credential.type === "oauth" ? [{ providerId, ...entry, credential }] : [])
  })
}

function storedApiKeys(store: AuthStore): readonly string[] {
  return Object.values(store).flatMap((value) => (isCredentialCollection(value) ? value.map(({ credential }) => credential) : [value]))
    .flatMap((credential) => credential.type === "api_key" ? [credential.key] : [])
}

function shortLivedTokens(store: AuthStore, minimumMs: number): readonly OAuthToken[] {
  const now = Date.now()
  return oauthTokens(store).filter(({ credential }) => credential.expires - now < minimumMs)
}

function lifetimeRefusal(token: OAuthToken, minimumMs: number, reason: string): SnapshotRefusal {
  const remainingSeconds = Math.floor((token.credential.expires - Date.now()) / 1000)
  const remaining = remainingSeconds > 0 ? `is valid for ${remainingSeconds} more seconds` : "has expired"
  return new SnapshotRefusal(`Headless auth snapshot refused: the ${token.providerId} access token ${remaining}, but ${minimumMs / 1000} seconds were requested, and ${reason}.`)
}

/** Writes a host-resolved snapshot to a new private file and returns the profile ID that the snapshot names.
 *
 *  `minValidSeconds` asks that every exported OAuth access token stay valid that long. The export refreshes a
 *  shorter-lived token on this host first, through the provider's declared rotation and the profile's
 *  compare-and-set, and refuses when that cannot satisfy the request. `asProfile` names the snapshot's profile
 *  instead of the exported profile's canonical ID, so a run can select a neutral profile name. `providerIds`, by
 *  credential provider id, keeps only those providers' credentials and model access, and limits the lifetime
 *  check and its refresh to them; it refuses an id that no installed provider declares or that the profile lacks. */
export async function writeHeadlessAuthSnapshot(options: { readonly userDataRoot: string; readonly projectRoot: string; readonly selector: string; readonly output: string; readonly resolveKey: KeyResolver; readonly providers: readonly AccessProviderDefinition[]; readonly minValidSeconds?: number; readonly asProfile?: string; readonly providerIds?: readonly string[] }): Promise<string> {
  requireSnapshotStage(options.output)
  if (options.asProfile !== undefined) requireAuthProfileName(options.asProfile)
  const installed = installedCredentialProviderIds()
  const unknown = options.providerIds?.find((providerId) => !installed.includes(providerId))
  if (unknown !== undefined) throw new SnapshotRefusal(`Headless auth snapshot refused: no installed provider declares the credential provider id ${unknown}.`)
  // A `!command` key helper can run for seconds, and the capture judges token lifetimes. So the helpers run between
  // captures, and the export serializes the latest capture whose keys are all resolved, with no wait after its
  // lifetime check. A capture that names a key no earlier helper resolved resolves it and captures again.
  const resolvedKeys = new Map<string, Redacted.Redacted<string>>()
  let captured: Awaited<ReturnType<typeof captureProfileStore>>
  try {
    while (true) {
      captured = await captureProfileStore(options)
      const unresolved = [...new Set(storedApiKeys(captured.store))].filter((key) => !resolvedKeys.has(key))
      if (unresolved.length === 0) break
      for (const key of unresolved) {
        const resolved = await options.resolveKey(key)
        if (!resolved) throw new Error("credential resolution failed")
        resolvedKeys.set(key, resolved)
      }
    }
  } catch (error) {
    if (error instanceof SnapshotRefusal) throw error
    // oxlint-disable-next-line preserve-caught-error -- boundary: the CLI prints every cause of its error, and a key helper's or a credential decoder's failure can quote a secret.
    throw new Error("Headless auth snapshot export failed")
  }
  const absent = options.providerIds?.find((providerId) => captured.store[providerId] === undefined)
  if (absent !== undefined) throw new SnapshotRefusal(`Headless auth snapshot refused: the selected profile holds no ${absent} credential.`)
  requireOneAccountPerSubscription(captured.store)
  const profile = options.asProfile ?? captured.profile
  const refreshes = hostRefreshes(options.providers)
  let created: { readonly dev: number; readonly ino: number } | undefined
  try {
    const resolvedCredential = (provider: string, credential: Credential): Credential => {
      if (credential.type === "oauth") return accessOnlyCredential(provider, credential, refreshes)
      const resolved = resolvedKeys.get(credential.key)
      if (resolved === undefined) throw new Error("credential resolution failed")
      return { type: "api_key", key: Redacted.value(resolved) }
    }
    const credentials: AuthStore = {}
    for (const [provider, value] of Object.entries(captured.store)) {
      credentials[provider] = isCredentialCollection(value)
        ? value.map((instance) => ({ ...instance, credential: resolvedCredential(provider, instance.credential) }))
        : resolvedCredential(provider, value)
    }
    const content = JSON.stringify({ profile, credentials: accessCredentialStore(credentials), modelAccess: captured.modelAccess } satisfies HeadlessAuthSnapshot)
    if (Buffer.byteLength(content) === 0 || Buffer.byteLength(content) > MAX_BYTES) throw new Error("snapshot exceeds size limit")
    const descriptor = openSync(options.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      created = fstatSync(descriptor)
      fchmodSync(descriptor, 0o600)
      writeFileSync(descriptor, content, { encoding: "utf8" })
    } finally {
      closeSync(descriptor)
    }
    return profile
  } catch {
    if (created) unlinkIfSameFile(options.output, created)
    throw new Error("Headless auth snapshot export failed")
  }
}

/** Reads one consistent revision of the selected profile's credential store. */
async function captureProfileStore(options: Parameters<typeof writeHeadlessAuthSnapshot>[0]): Promise<{ readonly profile: string; readonly store: AuthStore; readonly modelAccess: readonly ProviderModelAccessSnapshot[] }> {
  const manager = new AuthProfileManager({ userDataRoot: options.userDataRoot, projectRoot: options.projectRoot, env: { FLYWHEEL_AUTH_PROFILE: options.selector } })
  const profile = await manager.resolve()
  const access = await manager.acquireAccess()
  const minimumMs = options.minValidSeconds === undefined ? undefined : options.minValidSeconds * 1000
  try {
    if (minimumMs !== undefined) await renewShortLivedTokens(access, options.providers, minimumMs, options.providerIds)
    let revision = await access.withLock(() => readAuthText(access))
    while (true) {
      const expectedRevision = revision
      const store = await access.withLock(() => {
        const current = readAuthText(access)
        if (current !== expectedRevision) return undefined
        const decoded = validateCapturedStore(JSON.parse(current), options.providers)
        const kept = keptProviders(decoded.store, options.providerIds)
        const modelAccess: ProviderModelAccessSnapshot[] = []
        for (const definition of options.providers) {
          const contribution = definition.dynamicCatalog
          if (contribution?.probeAccess === undefined) continue
          const credential = kept[credentialIdOf(definition)]
          const accounts: { readonly account: AccessProviderAccountIdentity; readonly lineage: string | undefined }[] = isCredentialCollection(credential)
            ? credential.map((instance) => ({ account: { kind: "subscription", providerId: definition.id, instanceId: instance.id }, lineage: instance.lineageId }))
            : credential === undefined ? [] : [{ account: { kind: "singleton", providerId: definition.id }, lineage: decoded.credentialLineages[credentialIdOf(definition)] }]
          for (const { account, lineage } of accounts) {
            if (lineage === undefined) continue
            const audit = readSavedProviderModels(access, account, lineage, contribution.limits)?.audit
            if (audit !== undefined) modelAccess.push({ account, lineage, outcomes: audit.outcomes })
          }
        }
        return { store: kept, modelAccess }
      })
      if (store !== undefined) {
        if (minimumMs !== undefined) {
          const short = shortLivedTokens(store.store, minimumMs)[0]
          if (short !== undefined) throw lifetimeRefusal(short, minimumMs, "a refresh on this host did not extend it that far")
        }
        return { profile: profile.id, ...store }
      }
      revision = await access.withLock(() => readAuthText(access))
    }
  } finally {
    access.close()
  }
}

function readAuthText(access: AuthProfileAccess): string {
  return access.readFile("auth.json", 16 * 1024 * 1024)?.toString("utf8") ?? "{}"
}

/** Rotates, on this host, each OAuth token that would expire within `minimumMs`, and saves the rotation through
 *  the profile's compare-and-set. The host owns the refresh token and its rotation; the snapshot never does. A
 *  rotation that loses the compare-and-set to a concurrent writer is dropped, and the capture that follows judges
 *  the newer saved token. Refuses a token that its provider cannot rotate or whose rotation fails. */
async function renewShortLivedTokens(access: AuthProfileAccess, providers: readonly AccessProviderDefinition[], minimumMs: number, providerIds: readonly string[] | undefined): Promise<void> {
  const store = keptProviders(await access.withLock(() => validateCapturedStore(JSON.parse(readAuthText(access)), providers).store), providerIds)
  const refreshes = hostRefreshes(providers)
  const classifySlot = slotClassifier(providers)
  for (const token of shortLivedTokens(store, minimumMs)) {
    const refresh = refreshes.get(token.providerId)
    if (refresh === undefined || token.instanceId === undefined) throw lifetimeRefusal(token, minimumMs, "Flywheel cannot refresh it")
    let next: OAuthCredential
    try {
      next = oauthCredentialDto(await refresh(runtimeCredential(token.credential)))
    } catch {
      throw lifetimeRefusal(token, minimumMs, "its refresh on this host failed")
    }
    const saved = await replaceCredentialInstance(token.providerId, token.instanceId, token.credential, next, access, classifySlot)
    log.info("Headless auth snapshot refreshed a short-lived access token", { providerId: token.providerId, saved })
  }
}

export interface CapturedHeadlessSnapshot {
  readonly profileId: string
  readonly connection: ProviderConnection & { readonly profileId: string }
}

/** Creates the access-only connection of one consumed snapshot for its own profile, whose directory is `authDirectory`. */
export async function captureHeadlessSnapshotConnection(snapshot: HeadlessAuthSnapshot, authDirectory: string, providers: readonly AccessProviderDefinition[]): Promise<CapturedHeadlessSnapshot> {
  const profileId = snapshot.profile
  // The account context folds the whole snapshot: a subscription collection
  // with an OAuth credential reads as connected, the way a profile's does.
  const store = subscriptionAuthStore(snapshot.credentials)
  const credentialLineages = Object.fromEntries(Object.entries(store).flatMap(([providerId, credential]) => {
    if (isCredentialCollection(credential)) return []
    const saved = snapshot.modelAccess?.find(({ account }) => account.kind === "singleton" && providers.some((definition) => definition.id === account.providerId && credentialIdOf(definition) === providerId))
    return [[providerId, saved?.lineage ?? `headless:${providerId}`]]
  }))
  const auth = await resolveAuthContextFromStore({ store, resolveKey: async (value) => Redacted.make(value), credentialLineages })
  const connection = captureProviderConnection({
    profileId,
    authDir: authDirectory,
    auth,
    subscriptionCredentials: captureSubscriptionCredentials(providers, { kind: "decoded", store: subscriptionAuthStore(snapshot.credentials), authDir: authDirectory }),
    oauthPersistence: "access-only",
    modelAccess: snapshot.modelAccess,
  })
  return { profileId, connection }
}

function subscriptionAuthStore(store: AccessCredentialStore): AuthStore {
  const captured: AuthStore = {}
  for (const [providerId, value] of Object.entries(store)) {
    captured[providerId] = isAccessCredentialCollection(value)
      ? value.map(({ id, identity, label, lineageId, credential }) => ({
          id,
          identity,
          ...(label === undefined ? {} : { label }),
          lineageId,
          credential,
        }))
      : value
  }
  return captured
}
