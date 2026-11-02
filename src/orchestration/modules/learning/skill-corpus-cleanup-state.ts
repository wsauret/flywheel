import { randomUUID } from "node:crypto"

import type { AsyncEventStateReadSurface, EventStoreAppend, StoredFact } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { parseSkillFact, skillCleanupCompletedFact } from "../../../workflows/skill-facts.js"
import { skillPackageManifestIdentity, type BundledCorpusIdentity, type SkillPackageIdentity, type SkillPackageManifestEntry } from "../../../workflows/skill-schema.js"

export const SKILL_CORPUS_CLEANUP_AGGREGATE_ID = "project:skill-core-cleanup:v2"
const SKILL_CORPUS_CLEANUP_SESSION_ID = "skill-core-cleanup-v2"
export const SKILL_CORPUS_CLEANUP_LEASE_MS = 5 * 60_000
export const SKILL_CORPUS_CLEANUP_COOLDOWN_MS = 60 * 60_000

/** The lease and its deferral cooldowns are in-flight state, not facts: each
 *  is one live value another process must be able to observe or take over,
 *  and recording them as facts wrote one row per ~100s renewal forever on an
 *  aggregate no deletion reaches (ARCH-SUBSTRATE-024).
 *  Only `skill.cleanup.completed` stays in the log, because every later claim
 *  consults the newest completion to decide whether work remains. */
const LEASE_IN_FLIGHT_KIND = "skill.cleanup.lease"
const LEASE_IN_FLIGHT_KEY = "core"
const COOLDOWN_IN_FLIGHT_KIND = "skill.cleanup.cooldown"

/** Historical claim-family facts written before the lease moved off the log.
 *  Read only as latest-per-type probes so a lease an older binary still holds
 *  as facts keeps fencing this one during the transition. */
const HISTORICAL_LEASE_FACT_TYPES = ["skill.cleanup.claimed", "skill.cleanup.renewed", "skill.cleanup.deferred", "skill.cleanup.completed"] as const

const log = Log.create({ service: "skill-corpus-cleanup" })

export type CoreManifest = readonly Readonly<SkillPackageManifestEntry>[]

interface CleanupLease {
  readonly coreIdentity: BundledCorpusIdentity
  readonly coreManifest: CoreManifest
  readonly ownerId: string
  readonly token: string
  readonly forced: boolean
  readonly expiresAt: number
  readonly transitionedAt: number
}

interface CleanupDeferral {
  readonly coreIdentity: BundledCorpusIdentity
  readonly cooldownUntil: number
}

interface SkillCorpusCleanupProjection {
  readonly completedCoreIdentity?: BundledCorpusIdentity
  readonly completedManifest?: CoreManifest
  readonly lease?: CleanupLease
  readonly deferrals: readonly CleanupDeferral[]
}

type SkillCorpusCleanupClaim =
  | { readonly kind: "claimed"; readonly token: string; readonly expiresAt: number; readonly changedPackageIds: readonly string[]; readonly removedPackageIds: readonly string[] }
  | { readonly kind: "already-complete" }
  | { readonly kind: "leased"; readonly expiresAt: number }
  | { readonly kind: "deferred"; readonly cooldownUntil: number }

interface SkillCorpusCleanupWriter {
  append(event: EventStoreAppend): StoredFact | Promise<StoredFact>
  putInFlight(sessionId: string, kind: string, key: string, payload: unknown): void | Promise<void>
  dropInFlight(sessionId: string, kind: string, key: string): void | Promise<void>
  swapInFlight(sessionId: string, kind: string, key: string, expectedRaw: string | null, payload: unknown | null): boolean | Promise<boolean>
}

interface SkillCorpusCleanupStateDeps {
  readonly reader: AsyncEventStateReadSurface
  readonly writer: SkillCorpusCleanupWriter
  readonly ownerId: string
  readonly now?: () => number
  readonly token?: () => string
}

