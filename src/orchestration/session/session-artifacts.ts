/** Session-scoped filesystem artifacts: the session tree
 *  (`.flywheel/sessions/<id>`) and the tool-output breadcrumb tree
 *  (`.flywheel/agent-outputs/<id>`). This module is the only writer, sweeper,
 *  lister, and deleter of both.
 *
 *  Every operation walks each level relative to its parent's descriptor and
 *  follows no link, including the project root the walk starts at, so a project
 *  root, `sessions`, `agent-outputs`, id, or in-tree component another writer
 *  replaced is refused where it stands instead of redirecting the operation out
 *  of the project.
 *
 *  A runner names its breadcrumb tree by the conversation it serves, which is
 *  the session id only for a runner the session owns; a subagent or a replaced
 *  conversation leaves a tree no session deletion names. Retention, not
 *  deletion, is what reclaims those: the sweep below applies one project-wide
 *  cutoff to every breadcrumb tree.
 *
 *  A session tree is deleted with its session, but a session can live for
 *  weeks. The idle scratch sweep reclaims the large scratch entries its agents
 *  stopped using before then. */

import { randomUUID } from "node:crypto"
import { lstat, readdir, readFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { decodeGitDirectory } from "../../infra/git-metadata.js"
import { ContainedDirectory } from "../../infra/descriptor-directory.js"
import { FLYWHEEL_DIR_NAME } from "../../infra/directory-authorities.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { OwnedCommandRunner } from "../../infra/owned-command.js"
import { requireSessionIdComponent, SCRATCH_MUTATION_GIT_DIR, SCRATCH_MUTATIONS_DIR, SESSIONS_DIR, sessionRelativeDir, workflowRelativeDir } from "../../infra/paths.js"
import { mutationGitDirectoryName, mutationGitRuntimeExists } from "../agent-runtime/tools/bash-git-wrapper.js"
import { PRIVATE_COPY_RECORD } from "../agent-runtime/tools/bash-private-copy-record.js"
import { directoryComponents, removeTreeUnder, writeFileUnder } from "../../infra/write-file-under.js"

const log = Log.create({ service: "session-artifacts" })

const AGENT_OUTPUTS_NAME = "agent-outputs"
const AGENT_OUTPUTS_DIR = `${FLYWHEEL_DIR_NAME}/${AGENT_OUTPUTS_NAME}`

/** Every entry of `.flywheel` that holds session-scoped artifacts, named as the
 *  entry it is. A caller that stages or deletes a whole state generation names
 *  these roots from their owner instead of restating them. */
export const SESSION_ARTIFACT_ROOTS = [basename(SESSIONS_DIR), AGENT_OUTPUTS_NAME, "workflows"] as const

/** A breadcrumb outlives the runner that wrote it: a resumed session's durable
 *  transcript can still instruct the model to read one written before that
 *  runner exited. */
const BREADCRUMB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Floor between two sweeps of one project. Maintenance is worth one directory
 *  walk per window, never one per runner completion. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/** How every operation below opens the project root: Flywheel owns that
 *  component of the path, so a link put in its place is refused rather than
 *  followed into another tree. */
const OWNED_ROOT = { noFollowBase: true } as const

function breadcrumbRelativeDir(artifactScopeId: string): string {
  return `${AGENT_OUTPUTS_DIR}/${requireSessionIdComponent(artifactScopeId)}`
}

export interface ArtifactBreadcrumbWrite {
  readonly projectRoot: string
  /** Identity of the runner's breadcrumb tree; exactly one path component. */
  readonly artifactScopeId: string
  /** Breadcrumb filename prefix, so one tree's files stay attributable. */
  readonly toolName: string
  readonly content: string
}

/** Write one breadcrumb into its artifact scope and return its absolute path.
 * The file is owner-only, as is every directory this creates. An id that is not
 * one path component, and a replaced component anywhere below the project root,
 * both throw: those are defects of the caller or attacks on the tree, never
 * conditions to degrade past. */
export function writeArtifactBreadcrumb(write: ArtifactBreadcrumbWrite): string {
  const safeTool = write.toolName.replace(/[^a-zA-Z0-9_-]/g, "_")
  const name = `${safeTool}_${breadcrumbStamp(Date.now())}_${randomUUID().slice(0, 6)}.txt`
  const relativePath = `${breadcrumbRelativeDir(write.artifactScopeId)}/${name}`
  writeFileUnder(write.projectRoot, relativePath, write.content, { ...OWNED_ROOT, privateDirectories: true })
  return join(write.projectRoot, relativePath)
}

/** One session id that still owns filesystem artifacts, and which trees it owns.
 *  Absence of a tree is a reported fact, so a caller staging whole generations
 *  reads the inventory instead of probing the disk itself. */
export interface SessionArtifactTrees {
  readonly sessionId: string
  readonly hasSessionDir: boolean
  readonly hasBreadcrumbDir: boolean
}

/** Every session id with a session tree, a breadcrumb tree, or both, sorted. */
export function sessionArtifactInventory(projectRoot: string): readonly SessionArtifactTrees[] {
  const sessions = childNames(projectRoot, SESSIONS_DIR)
  const breadcrumbs = childNames(projectRoot, AGENT_OUTPUTS_DIR)
  return [...new Set([...sessions, ...breadcrumbs])].sort().map((sessionId) => ({
    sessionId,
    hasSessionDir: sessions.has(sessionId),
    hasBreadcrumbDir: breadcrumbs.has(sessionId),
  }))
}

/** Delete every breadcrumb written before the retention window, in every tree of
 *  the project, and remove a tree the sweep emptied. One cutoff for the whole
 *  project: a breadcrumb expires with its age, not with the runner or session
 *  that wrote it. `now` is a parameter so the boundary is testable at a fixed
 *  time. */
export function sweepBreadcrumbs(projectRoot: string, now: number): void {
  const cutoff = now - BREADCRUMB_RETENTION_MS
  for (const entry of sessionArtifactInventory(projectRoot)) {
    if (!entry.hasBreadcrumbDir) continue
    try {
      if (sweepBreadcrumbTree(projectRoot, entry.sessionId, cutoff) === 0) {
        removeEmptiedBreadcrumbTree(projectRoot, entry.sessionId)
      }
    } catch (err) {
      log.warn("breadcrumb tree sweep failed", { sessionId: entry.sessionId, error: errorMessage(err) })
    }
  }
}

/** Remove one breadcrumb tree the sweep emptied, and leave one a runner wrote
 *  into again where it stands: this is a single directory removal against the
 *  held parent, never a recursive deletion of whatever the tree holds now. */
function removeEmptiedBreadcrumbTree(projectRoot: string, sessionId: string): void {
  const outputs = ContainedDirectory.openExisting(projectRoot, directoryComponents(AGENT_OUTPUTS_DIR), OWNED_ROOT)
  if (!outputs) return
  try {
    outputs.removeEmptyChild(requireSessionIdComponent(sessionId))
  } finally {
    outputs.close()
  }
}

/** Remove the aged breadcrumbs of one tree and report how many entries remain. */
function sweepBreadcrumbTree(projectRoot: string, sessionId: string, cutoff: number): number {
  const directory = ContainedDirectory.openExisting(projectRoot, directoryComponents(breadcrumbRelativeDir(sessionId)), OWNED_ROOT)
  if (!directory) return 0
  let remaining = 0
  try {
    for (const name of directory.entryNames()) {
      if (!BREADCRUMB_NAME.test(name)) {
        remaining += 1
        continue
      }
      try {
        if (directory.regularFileModifiedAt(name) < cutoff) directory.removeFile(name)
        else remaining += 1
      } catch (err) {
        remaining += 1
        log.warn("breadcrumb entry sweep failed", { sessionId, name, error: errorMessage(err) })
      }
    }
  } finally {
    directory.close()
  }
  return remaining
}

interface ProjectSweep {
  running: boolean
  lastPassAt: number
}

export interface BreadcrumbMaintenance {
  request(): void
}

/** Create the maintenance owner for one project runtime. Every runner completion
 *  asks this coordinator, so one in-flight pass is shared across the runtime and
 *  at most one complete walk runs in each cadence window. */
export function createBreadcrumbMaintenance(projectRoot: string): BreadcrumbMaintenance {
  const sweep: ProjectSweep = { running: false, lastPassAt: 0 }
  return {
    request(): void {
      const now = Date.now()
      if (sweep.running || now - sweep.lastPassAt < SWEEP_INTERVAL_MS) return
      sweep.running = true
      sweep.lastPassAt = now
      queueMicrotask(() => {
        try {
          sweepBreadcrumbs(projectRoot, Date.now())
        } catch (err) {
          log.warn("breadcrumb sweep failed", { projectRoot, error: errorMessage(err) })
        } finally {
          sweep.running = false
        }
      })
    },
  }
}

/** A scratch entry larger than this that nobody wrote to for
 *  `SCRATCH_IDLE_DAYS` is removed. Agents copy whole projects, clone
 *  repositories, and build sandbox homes in scratch and leave them; the small
 *  scripts and evidence an audit keeps stay under the limit. */
export const SCRATCH_ENTRY_LIMIT_BYTES = 100 * 1024 * 1024

/** Long enough that a session resumed after a weekend still finds its clones. */
export const SCRATCH_IDLE_DAYS = 3

const SCRATCH_NOTES_NAME = "notes"
const GIT_TIMEOUT_MS = 30_000

/** When one scratch entry is removed: once nobody wrote to it for `idleMs`,
 *  if it holds more than `limitBytes`. */
interface ScratchRetention {
  readonly kind: "idle" | "orphaned-copy" | "mutation-git"
  readonly idleMs: number
  readonly limitBytes: number
}

const IDLE_ENTRY: ScratchRetention = { kind: "idle", idleMs: SCRATCH_IDLE_DAYS * 24 * 60 * 60 * 1000, limitBytes: SCRATCH_ENTRY_LIMIT_BYTES }

/** A private copy writes its record last, before its command starts, and its
 *  discard removes the record first. So a copy with no record is one no
 *  landing can read: its taking ended with its process, or its discard could
 *  not remove its files. Taking a copy writes continuously, so an hour without
 *  a write is never a copy still being taken. A refresh of a reused copy also
 *  removes the record first and writes to the home from its start. */
const ORPHANED_COPY: ScratchRetention = { kind: "orphaned-copy", idleMs: 60 * 60 * 1000, limitBytes: 0 }

/** A runtime's mutation Git shim folder is written once at install and only read after, so its idle age counts
 *  from install even while commands use it. The sweep therefore keeps the current runtime's folder, and the folder
 *  of every other runtime whose build or source snapshot still exists: a command that a previous build started keeps
 *  that build's shim on its PATH, and build collection removes a build only once nothing runs it. A folder whose
 *  runtime is gone, or which predates the runtime record, goes once idle. A runtime whose folder was removed
 *  installs it again at its next command. */
const MUTATION_GIT: ScratchRetention = { kind: "mutation-git", idleMs: SCRATCH_IDLE_DAYS * 24 * 60 * 60 * 1000, limitBytes: 0 }

/** Spreads the file events of removing a backlog of shim folders over several passes. */
export const MUTATION_GIT_REMOVALS_PER_SWEEP = 200

export interface ScratchSweep {
  readonly removedEntries: number
  readonly removedBytes: number
}

/** Remove every scratch entry, in every session of the project, that is larger
 *  than `SCRATCH_ENTRY_LIMIT_BYTES` and that nobody wrote to for
 *  `SCRATCH_IDLE_DAYS`. Each private copy under `mutations` is judged as its own
 *  entry, and one without its record goes after an hour, whatever its size
 *  (`ORPHANED_COPY`). Each runtime's Git shim folder under `mutation-git` goes
 *  once idle, whatever its size, except one whose runtime still exists, and at most
 *  `MUTATION_GIT_REMOVALS_PER_SWEEP` of them per pass (`MUTATION_GIT`). Scratch outside `notes` is disposable by contract
 *  (ARCH-SESSIONS-007, PI-AGENT-045), so an entry an agent still wants is one it keeps writing to.
 *  `notes` is the session-lifetime exception and is never visited. A linked
 *  worktree inside a removed entry is removed through Git first, so its
 *  repository does not keep the registration. Failures are per entry: one
 *  that cannot be measured or removed is logged and kept. */
export async function sweepIdleScratch(input: { readonly projectRoot: string; readonly now: number; readonly signal: AbortSignal; readonly runGit: OwnedCommandRunner }): Promise<ScratchSweep> {
  let removedEntries = 0
  let removedBytes = 0
  let mutationGitRemovals = 0
  const currentMutationGit = mutationGitDirectoryName(process.execPath, process.platform)
  /** Answers whether the entry was removed. */
  const sweepOne = async (sessionId: string, parent: ContainedDirectory, name: string, entry: string, retention: ScratchRetention): Promise<boolean> => {
    input.signal.throwIfAborted()
    let use: IdleEntryUse | undefined
    try {
      use = await measureIdleEntry(join(parent.canonicalPath(), name), input.now - retention.idleMs, input.signal)
    } catch (err) {
      if (input.signal.aborted) throw err
      log.debug("scratch entry could not be measured", { sessionId, entry, error: errorMessage(err) })
      return false
    }
    if (!use || use.bytes <= retention.limitBytes) return false
    for (const worktree of use.worktrees) await removeLinkedWorktree(worktree, input.runGit, sessionId)
    try {
      parent.removeTree(name)
    } catch (err) {
      log.warn("idle scratch entry removal failed", { sessionId, entry, error: errorMessage(err) })
      return false
    }
    removedEntries += 1
    removedBytes += use.bytes
    log.info("idle scratch entry removed", { sessionId, entry, kind: retention.kind, bytes: use.bytes, worktrees: use.worktrees.length })
    return true
  }
  const sweepMutationGit = async (sessionId: string, scratch: ContainedDirectory): Promise<void> => {
    const shims = scratch.openExistingChild(SCRATCH_MUTATION_GIT_DIR)
    if (!shims) return
    try {
      for (const name of shims.entryNames()) {
        if (mutationGitRemovals >= MUTATION_GIT_REMOVALS_PER_SWEEP) return
        if (name === currentMutationGit || mutationGitRuntimeExists(join(shims.canonicalPath(), name))) continue
        if (await sweepOne(sessionId, shims, name, `${SCRATCH_MUTATION_GIT_DIR}/${name}`, MUTATION_GIT)) mutationGitRemovals += 1
      }
    } finally {
      shims.close()
    }
  }
  const sweepSession = async (sessionId: string): Promise<void> => {
    const scratch = ContainedDirectory.openExisting(input.projectRoot, directoryComponents(`${sessionRelativeDir(sessionId)}/scratch`), OWNED_ROOT)
    if (!scratch) return
    try {
      for (const name of scratch.entryNames()) {
        if (name === SCRATCH_NOTES_NAME) continue
        if (name === SCRATCH_MUTATION_GIT_DIR) {
          await sweepMutationGit(sessionId, scratch)
          continue
        }
        // Private copies created before the rename remain here. Remove this read after 2027-04-15.
        if (name !== SCRATCH_MUTATIONS_DIR && name !== "edits") {
          await sweepOne(sessionId, scratch, name, name, IDLE_ENTRY)
          continue
        }
        const mutations = scratch.openExistingChild(name)
        if (!mutations) continue
        try {
          for (const copy of mutations.entryNames()) await sweepOne(sessionId, mutations, copy, `${name}/${copy}`, hasCopyRecord(mutations, copy) ? IDLE_ENTRY : ORPHANED_COPY)
        } finally {
          mutations.close()
        }
      }
    } finally {
      scratch.close()
    }
  }
  for (const { sessionId, hasSessionDir } of sessionArtifactInventory(input.projectRoot)) {
    if (!hasSessionDir) continue
    try {
      await sweepSession(sessionId)
    } catch (err) {
      if (input.signal.aborted) throw err
      log.warn("scratch sweep of one session failed", { sessionId, error: errorMessage(err) })
    }
  }
  return { removedEntries, removedBytes }
}

/** Whether the private copy home `name` holds its record. An entry that is not
 *  a directory has none. */
function hasCopyRecord(mutations: ContainedDirectory, name: string): boolean {
  const home = mutations.openExistingChild(name)
  if (!home) return false
  try {
    return home.hasEntry(PRIVATE_COPY_RECORD)
  } finally {
    home.close()
  }
}

interface LinkedWorktree {
  readonly path: string
  /** The Git directory of the repository that registers the worktree. */
  readonly commonDir: string
}

interface IdleEntryUse {
  readonly bytes: number
  readonly worktrees: readonly LinkedWorktree[]
}

/** Sizes one entry, or answers undefined at the first write inside the idle
 *  window, since a fresh entry is kept whatever its size. A write is dated by
 *  the later of its modification and change times: an archive extraction or
 *  `cp -p` sets modification times in the past, but no tool can set the change
 *  time back. Links are measured as themselves and never followed. */
async function measureIdleEntry(root: string, cutoff: number, signal: AbortSignal): Promise<IdleEntryUse | undefined> {
  let bytes = 0
  const worktrees: LinkedWorktree[] = []
  const pending = [root]
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    signal.throwIfAborted()
    const stats = await lstat(path)
    if (Math.max(stats.mtimeMs, stats.ctimeMs) >= cutoff) return undefined
    bytes += stats.size
    if (stats.isDirectory()) {
      for (const child of await readdir(path)) pending.push(join(path, child))
    } else if (stats.isFile() && basename(path) === ".git") {
      const worktree = await linkedWorktree(path)
      if (worktree) worktrees.push(worktree)
    }
  }
  return { bytes, worktrees }
}

