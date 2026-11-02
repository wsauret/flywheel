/** Fixture vocabulary shared by the workspace-state retirement suites: a fresh
 *  workspace per case, the manifest a start of this release could have written,
 *  the staging target it owns, and the completed quarantine an older release
 *  left behind. */

import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { prepareWorkspaceState } from "../../src/orchestration/workspace-state.js"
import { WORKSPACE_STATE_EPOCH } from "../../src/orchestration/workspace-state-retirement.js"
import { DATABASE_MEMBERS } from "../../src/orchestration/workspace-state-generation-members.js"
import { testDirectories } from "./directories.js"
import type { ProjectDirectories } from "../../src/infra/directory-authorities.js"

export interface JsonObject {
  readonly [key: string]: unknown
}

interface LegacyEntries {
  readonly [member: string]: string
}

/** The primary store and its sidecars first, then every derived database. */
export const WORKSPACE_DATABASE_MEMBERS = DATABASE_MEMBERS

const tmpRoot = path.join(os.tmpdir(), `flywheel-retirement-${process.pid}-${Date.now()}`)

/** Remove every workspace the current test created. Called from each suite's
 *  afterEach so a case never reads another case's bytes. */
export function cleanupRetirementWorkspaces(): void {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

/** Prepare, then hand the generation back: every case reads what the start left
 *  on disk, and a lease left open reads as a live owner that forbids the next
 *  replacement in this process. */
export function prepareAndRelease(directories: ProjectDirectories): void {
  prepareWorkspaceState(directories).generation.release()
}

/** A fresh workspace and the directory authorities startup would publish for
 *  it. Each case owns its own project root and its own account state. */
export function makeWorkspace(): ProjectDirectories {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return testDirectories(dir)
}

export function makeWorkspaceFixture() {
  const directories = makeWorkspace()
  return { directories, baseDir: directories.projectRoot } satisfies { readonly directories: ProjectDirectories; readonly baseDir: string }
}

export function flywheelDir(baseDir: string): string {
  return path.join(baseDir, ".flywheel")
}

/** Everything the project holds that is not the generation gate, sorted. */
export function stateEntries(baseDir: string): string[] {
  return fs.readdirSync(flywheelDir(baseDir)).filter((name) => !name.startsWith("project-generation.lock")).sort()
}

export function writeUnder(directory: string, name: string, content: string): void {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, name), content)
}

/** One manifest a start of this release could legitimately have written, which
 *  a case spoils in exactly one way. */
export function validManifest(overrides: JsonObject = {}): JsonObject {
  return {
    version: 3,
    id: "operation-1",
    sourceEpoch: 1,
    targetEpoch: WORKSPACE_STATE_EPOCH,
    reason: "workspace state epoch 1",
    phase: "staging",
    location: { kind: "staging" },
    members: ["flywheel.sqlite"],
    ...overrides,
  }
}

export function manifestPath(baseDir: string): string {
  return path.join(flywheelDir(baseDir), "retiring", "retirement.json")
}

/** Where a manifest write that never reached its rename leaves its bytes. */
export function pendingManifestPath(baseDir: string): string {
  return `${manifestPath(baseDir)}.pending`
}

export function writeManifest(baseDir: string, manifest: JsonObject): void {
  writeJson(manifestPath(baseDir), manifest)
}

export function writePendingManifest(baseDir: string, manifest: JsonObject): void {
  writeJson(pendingManifestPath(baseDir), manifest)
}

function writeJson(file: string, content: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(content))
}

export function readManifest(baseDir: string): JsonObject {
  return JSON.parse(fs.readFileSync(manifestPath(baseDir), "utf8"))
}

export function readPendingManifest(baseDir: string): JsonObject {
  return JSON.parse(fs.readFileSync(pendingManifestPath(baseDir), "utf8"))
}

/** The staging target of `validManifest`, holding the named members. The
 *  database member is a real database of `epoch`, because that stamp is what
 *  licenses its deletion. */