export interface SkillCorpusCleanupState {
  claim(coreIdentity: BundledCorpusIdentity, coreManifest: CoreManifest, force?: boolean): Promise<SkillCorpusCleanupClaim>
  renew(coreIdentity: BundledCorpusIdentity, token: string): Promise<boolean>
  owns(coreIdentity: BundledCorpusIdentity, token: string): Promise<boolean>
  cancel(coreIdentity: BundledCorpusIdentity, token: string, reason: string): Promise<boolean>
  defer(coreIdentity: BundledCorpusIdentity, token: string, reason: string): Promise<boolean>
  complete(coreIdentity: BundledCorpusIdentity, coreManifest: CoreManifest, token: string): Promise<boolean>
  projection(): Promise<SkillCorpusCleanupProjection>
}

function sameCorpus(left: BundledCorpusIdentity | undefined, right: BundledCorpusIdentity): boolean {
  return left?.version === right.version && left.sha256 === right.sha256 && left.bytes === right.bytes
}

function samePackage(left: SkillPackageIdentity, right: SkillPackageIdentity): boolean {
  return left.sha256 === right.sha256 && left.bytes === right.bytes
}

function validateManifest(manifest: CoreManifest): void {
  let previous: string | undefined
  for (const row of manifest) {
    if (row.id.length === 0 || row.packageIdentity.sha256.length === 0 || !Number.isSafeInteger(row.packageIdentity.bytes) || row.packageIdentity.bytes < 0 || (previous !== undefined && previous.localeCompare(row.id) >= 0)) {
      throw new Error("Core manifest must contain unique package ids in sorted order with valid identities")
    }
    previous = row.id
  }
}

function validateCoreIdentity(coreIdentity: BundledCorpusIdentity, manifest: CoreManifest): void {
  validateManifest(manifest)
  if (!sameCorpus(skillPackageManifestIdentity(manifest), coreIdentity)) throw new Error("Core identity does not match the exact manifest")
}

function sameManifest(left: CoreManifest | undefined, right: CoreManifest): boolean {
  if (left?.length !== right.length) return false
  return right.every((row, index) => {
    const previous = left[index]
    return previous !== undefined && row.id === previous.id && samePackage(row.packageIdentity, previous.packageIdentity)
  })
}

function changedPackages(completed: CoreManifest | undefined, current: CoreManifest, force: boolean) {
  const previous = new Map(completed?.map((row) => [row.id, row.packageIdentity]))
  const currentIds = new Set(current.map((row) => row.id))
  return {
    changedPackageIds: current.filter((row) => {
      const priorIdentity = previous.get(row.id)
      return force || priorIdentity === undefined || !samePackage(priorIdentity, row.packageIdentity)
    }).map((row) => row.id),
    removedPackageIds: completed?.filter((row) => !currentIds.has(row.id)).map((row) => row.id) ?? [],
  }
}

function decodeIdentity(value: unknown): BundledCorpusIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const version = "version" in value ? value.version : undefined
  const sha256 = "sha256" in value ? value.sha256 : undefined
  const bytes = "bytes" in value ? value.bytes : undefined
  if (version !== 1 || typeof sha256 !== "string" || typeof bytes !== "number") return undefined
  return { version, sha256, bytes }
}

function decodePackageIdentity(value: unknown): SkillPackageIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const sha256 = "sha256" in value ? value.sha256 : undefined
  const bytes = "bytes" in value ? value.bytes : undefined
  return typeof sha256 === "string" && typeof bytes === "number" ? { sha256, bytes } : undefined
}

function decodeManifest(value: unknown): CoreManifest | undefined {
  if (!Array.isArray(value)) return undefined
  const rows: SkillPackageManifestEntry[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) return undefined
    const id = "id" in item ? item.id : undefined
    const packageIdentity = "packageIdentity" in item ? decodePackageIdentity(item.packageIdentity) : undefined
    if (typeof id !== "string" || packageIdentity === undefined) return undefined
    rows.push({ id, packageIdentity })
  }
  return rows
}

/** An undecodable cell reads as absent. The compare-and-swap makes that safe:
 *  a claimant replaces the exact bytes it read, so taking over a corrupt cell
 *  is atomic and never clobbers a healthy concurrent lease. */
