import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"

import { Log } from "../../infra/log.js"
import { isRecord, type UnknownRecord } from "../../infra/record.js"
import { writeFileAtomic, fsyncDirectory } from "../../infra/atomic-write.js"
import type { DefinitionFamily, DefinitionResolution } from "../../infra/definition-resolution.js"
import { acquireLock, releaseLock } from "../../infra/ownership-file-lock.js"
import type { BundledDefaultCatalog } from "./bundled-defaults.js"

const MANIFEST_NAME = "definition-override-baselines.json"
const HASH_PATTERN = /^[0-9a-f]{64}$/
const log = Log.create({ service: "definition-override-baselines" })

interface DefinitionOverrideBaselineRecord {
  readonly acknowledged_default_hash: string
}

export interface DefinitionOverrideBaselineRecords {
  readonly [physicalOverridePath: string]: DefinitionOverrideBaselineRecord
}

interface MutableDefinitionOverrideBaselineRecords {
  [physicalOverridePath: string]: DefinitionOverrideBaselineRecord
}

/** Why the manifest bytes could not be read. Each reason is a fixed kind, so a
 *  log record never carries manifest content. */
type UnreadableManifestReason = "not-json" | "unknown-shape" | "invalid-record"

interface OwnedManifestRead {
  readonly records: DefinitionOverrideBaselineRecords
  readonly repaired: boolean
}

export type DefinitionOverrideBaselineManifest =
  | { readonly kind: "readable"; readonly records: DefinitionOverrideBaselineRecords }
  | { readonly kind: "unreadable"; readonly reason: UnreadableManifestReason }

export interface DefinitionOverrideBaselineOwner {
  records(): DefinitionOverrideBaselineRecords
  observe(resolutions: readonly DefinitionResolution<unknown>[]): Promise<void>
  set(physicalOverridePath: string, acknowledgedDefaultHash: string): Promise<void>
}

export interface ObserveDefinitionOverrideBaselinesOptions {
  readonly userDataRoot: string
  readonly resolutions: readonly DefinitionResolution<unknown>[]
  readonly catalog: BundledDefaultCatalog
}

/** Completes initial observation before it exposes the manifest mutation authority. */
export async function createDefinitionOverrideBaselineOwner(options: ObserveDefinitionOverrideBaselinesOptions): Promise<DefinitionOverrideBaselineOwner> {
  let records = await observeDefinitionOverrideBaselines(options)
  const mutate = async (change: (current: DefinitionOverrideBaselineRecords) => DefinitionOverrideBaselineRecords): Promise<void> => {
    const manifestPath = join(options.userDataRoot, MANIFEST_NAME)
    const ownership = await acquireLock(`${manifestPath}.lock`)
    try {
      const next = change(readOwnedManifest(manifestPath).records)
      writeFileAtomic(manifestPath, `${JSON.stringify({ version: 1, records: next }, null, 2)}\n`, { mode: 0o600, durableDirectorySync: true })
      records = next
    } finally {
      releaseLock(ownership)
    }
  }
  return {
    records: () => records,
    observe: async (resolutions) => {
      records = await observeDefinitionOverrideBaselines({ ...options, resolutions })
    },
    set: async (path, hash) => {
      if (!HASH_PATTERN.test(hash)) throw new Error(`Invalid definition override baseline hash: ${hash}`)
      await mutate((current) => ({ ...current, [path]: { acknowledged_default_hash: hash } }))
    },
  }
}

/** Reads the manifest without mutation ownership. A missing manifest reads as
 *  no acknowledged baselines. */
export function readDefinitionOverrideBaselines(userDataRoot: string): DefinitionOverrideBaselineManifest {
  const manifestPath = join(userDataRoot, MANIFEST_NAME)
  if (!existsSync(manifestPath)) return { kind: "readable", records: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"))
  } catch {
    return { kind: "unreadable", reason: "not-json" }
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["version", "records"]) || parsed.version !== 1 || !isRecord(parsed.records)) {
    return { kind: "unreadable", reason: "unknown-shape" }
  }
  const records: MutableDefinitionOverrideBaselineRecords = {}
  for (const [path, value] of Object.entries(parsed.records)) {
    if (!isRecord(value) || !hasExactKeys(value, ["acknowledged_default_hash"]) || typeof value.acknowledged_default_hash !== "string" || !HASH_PATTERN.test(value.acknowledged_default_hash)) {
      return { kind: "unreadable", reason: "invalid-record" }
    }
    records[path] = { acknowledged_default_hash: value.acknowledged_default_hash }
  }
  return { kind: "readable", records }
}

/** Reads the manifest under mutation ownership. The manifest is a cache that
 *  the `.base` snapshots can rebuild, so unreadable bytes never stop a project
 *  from opening. The bytes move aside next to the manifest for inspection, and
 *  the caller rebuilds from no records. `repaired` tells the caller to write a
 *  new manifest even when it observes no new override. */