export function stageTarget(baseDir: string, members: readonly string[], epoch = 1): void {
  const target = path.join(flywheelDir(baseDir), "retiring", "operation-1")
  fs.mkdirSync(target, { recursive: true })
  for (const name of members) {
    if (name === "flywheel.sqlite") stampEpoch(path.join(target, name), epoch)
    else fs.writeFileSync(path.join(target, name), "staged bytes")
  }
}

export function stagedMember(baseDir: string, name: string): string {
  return path.join(flywheelDir(baseDir), "retiring", "operation-1", name)
}

/** The staged copy of the generation, still stamped the epoch it was staged
 *  with: every refusal must leave those bytes exactly as they were. */
export function expectStagedDatabase(baseDir: string, epoch: number): void {
  expect(readEpoch(stagedMember(baseDir, "flywheel.sqlite"))).toBe(epoch)
}

/** The entry the legacy writer left in a target for each member name it
 *  declared: a sidecar was preserved under a suffixed name, and the session tree
 *  kept its own. */
const LEGACY_ENTRIES: Readonly<LegacyEntries> = {
  "flywheel.sqlite": "flywheel.sqlite",
  "flywheel.sqlite-wal": "flywheel.sqlite-wal.preserved",
  "flywheel.sqlite-shm": "flywheel.sqlite-shm.preserved",
  sessions: "sessions",
}

export interface CompletedQuarantine {
  readonly epoch: number
  /** Written as the target's directory name unless the case names another. */
  readonly id?: string
  readonly finalized?: boolean
  /** The member names the legacy manifest declares. */
  readonly declared?: readonly string[]
  /** The declared members it says were there to move. */
  readonly existing?: readonly string[]
  /** The declared members it says it moved, when that is not what it says
   *  existed. */
  readonly moved?: readonly string[]
  /** The members whose entries the target actually holds, when that is not what
   *  the manifest declares existed. */
  readonly present?: readonly string[]
}

/** One completed quarantine target of the previous protocol: a database of the
 *  named epoch, the entries of every other member that release moved, and the
 *  manifest it wrote to account for them. */
export function stageCompletedQuarantine(baseDir: string, staged: CompletedQuarantine): string {
  const id = crypto.randomUUID()
  const target = path.join(flywheelDir(baseDir), "quarantine", "workspace-state", id)
  fs.mkdirSync(target, { recursive: true })
  stampEpoch(path.join(target, "flywheel.sqlite"), staged.epoch)
  if (staged.finalized === false) return target
  const declared = staged.declared ?? Object.keys(LEGACY_ENTRIES)
  const existing = staged.existing ?? ["flywheel.sqlite"]
  const moved = staged.moved ?? existing
  for (const name of staged.present ?? existing) {
    if (name === "flywheel.sqlite") continue
    const entry = LEGACY_ENTRIES[name] ?? name
    if (name === "sessions") writeUnder(path.join(target, entry), "notes.txt", "old session bytes")
    else fs.writeFileSync(path.join(target, entry), "preserved bytes")
  }
  fs.writeFileSync(path.join(target, "quarantine.json"), JSON.stringify({
    version: 1,
    id: staged.id ?? id,
    reason: "legacy quarantine",
    members: declared.map((name) => ({ name, existed: existing.includes(name), moved: moved.includes(name) })),
  }))
  return target
}

/** Stamp one database, creating it when it is not there yet. */
export function stampEpoch(dbFile: string, epoch: number): void {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true })
  const db = new Database(dbFile, { create: true })
  try {
    db.exec(`PRAGMA user_version = ${epoch}`)
  } finally {
    db.close()
  }
}

export function readEpoch(dbFile: string): number {
  const db = new Database(dbFile, { readonly: true })
  try {
    const row = db.query<{ user_version?: unknown }, []>("PRAGMA user_version").get()
    return typeof row?.user_version === "number" ? row.user_version : 0
  } finally {
    db.close()
  }
}
