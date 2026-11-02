/** A workspace that has been through a retirement, and one whose retirement was
 *  really interrupted.
 *
 *  A hand-staged imitation of a half-finished retirement proves nothing about
 *  the sequence that writes one, so this runs the production start in a real
 *  process and kills that process the moment production reaches the named
 *  durable checkpoint. What is left behind is what a crash leaves: no step below
 *  the checkpoint ran, nothing unwound, and the state generation gate is still
 *  held by a pid that is now gone.
 *
 *  `requireRetiredWorkspace` is the other half: the one description of what
 *  "retired" means on disk, which every case that finishes a retirement asserts
 *  against instead of restating a partial list of its own.
 *
 *  This file is both halves of that: imported, it is the parent's helper; run as
 *  a script, it is the start that gets killed. */

import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ProjectDirectories } from "../../src/infra/directory-authorities.js"
import { FLYWHEEL_DIR_NAME } from "../../src/infra/directory-authorities.js"
import { resolveEventStoreDbFile } from "../../src/infra/paths.js"
import { windowsDirectoryIsOwnerOnly } from "../../src/infra/windows-private-directory-acl.js"
import { createSqliteEventStore } from "../../src/infra/sqlite-event-store.js"
import { createSessionManager } from "../../src/orchestration/session/manager.js"
import {
  observeRetirementCheckpoints,
  WORKSPACE_STATE_EPOCH,
  type RetirementCheckpoint,
} from "../../src/orchestration/workspace-state-retirement.js"
import { prepareWorkspaceState } from "../../src/orchestration/workspace-state.js"

const THIS_FILE = fileURLToPath(import.meta.url)

/** Everything a settled project may hold beside the generation gate: one private
 *  event store of the current epoch, and nothing else. No sidecar, no session
 *  tree, no agent-output tree, no operation manifest, no staging target, and no
 *  quarantine an older release completed. */
const RETIRED_STATE_ENTRIES = ["flywheel.sqlite"] as const

/** Throw unless `projectRoot` converged on one current generation holding none
 *  of the retired bytes. Written as throws rather than expectations so the
 *  killed start's own process can use it too.
 *
 *  Reading the session catalog opens the event store, which leaves the sidecars
 *  of a live database behind, so this is the last thing a case does with the
 *  project it inspects. */
export async function requireRetiredWorkspace(projectRoot: string): Promise<void> {
  const flywheelDir = join(projectRoot, FLYWHEEL_DIR_NAME)
  const entries = readdirSync(flywheelDir)
    .filter((name) => !name.startsWith("project-generation.lock"))
    .sort()
  if (entries.join(", ") !== RETIRED_STATE_ENTRIES.join(", ")) {
    throw new Error(`a retired workspace holds ${RETIRED_STATE_ENTRIES.join(", ")}, not ${entries.join(", ")}`)
  }
  const dbFile = resolveEventStoreDbFile(projectRoot)
  if (process.platform === "win32") {
    if (!windowsDirectoryIsOwnerOnly(dbFile)) throw new Error("a retired event store must have an owner-only ACL")
  } else {
    const mode = statSync(dbFile).mode & 0o777
    if (mode !== 0o600) throw new Error(`a retired event store is owner-only, not ${mode.toString(8)}`)
  }
  requireCurrentEpoch(dbFile)
  await requireEmptySessionCatalog(projectRoot, dbFile)
}

function requireCurrentEpoch(dbFile: string): void {
  const db = new Database(dbFile, { readonly: true })
  try {
    const row = db.query<{ user_version?: unknown }, []>("PRAGMA user_version").get()
    if (row?.user_version !== WORKSPACE_STATE_EPOCH) {
      throw new Error(`a retired workspace is stamped epoch ${WORKSPACE_STATE_EPOCH}, not ${String(row?.user_version)}`)
    }
  } finally {
    db.close()
  }
}

/** The replacement generation carries no fact of the one it replaced, so its
 *  session catalog is empty. */
async function requireEmptySessionCatalog(projectRoot: string, dbFile: string): Promise<void> {
  const store = createSqliteEventStore(dbFile)
  try {
    const sessions = (await createSessionManager({ projectRoot, executionCwd: projectRoot, store }).listMetadata()).sessions
    if (sessions.length > 0) throw new Error(`a retired workspace holds no sessions, not ${sessions.length}`)
  } finally {
    store.close()
  }
}

/** Start preparing `directories` in another process and kill it at
 *  `checkpoint`. Throws when that start finished, or died, without reaching the
 *  checkpoint: an interruption fixture that silently did nothing would report a
 *  resume test as green. */
export async function interruptRetirementAt(directories: ProjectDirectories, checkpoint: RetirementCheckpoint): Promise<void> {
  const signalDir = mkdtempSync(join(tmpdir(), "flywheel-interrupted-"))
  const reachedFile = join(signalDir, "reached")
  try {
    const child = Bun.spawn(["bun", THIS_FILE, directories.userDataRoot, directories.accountHome, directories.projectRoot, checkpoint, reachedFile], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    while (!existsSync(reachedFile)) {
      if (child.exitCode !== null) {
        throw new Error(`the start never reached ${checkpoint}: ${await new Response(child.stderr).text()}`)
      }
      await Bun.sleep(2)
    }
    child.kill("SIGKILL")
    await child.exited
  } finally {
    rmSync(signalDir, { recursive: true, force: true })
  }
}

function runInterruptedStart(): void {
  const [userDataRoot, accountHome, projectRoot, checkpoint, reachedFile] = process.argv.slice(2)
  if (userDataRoot === undefined || accountHome === undefined || projectRoot === undefined || checkpoint === undefined || reachedFile === undefined) {
    throw new Error("an interrupted start takes the directories, the checkpoint, and the file to report it through")
  }
  observeRetirementCheckpoints((reached) => {
    if (reached !== checkpoint) return
    writeFileSync(reachedFile, "")
    // Stop dead. The parent kills this process here, so no step below the
    // checkpoint runs and no owner of this start is released.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  })
  prepareWorkspaceState({ userDataRoot, accountHome, projectRoot })
  throw new Error(`the start completed without reaching ${checkpoint}`)
}

if (import.meta.main) runInterruptedStart()