/** A `.git` file that points into a repository's `worktrees` directory marks a
 *  linked worktree; any other `.git` file, such as a submodule's, is not one. */
async function linkedWorktree(gitFile: string): Promise<LinkedWorktree | undefined> {
  const gitDir = decodeGitDirectory(gitFile, await readFile(gitFile, "utf8"))
  if (!gitDir) return undefined
  const registrations = dirname(gitDir)
  if (basename(registrations) !== "worktrees") return undefined
  return { path: dirname(gitFile), commonDir: dirname(registrations) }
}

/** Removes the worktree and its registration through its repository. A
 *  failure is logged only: the files go with the entry anyway, and Git prunes
 *  a registration whose worktree is gone. Forced twice, because a locked
 *  worktree that Flywheel is deleting must not keep its registration. */
async function removeLinkedWorktree(worktree: LinkedWorktree, runGit: OwnedCommandRunner, sessionId: string): Promise<void> {
  try {
    const result = await runGit(["git", "--git-dir", worktree.commonDir, "worktree", "remove", "--force", "--force", worktree.path], { timeoutMs: GIT_TIMEOUT_MS })
    if (result.exitCode !== 0) log.debug("scratch worktree registration not removed", { sessionId, exitCode: result.exitCode })
  } catch (err) {
    log.debug("scratch worktree registration not removed", { sessionId, error: errorMessage(err) })
  }
}