function decodeLease(payload: { [key: string]: unknown }): CleanupLease | undefined {
  const coreIdentity = decodeIdentity(payload.coreIdentity)
  const coreManifest = decodeManifest(payload.coreManifest)
  const { ownerId, token, forced, expiresAt, transitionedAt } = payload
  if (coreIdentity === undefined || coreManifest === undefined) return undefined
  if (typeof ownerId !== "string" || typeof token !== "string" || typeof forced !== "boolean") return undefined
  if (typeof expiresAt !== "number" || typeof transitionedAt !== "number") return undefined
  return { coreIdentity, coreManifest, ownerId, token, forced, expiresAt, transitionedAt }
}

function decodeDeferral(payload: { [key: string]: unknown }): CleanupDeferral | undefined {
  const coreIdentity = decodeIdentity(payload.coreIdentity)
  const cooldownUntil = payload.cooldownUntil
  if (coreIdentity === undefined || typeof cooldownUntil !== "number") return undefined
  return { coreIdentity, cooldownUntil }
}

function cooldownKey(coreIdentity: BundledCorpusIdentity): string {
  return `${coreIdentity.version}:${coreIdentity.sha256}:${coreIdentity.bytes}`
}

interface HistoricalFence {
  readonly lease?: { readonly expiresAt: number }
  readonly deferral?: CleanupDeferral
}

/** Owns the versioned project core-cleanup claim and completion authority.
 *
 *  Mutual exclusion is the in-flight compare-and-swap: every lease transition
 *  replaces the exact bytes its owner validated, so two processes racing one
 *  cell settle in a single atomic statement, with no lock and no fact per
 *  transition. */
