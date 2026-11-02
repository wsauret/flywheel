import { Redacted, Schema } from "effect"
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, type Stats, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute } from "node:path"
import { windowsDirectoryIsOwnerOnly } from "../../infra/windows-private-directory-acl.js"
import { CredentialSchema, PersistentCredentialInstanceSchema, isCredentialCollection, type AuthStore, type Credential } from "../../infra/auth/auth-store-types.js"
import { decodeAuthStoreWithDiagnostics } from "../../infra/auth/auth-store.js"
import { captureProviderConnection, captureSubscriptionCredentials, resolveAuthContextFromStore, type ProviderConnection } from "../../infra/auth/auth-context.js"
import type { KeyResolver } from "../../infra/auth/resolve-key.js"
import { requireAuthProfileName } from "../../infra/paths.js"
import { accessProviderAccountKey, credentialIdOf, type AccessProviderAccountIdentity, type AccessProviderDefinition } from "../../infra/llm/access-provider.js"
import { readSavedProviderModels, type ProviderModelAccessSnapshot } from "../../infra/auth/provider-model-catalog-store.js"
import { Log } from "../../infra/log.js"
import { AuthProfileManager } from "../auth/auth-profile-manager.js"
import { installedCredentialProviderIds } from "../credential-provider-modules.js"

const MAX_BYTES = 64 * 1024
const STAGE_PREFIX = "flywheel-auth-bundle-"

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

function validateCapturedStore(raw: unknown, providers: readonly AccessProviderDefinition[]) {
  const installedIds = installedCredentialProviderIds()
  const subscriptionIds = subscriptionCredentialIds(providers)
  const decoded = decodeAuthStoreWithDiagnostics(raw, {
    installedIds,
    classifySlot: (providerId) => subscriptionIds.has(providerId) ? "subscription" : "metered",
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

function validateAccessCredentialStore(store: AccessCredentialStore, providers: readonly AccessProviderDefinition[]): void {
  const subscriptionIds = subscriptionCredentialIds(providers)
  const credentialTypes = providerCredentialTypes(providers)
  for (const [providerId, value] of Object.entries(store)) {
    if (subscriptionIds.has(providerId) !== isAccessCredentialCollection(value)) throw new Error("credential collection shape is invalid")
    const credentials = isAccessCredentialCollection(value) ? value.map(({ credential }) => credential) : [value]
    const expectedType = credentialTypes.get(providerId)
    if (expectedType !== undefined && credentials.some(({ type }) => type !== expectedType)) throw new Error("credential type is invalid for provider")
    if (credentials.some((credential) => credential.type === "api_key" && credential.key.startsWith("!"))) throw new Error("credential commands are not allowed")
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
    Log.create({ service: "headless-auth-snapshot" }).warn("Headless auth snapshot has an unreadable shape")
    throw new Error("Headless auth snapshot content is invalid")
  }
}

/** Writes a host-resolved snapshot to a new private file and returns its canonical profile ID. */
export async function writeHeadlessAuthSnapshot(options: { readonly userDataRoot: string; readonly projectRoot: string; readonly selector: string; readonly output: string; readonly resolveKey: KeyResolver; readonly providers: readonly AccessProviderDefinition[] }): Promise<string> {
  requireSnapshotStage(options.output)
  let captured: Awaited<ReturnType<typeof captureProfileStore>>
  try {
    captured = await captureProfileStore(options)
  } catch {
    throw new Error("Headless auth snapshot export failed")
  }
  requireOneAccountPerSubscription(captured.store)
  let created: { readonly dev: number; readonly ino: number } | undefined
  try {
    const credentials: AuthStore = {}
    for (const [provider, value] of Object.entries(captured.store)) {
      if (isCredentialCollection(value)) {
        credentials[provider] = await Promise.all(value.map(async (instance) => {
          if (instance.credential.type === "oauth") return instance
          const resolved = await options.resolveKey(instance.credential.key)
          if (!resolved) throw new Error("credential resolution failed")
          return { ...instance, credential: { type: "api_key" as const, key: Redacted.value(resolved) } }
        }))
      } else if (value.type === "oauth") credentials[provider] = value
      else {
        const resolved = await options.resolveKey(value.key)
        if (!resolved) throw new Error("credential resolution failed")
        credentials[provider] = { type: "api_key", key: Redacted.value(resolved) }
      }
    }
    const content = JSON.stringify({ profile: captured.profile, credentials: accessCredentialStore(credentials), modelAccess: captured.modelAccess } satisfies HeadlessAuthSnapshot)
    if (Buffer.byteLength(content) === 0 || Buffer.byteLength(content) > MAX_BYTES) throw new Error("snapshot exceeds size limit")
    const descriptor = openSync(options.output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      created = fstatSync(descriptor)
      fchmodSync(descriptor, 0o600)
      writeFileSync(descriptor, content, { encoding: "utf8" })
    } finally {
      closeSync(descriptor)
    }
    return captured.profile
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
  try {
    let revision = await access.withLock(() => access.readFile("auth.json", 16 * 1024 * 1024)?.toString("utf8") ?? "{}")
    while (true) {
      const expectedRevision = revision
      const store = await access.withLock(() => {
        const current = access.readFile("auth.json", 16 * 1024 * 1024)?.toString("utf8") ?? "{}"
        if (current !== expectedRevision) return undefined
        const decoded = validateCapturedStore(JSON.parse(current), options.providers)
        const modelAccess: ProviderModelAccessSnapshot[] = []
        for (const definition of options.providers) {
          const contribution = definition.dynamicCatalog
          if (contribution?.probeAccess === undefined) continue
          const credential = decoded.store[credentialIdOf(definition)]
          const accounts: { readonly account: AccessProviderAccountIdentity; readonly lineage: string | undefined }[] = isCredentialCollection(credential)
            ? credential.map((instance) => ({ account: { kind: "subscription", providerId: definition.id, instanceId: instance.id }, lineage: instance.lineageId }))
            : credential === undefined ? [] : [{ account: { kind: "singleton", providerId: definition.id }, lineage: decoded.credentialLineages[credentialIdOf(definition)] }]
          for (const { account, lineage } of accounts) {
            if (lineage === undefined) continue
            const audit = readSavedProviderModels(access, account, lineage, contribution.limits)?.audit
            if (audit !== undefined) modelAccess.push({ account, lineage, outcomes: audit.outcomes })
          }
        }
        return { store: decoded.store, modelAccess }
      })
      if (store !== undefined) return { profile: profile.id, ...store }
      revision = await access.withLock(() => access.readFile("auth.json", 16 * 1024 * 1024)?.toString("utf8") ?? "{}")
    }
  } finally {
    access.close()
  }
}

export interface CapturedHeadlessSnapshot {
  readonly profileId: string
  readonly connection: ProviderConnection & { readonly profileId: string }
}

/** Consumes one snapshot and creates its connection. */
export async function captureHeadlessSnapshotConnection(path: string | undefined, profileId: string, authDirectory: string, providers: readonly AccessProviderDefinition[]): Promise<CapturedHeadlessSnapshot | undefined> {
  if (path === undefined) return undefined
  const snapshot = readHeadlessAuthSnapshot(path, providers)
  if (snapshot.profile !== profileId) throw new Error("Headless auth snapshot profile does not match selected profile")
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