function readOwnedManifest(manifestPath: string): OwnedManifestRead {
  const manifest = readDefinitionOverrideBaselines(dirname(manifestPath))
  if (manifest.kind === "readable") return { records: manifest.records, repaired: false }
  const asidePath = `${manifestPath}.unreadable-${Date.now()}`
  renameSync(manifestPath, asidePath)
  log.warn("definition override baseline manifest was unreadable; moved it aside and rebuilt it from the snapshots", { manifestPath, asidePath, reason: manifest.reason })
  return { records: {}, repaired: true }
}

/** Observes each physical override once. Read-only observations need no mutation ownership. Snapshot publication completes before a new baseline is committed. */
export async function observeDefinitionOverrideBaselines(options: ObserveDefinitionOverrideBaselinesOptions): Promise<DefinitionOverrideBaselineRecords> {
  const observed = readDefinitionOverrideBaselines(options.userDataRoot)
  if (observed.kind === "readable") {
    const missing = options.resolutions.some((resolution) => options.catalog.files[resolution.target] !== undefined
      && resolution.candidates.some((candidate) => candidate.source.layer !== "bundled" && !observed.records[candidate.source.path]))
    if (!missing) return observed.records
  }

  const manifestPath = join(options.userDataRoot, MANIFEST_NAME)
  const ownership = await acquireLock(`${manifestPath}.lock`)
  try {
    // A concurrent owner may have acknowledged these paths before this lock was acquired.
    const owned = readOwnedManifest(manifestPath)
    const records = { ...owned.records }
    let changed = owned.repaired
    for (const resolution of options.resolutions) {
      const current = options.catalog.files[resolution.target]
      if (!current) continue
      for (const candidate of resolution.candidates) {
        if (candidate.source.layer === "bundled" || records[candidate.source.path]) continue
        const snapshotPath = snapshotPathFor(resolution.family, candidate.source.path)
        const snapshotIdentity = readSnapshotIdentity(resolution.family, snapshotPath)
        const acknowledgedDefaultHash = snapshotIdentity ?? current.baseDefaultHash
        if (acknowledgedDefaultHash === current.baseDefaultHash && snapshotIdentity === undefined && !existsSync(snapshotPath)) {
          publishCurrentSnapshot(resolution.family, snapshotPath, resolution.target, options.catalog)
        }
        records[candidate.source.path] = { acknowledged_default_hash: acknowledgedDefaultHash }
        changed = true
      }
    }
    if (changed) {
      writeFileAtomic(manifestPath, `${JSON.stringify({ version: 1, records }, null, 2)}\n`, { mode: 0o600, durableDirectorySync: true })
    }
    return records
  } finally {
    releaseLock(ownership)
  }
}

function publishCurrentSnapshot(family: DefinitionFamily, snapshotPath: string, catalogPath: string, catalog: BundledDefaultCatalog): void {
  const bundled = catalog.files[catalogPath]
  if (!bundled) return
  if (family !== "skill") {
    writeFileAtomic(snapshotPath, bundled.content, { durableDirectorySync: true })
    return
  }
  const temporaryPath = `${snapshotPath}.__flywheel__.${process.pid}.${randomUUID()}.tmp`
  mkdirSync(temporaryPath, { recursive: true })
  const prefix = `${catalogPath.slice(0, catalogPath.lastIndexOf("/") + 1)}`
  for (const [path, file] of Object.entries(catalog.files).sort(([left], [right]) => left.localeCompare(right))) {
    if (!path.startsWith(prefix)) continue
    const target = join(temporaryPath, path.slice(prefix.length))
    writeFileAtomic(target, file.content, { durableDirectorySync: true })
  }
  mkdirSync(dirname(snapshotPath), { recursive: true })
  renameSync(temporaryPath, snapshotPath)
  fsyncDirectory(dirname(snapshotPath))
}

function readSnapshotIdentity(family: DefinitionFamily, snapshotPath: string): string | undefined {
  if (!existsSync(snapshotPath)) return undefined
  try {
    const stat = lstatSync(snapshotPath)
    if (family !== "skill") return stat.isFile() ? sha256(readFileSync(snapshotPath)) : undefined
    if (!stat.isDirectory()) return undefined
    const files: [string, Buffer][] = []
    collectSnapshotFiles(snapshotPath, "", files)
    const hash = createHash("sha256")
    for (const [path, content] of files.sort(([left], [right]) => left.localeCompare(right))) {
      const contentHash = sha256(content)
      hash.update(`${Buffer.byteLength(path)}:${path}${contentHash.length}:${contentHash}`)
    }
    return hash.digest("hex")
  } catch {
    return undefined
  }
}

function collectSnapshotFiles(root: string, prefix: string, files: [string, Buffer][]): void {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) collectSnapshotFiles(root, relative, files)
    else if (entry.isFile()) files.push([relative, readFileSync(join(root, relative))])
    else throw new Error(`Invalid snapshot entry: ${join(root, relative)}`)
  }
}

function snapshotPathFor(family: DefinitionFamily, overridePath: string): string {
  return family === "skill" ? join(dirname(overridePath), ".base") : `${overridePath}.base`
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}


function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}