export function createSkillCorpusCleanupState(deps: SkillCorpusCleanupStateDeps): SkillCorpusCleanupState {
  const now = deps.now ?? Date.now
  const nextToken = deps.token ?? randomUUID
  const { reader } = deps

  const readLeaseCell = async (): Promise<{ readonly raw: string; readonly lease: CleanupLease | undefined } | undefined> => {
    const record = (await reader.readInFlight(SKILL_CORPUS_CLEANUP_SESSION_ID, LEASE_IN_FLIGHT_KIND)).find((row) => row.key === LEASE_IN_FLIGHT_KEY)
    return record ? { raw: record.raw, lease: decodeLease(record.payload) } : undefined
  }

  const readDeferrals = async (): Promise<readonly CleanupDeferral[]> =>
    (await reader.readInFlight(SKILL_CORPUS_CLEANUP_SESSION_ID, COOLDOWN_IN_FLIGHT_KIND))
      .map((row) => decodeDeferral(row.payload))
      .filter((deferral): deferral is CleanupDeferral => deferral !== undefined)

  const readCompleted = async (): Promise<{ readonly coreIdentity: BundledCorpusIdentity; readonly coreManifest: CoreManifest } | undefined> => {
    const event = (await reader.readLatestByAggregateAndTypes(SKILL_CORPUS_CLEANUP_AGGREGATE_ID, ["skill.cleanup.completed"])).at(-1)
    if (!event) return undefined
    const fact = parseSkillFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
    if (fact.type !== "skill.cleanup.completed" || !("coreManifest" in fact.payload)) return undefined
    return { coreIdentity: fact.payload.coreIdentity, coreManifest: fact.payload.coreManifest }
  }

  /** The transition bridge: a lease or cooldown an older binary recorded as
   *  facts still fences this binary until it settles or expires. Latest-
   *  per-type probes are enough because only the newest transition can be
   *  live, and this binary never writes the retired families back. */
  const readHistoricalFence = async (at: number): Promise<HistoricalFence> => {
    const probes = await reader.readLatestByAggregateAndTypes(SKILL_CORPUS_CLEANUP_AGGREGATE_ID, HISTORICAL_LEASE_FACT_TYPES)
    const newest = (type: string): StoredFact | undefined => probes.findLast((event) => event.type === type)
    const claimed = newest("skill.cleanup.claimed")
    const renewed = newest("skill.cleanup.renewed")
    const settledAt = Math.max(newest("skill.cleanup.deferred")?.position ?? -1, newest("skill.cleanup.completed")?.position ?? -1)
    const candidate = [claimed, renewed].filter((event): event is StoredFact => event !== undefined).sort((left, right) => left.position - right.position).at(-1)
    const liveLease = (): HistoricalFence["lease"] => {
      if (!candidate || candidate.position <= settledAt) return undefined
      const expiresAt = typeof candidate.payload.expiresAt === "number" ? candidate.payload.expiresAt : 0
      return expiresAt > at ? { expiresAt } : undefined
    }
    const liveDeferral = (): CleanupDeferral | undefined => {
      const deferred = newest("skill.cleanup.deferred")
      if (!deferred || probes.some((event) => event.position > deferred.position)) return undefined
      const coreIdentity = decodeIdentity(deferred.payload.coreIdentity)
      const cooldownUntil = typeof deferred.payload.cooldownUntil === "number" ? deferred.payload.cooldownUntil : 0
      return coreIdentity && cooldownUntil > at ? { coreIdentity, cooldownUntil } : undefined
    }
    const lease = liveLease()
    const deferral = liveDeferral()
    return { ...(lease ? { lease } : {}), ...(deferral ? { deferral } : {}) }
  }

  const ownsActiveLease = async (coreIdentity: BundledCorpusIdentity, token: string, at: number): Promise<{ readonly raw: string; readonly lease: CleanupLease } | undefined> => {
    const cell = await readLeaseCell()
    const lease = cell?.lease
    return cell && lease && lease.ownerId === deps.ownerId && lease.token === token && sameCorpus(lease.coreIdentity, coreIdentity) && at >= lease.transitionedAt && lease.expiresAt > at
      ? { raw: cell.raw, lease }
      : undefined
  }

  const settleClaim = async (coreIdentity: BundledCorpusIdentity, token: string, reason: string, cooldownMs: 0 | typeof SKILL_CORPUS_CLEANUP_COOLDOWN_MS): Promise<boolean> => {
    const settledAt = now()
    const owned = await ownsActiveLease(coreIdentity, token, settledAt)
    if (!owned) return false
    // Cooldown before release: a crash between the two leaves the lease to
    // expire on its own, which only delays the next claim by the lease TTL.
    if (cooldownMs > 0) await deps.writer.putInFlight(SKILL_CORPUS_CLEANUP_SESSION_ID, COOLDOWN_IN_FLIGHT_KIND, cooldownKey(coreIdentity), { coreIdentity, cooldownUntil: settledAt + cooldownMs })
    const released = await deps.writer.swapInFlight(SKILL_CORPUS_CLEANUP_SESSION_ID, LEASE_IN_FLIGHT_KIND, LEASE_IN_FLIGHT_KEY, owned.raw, null)
    if (released) log.info("skill cleanup claim settled", { ownerId: deps.ownerId, cooldownMs, reason })
    return released
  }

  return {
    async claim(coreIdentity, coreManifest, force = false) {
      validateCoreIdentity(coreIdentity, coreManifest)
      for (;;) {
        const time = now()
        const completed = await readCompleted()
        if (!force && sameCorpus(completed?.coreIdentity, coreIdentity) && sameManifest(completed?.coreManifest, coreManifest)) return { kind: "already-complete" }
        const cell = await readLeaseCell()
        if (cell?.lease && cell.lease.expiresAt > time) return { kind: "leased", expiresAt: cell.lease.expiresAt }
        const fence = await readHistoricalFence(time)
        if (fence.lease) return { kind: "leased", expiresAt: fence.lease.expiresAt }
        const deferral = (await readDeferrals()).find((entry) => sameCorpus(entry.coreIdentity, coreIdentity)) ?? (fence.deferral && sameCorpus(fence.deferral.coreIdentity, coreIdentity) ? fence.deferral : undefined)
        if (!force && deferral && deferral.cooldownUntil > time) return { kind: "deferred", cooldownUntil: deferral.cooldownUntil }
        const token = nextToken()
        const expiresAt = time + SKILL_CORPUS_CLEANUP_LEASE_MS
        const lease: CleanupLease = { coreIdentity, coreManifest, ownerId: deps.ownerId, token, forced: force, expiresAt, transitionedAt: time }
        if (!await deps.writer.swapInFlight(SKILL_CORPUS_CLEANUP_SESSION_ID, LEASE_IN_FLIGHT_KIND, LEASE_IN_FLIGHT_KEY, cell?.raw ?? null, lease)) continue
        // Self-cleaning: the claimed corpus's cooldown is consumed, and a
        // lapsed or unreadable cooldown protects nothing. A live cooldown for
        // a different corpus stays, because the registry can present that
        // corpus again.
        for (const row of await reader.readInFlight(SKILL_CORPUS_CLEANUP_SESSION_ID, COOLDOWN_IN_FLIGHT_KIND)) {
          const rowDeferral = decodeDeferral(row.payload)
          if (rowDeferral !== undefined && !sameCorpus(rowDeferral.coreIdentity, coreIdentity) && rowDeferral.cooldownUntil > time) continue
          await deps.writer.dropInFlight(SKILL_CORPUS_CLEANUP_SESSION_ID, COOLDOWN_IN_FLIGHT_KIND, row.key)
        }
        return { kind: "claimed", token, expiresAt, ...changedPackages(completed?.coreManifest, coreManifest, force) }
      }
    },
    async renew(coreIdentity, token) {
      const renewedAt = now()
      const owned = await ownsActiveLease(coreIdentity, token, renewedAt)
      if (!owned) return false
      const renewed: CleanupLease = { ...owned.lease, expiresAt: renewedAt + SKILL_CORPUS_CLEANUP_LEASE_MS, transitionedAt: renewedAt }
      return deps.writer.swapInFlight(SKILL_CORPUS_CLEANUP_SESSION_ID, LEASE_IN_FLIGHT_KIND, LEASE_IN_FLIGHT_KEY, owned.raw, renewed)
    },
    async owns(coreIdentity, token) { return await ownsActiveLease(coreIdentity, token, now()) !== undefined },
    cancel: async (coreIdentity, token, reason) => settleClaim(coreIdentity, token, reason, 0),
    defer: async (coreIdentity, token, reason) => settleClaim(coreIdentity, token, reason, SKILL_CORPUS_CLEANUP_COOLDOWN_MS),
    async complete(coreIdentity, coreManifest, token) {
      validateManifest(coreManifest)
      if (!sameCorpus(skillPackageManifestIdentity(coreManifest), coreIdentity)) return false
      const completedAt = now()
      const owned = await ownsActiveLease(coreIdentity, token, completedAt)
      if (!owned || !sameManifest(owned.lease.coreManifest, coreManifest)) return false
      // Releasing the lease is the linearization point: it succeeds for
      // exactly one caller, and a crash before the append below leaves no
      // completion, so the next claim simply re-runs the cleanup.
      if (!await deps.writer.swapInFlight(SKILL_CORPUS_CLEANUP_SESSION_ID, LEASE_IN_FLIGHT_KIND, LEASE_IN_FLIGHT_KEY, owned.raw, null)) return false
      const fact = skillCleanupCompletedFact({ coreIdentity, coreManifest, ownerId: deps.ownerId, token, completedAt })
      await deps.writer.append({ aggregateId: SKILL_CORPUS_CLEANUP_AGGREGATE_ID, ...fact, timestamp: completedAt, sessionId: SKILL_CORPUS_CLEANUP_SESSION_ID })
      return true
    },
    async projection() {
      const time = now()
      const completed = await readCompleted()
      const cell = await readLeaseCell()
      return {
        ...(completed ? { completedCoreIdentity: completed.coreIdentity, completedManifest: completed.coreManifest } : {}),
        ...(cell?.lease && cell.lease.expiresAt > time ? { lease: cell.lease } : {}),
        deferrals: (await readDeferrals()).filter((deferral) => deferral.cooldownUntil > time),
      }
    },
  }
}