/** Delete one session's disposable trees: its session directory and its
 *  breadcrumb directory. Absence of either is success. Callers delete only after
 *  the session's runner is disposed, so nothing is writing into a tree while it
 *  is walked. */
export function deleteSessionArtifacts(sessionId: string, projectRoot: string): void {
  removeTreeUnder(projectRoot, sessionRelativeDir(sessionId), OWNED_ROOT)
  removeTreeUnder(projectRoot, breadcrumbRelativeDir(sessionId), OWNED_ROOT)
}

/** Removes only aggregate-owned resources. Member resources have their own session deletion. */
export function deleteWorkflowArtifacts(workflowId: string, projectRoot: string): void {
  removeTreeUnder(projectRoot, workflowRelativeDir(workflowId), OWNED_ROOT)
  // Imported conversation resources stay here until the whole workflow settles.
  removeTreeUnder(projectRoot, sessionRelativeDir(workflowId), OWNED_ROOT)
}

/** The entry names one contained directory holds, or none when it is absent. */
function childNames(baseDir: string, relativeDir: string): ReadonlySet<string> {
  const directory = ContainedDirectory.openExisting(baseDir, directoryComponents(relativeDir), OWNED_ROOT)
  if (!directory) return new Set()
  try {
    // Directories only: a session id names a tree, and a stray regular file in
    // the parent (a retired breadcrumb layout wrote plain files here) must not
    // be swept or retired as if it were one.
    return new Set(directory.directoryEntryNames())
  } finally {
    directory.close()
  }
}

/** The timestamp keeps breadcrumb paths attributable in model-visible output.
 *  Retention reads descriptor-relative file metadata instead: the file's age is
 *  its modification time, independent of its generated display name. */
function breadcrumbStamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-")
}

const BREADCRUMB_NAME = /_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{6}\.txt$/
