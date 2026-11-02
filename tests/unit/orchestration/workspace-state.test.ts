/** What one start decides about the state generation it finds.
 *
 *  Retirement deletes what it stages, so the decision is the safety property:
 *  a generation whose epoch this release declares is retired and replaced, and
 *  anything else keeps its exact layout while the start refuses. The sequence
 *  that performs a retirement, and its resume after a killed start, are proven
 *  across real processes in tests/integration/workspace-state-concurrency. */

import { afterEach, describe, expect, it } from "bun:test"
import { CONTAINMENT_REFUSAL } from "../../helpers/containment-refusal.js"
import { POSIX_FILE_MODES } from "../../helpers/posix-modes.js"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Worker } from "node:worker_threads"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { resolveEventStoreDbFile, resolveSessionsDir } from "../../../src/infra/paths.js"
import { createSessionManager } from "../../../src/orchestration/session/manager.js"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import { WORKSPACE_STATE_EPOCH } from "../../../src/orchestration/workspace-state-retirement.js"
import { startRefusalOf } from "../../../src/protocol/serve-handshake.js"
import { retainedDefinitions, retainedProject } from "../../fixtures/retired-workflows/retained-project.js"
import { retiredFixtureWorkflow } from "../../helpers/retired-fixture-briefs.js"
import { retiredStepIdentity } from "../../../src/workflows/vm/retired-step-identity.js"
import { retiredBuiltInDefinition } from "../../../src/workflows/vm/retired-built-in-definitions.js"
import { prePhaseControl } from "./migrations/_pre-phase-control.js"
import { resolveWorkflowAgents } from "../../../src/workflows/agent-resolution.js"
import { workflowAggregateId } from "../../../src/workflows/vm/session-facts.js"
import { testDirectories } from "../../helpers/directories.js"
import type { ProjectDirectories } from "../../../src/infra/directory-authorities.js"
import { startupPhase, type StartupReached } from "../../../src/protocol/startup-steps.js"

const tmpRoot = path.join(os.tmpdir(), `flywheel-workspace-state-${process.pid}-${Date.now()}`)

/** One legacy overlay step definition, of the shape the one-time step catalog
 *  migration rewrites into a skill package and retires. */
const LEGACY_STEP = [
  "---",
  "name: Create Plan",
  "description: Turn a settled design into a spec.",
  "---",
  "Write the spec.",
].join("\n")

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("prepareWorkspaceState", () => {
  it("preserves valid current workspace state", async () => {
    const directories = makeWorkspace()
    const baseDir = directories.projectRoot
    const first = prepareWorkspaceState(directories)
    const store = createSqliteEventStore(first.dbFile)
    try {
      await createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store }).createChat({ name: "Chat" })
    } finally {
      store.close()
      first.generation.release()
    }

    const second = prepareWorkspaceState(directories)

    const reopened = createSqliteEventStore(second.dbFile)
    try {
      expect(readEpoch(second.dbFile)).toBe(WORKSPACE_STATE_EPOCH)
      expect((await createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store: reopened }).listMetadata()).sessions).toHaveLength(1)
    } finally {
      reopened.close()
      second.generation.release()
    }
  })

  it("retires a declared legacy generation and leaves no copy of it behind", async () => {
    const directories = makeWorkspace()
    const baseDir = directories.projectRoot
    const dbFile = resolveEventStoreDbFile(baseDir)
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    await seedChatSession(baseDir, dbFile)
    stampEpoch(dbFile, 1)
    writeUnder(path.join(flywheelDir(baseDir), "agent-outputs", "chat"), "read_1.txt", "crumb")

    const result = prepareWorkspaceState(directories)

    try {
      expect(readEpoch(result.dbFile)).toBe(WORKSPACE_STATE_EPOCH)
      expect(stateEntries(baseDir)).toEqual(["flywheel.sqlite"])
      const reopened = createSqliteEventStore(result.dbFile)
      try {
        expect((await createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store: reopened }).listMetadata()).sessions).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      result.generation.release()
    }
  })

  it("refuses an unstamped event store, which proves no epoch, and discards none of its bytes", async () => {
    const directories = makeWorkspace()
    const baseDir = directories.projectRoot
    const dbFile = resolveEventStoreDbFile(baseDir)
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    const store = createSqliteEventStore(dbFile)
    try {
      await createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store }).createChat({ name: "Chat" })
    } finally {
      store.close()
    }
    const before = fs.readFileSync(dbFile)

    expect(() => prepareWorkspaceState(directories))
      .toThrow(`workspace state epoch 0 has no declared transition to epoch ${WORKSPACE_STATE_EPOCH}`)

    expect(fs.readFileSync(dbFile)).toEqual(before)
    expect(readEpoch(dbFile)).toBe(0)
    expect(stateEntries(baseDir)).toEqual(["flywheel.sqlite", "sessions"])
  })

  it("preserves current workspace state when one session has invalid replay data", async () => {
    const directories = makeWorkspace()
    const baseDir = directories.projectRoot
    const prepared = prepareWorkspaceState(directories)
    const store = createSqliteEventStore(prepared.dbFile)
    let sessionId = ""
    try {
      sessionId = await createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store }).createChat({ name: "Chat" })
      store.append({
        aggregateId: `session:${sessionId}`,
        type: "output.snapshot.recorded",
        version: 3,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId,
        payload: {
          blocks: [{ kind: "text", content: "stale block without id", timestamp: Date.now() }],
        },
      })
    } finally {
      store.close()
      prepared.generation.release()
    }

    const result = prepareWorkspaceState(directories)

    expect(fs.existsSync(path.join(resolveSessionsDir(baseDir), sessionId))).toBe(true)
    const reopened = createSqliteEventStore(result.dbFile)
    try {
      expect((await createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store: reopened }).listMetadata()).sessions).toHaveLength(1)
    } finally {
      reopened.close()
      result.generation.release()
    }
  })

  it("refuses orphaned workspace members, which prove no epoch, and leaves their layout exactly as it was", () => {
    const directories = makeWorkspace()
    const baseDir = directories.projectRoot
    const dbFile = resolveEventStoreDbFile(baseDir)
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    fs.writeFileSync(`${dbFile}-wal`, "orphan log")
    fs.writeFileSync(`${dbFile}-shm`, "orphan shared memory")
    writeUnder(path.join(resolveSessionsDir(baseDir), "stale-session"), "blocks.json", "[]")
    writeUnder(path.join(flywheelDir(baseDir), "agent-outputs", "stale-session"), "read_1.txt", "crumb")

    expect(() => prepareWorkspaceState(directories))
      .toThrow("orphaned workspace members without an event store: flywheel.sqlite-wal, flywheel.sqlite-shm, sessions, agent-outputs")

    expect(fs.existsSync(dbFile)).toBe(false)
    expect(fs.readFileSync(`${dbFile}-wal`, "utf8")).toBe("orphan log")
    expect(fs.readFileSync(path.join(resolveSessionsDir(baseDir), "stale-session", "blocks.json"), "utf8")).toBe("[]")
    expect(stateEntries(baseDir)).toEqual(["agent-outputs", "flywheel.sqlite-shm", "flywheel.sqlite-wal", "sessions"])
  })

  it("refuses a database it cannot open, and discards none of its bytes", () => {
    const directories = makeWorkspace()
    const baseDir = directories.projectRoot
    const dbFile = resolveEventStoreDbFile(baseDir)
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    const corrupt = Buffer.from("not a sqlite database")
    fs.writeFileSync(dbFile, corrupt)

    expect(() => prepareWorkspaceState(directories)).toThrow("event store could not be opened")

    expect(fs.readFileSync(dbFile)).toEqual(corrupt)
    expect(stateEntries(baseDir)).toEqual(["flywheel.sqlite"])
  })

  it("refuses an invalid generation before it migrates the legacy overlay definitions beside it", () => {
    const directories = makeWorkspace()
    const baseDir = directories.projectRoot
    const dbFile = resolveEventStoreDbFile(baseDir)
    fs.mkdirSync(path.dirname(dbFile), { recursive: true })
    stampEpoch(dbFile, WORKSPACE_STATE_EPOCH + 5)
    const legacyStep = path.join(flywheelDir(baseDir), "steps", "flywheel", "plan-create.md")
    writeUnder(path.dirname(legacyStep), path.basename(legacyStep), LEGACY_STEP)

    // Only a later release stamps a higher epoch, so the refusal names that
    // cause for the person instead of the lane reset, which cannot open it.
    let refused: unknown
    try {
      prepareWorkspaceState(directories)
    } catch (error) {
      refused = error
    }
    expect(refused).toMatchObject({ message: `workspace state cannot be prepared: a newer release wrote workspace state epoch ${WORKSPACE_STATE_EPOCH + 5}; this release reads epoch ${WORKSPACE_STATE_EPOCH}` })
    expect(startRefusalOf(refused)).toEqual({ kind: "state-from-newer-release", stateEpoch: WORKSPACE_STATE_EPOCH + 5, readableEpoch: WORKSPACE_STATE_EPOCH })

    // The overlay is this project's own definitions: a start that cannot
    // classify the generation they belong to rewrites none of them.
    expect(fs.readFileSync(legacyStep, "utf8")).toBe(LEGACY_STEP)
    expect(fs.existsSync(path.join(flywheelDir(baseDir), "skills"))).toBe(false)
    expect(stateEntries(baseDir)).toEqual(["flywheel.sqlite", "steps"])
  })

  it("refuses a retirement manifest that is a symlink", () => {
    const directories = makeWorkspace()
    const baseDir = directories.projectRoot
    const retiring = path.join(flywheelDir(baseDir), "retiring")
    fs.mkdirSync(retiring, { recursive: true })
    const outside = path.join(baseDir, "outside.json")
    fs.writeFileSync(outside, JSON.stringify({ version: 2, id: "planted", epoch: 1, reason: "planted", phase: "staging", members: [] }))
    fs.symlinkSync(outside, path.join(retiring, "retirement.json"))

    expect(() => prepareWorkspaceState(directories)).toThrow(CONTAINMENT_REFUSAL)
    expect(fs.existsSync(resolveEventStoreDbFile(baseDir))).toBe(false)
  })

  it("does not treat an empty retirement manifest as absent", () => {
    const directories = makeWorkspace()
    const baseDir = directories.projectRoot
    const retiring = path.join(flywheelDir(baseDir), "retiring")
    fs.mkdirSync(retiring, { recursive: true })
    fs.writeFileSync(path.join(retiring, "retirement.json"), "")

    expect(() => prepareWorkspaceState(directories)).toThrow()
    expect(fs.existsSync(resolveEventStoreDbFile(baseDir))).toBe(false)
  })

  it("creates private workspace storage", () => {
    const directories = makeWorkspace()
    const prepared = prepareWorkspaceState(directories)
    const store = createSqliteEventStore(prepared.dbFile)
    try {
      if (POSIX_FILE_MODES) expect(fs.statSync(path.dirname(prepared.dbFile)).mode & 0o777).toBe(0o700)
      if (POSIX_FILE_MODES) expect(fs.statSync(prepared.dbFile).mode & 0o777).toBe(0o600)
      for (const sidecar of [`${prepared.dbFile}-wal`, `${prepared.dbFile}-shm`]) {
        if (POSIX_FILE_MODES && fs.existsSync(sidecar)) expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600)
      }
    } finally {
      store.close()
    }
  })

  it("refuses a workspace member that is a symlink and leaves what it points at alone", () => {
    const directories = makeWorkspace()
    const baseDir = directories.projectRoot
    const outside = path.join(tmpRoot, `outside-${crypto.randomUUID()}.wal`)
    fs.writeFileSync(outside, "not ours")
    fs.mkdirSync(flywheelDir(baseDir), { recursive: true })
    fs.symlinkSync(outside, `${resolveEventStoreDbFile(baseDir)}-wal`)

    expect(() => prepareWorkspaceState(directories)).toThrow(CONTAINMENT_REFUSAL)
    expect(fs.readFileSync(outside, "utf8")).toBe("not ours")
    expect(fs.existsSync(resolveEventStoreDbFile(baseDir))).toBe(false)
  })

  it("refuses a session tree that is a symlink and moves nothing outside the project", () => {
    const directories = makeWorkspace()
    const baseDir = directories.projectRoot
    const outside = path.join(tmpRoot, `outside-${crypto.randomUUID()}`)
    writeUnder(outside, "evidence.txt", "not ours")
    fs.mkdirSync(flywheelDir(baseDir), { recursive: true })
    fs.symlinkSync(outside, resolveSessionsDir(baseDir))

    expect(() => prepareWorkspaceState(directories)).toThrow(CONTAINMENT_REFUSAL)
    expect(fs.readFileSync(path.join(outside, "evidence.txt"), "utf8")).toBe("not ours")
    expect(fs.existsSync(resolveEventStoreDbFile(baseDir))).toBe(false)
  })

  it("adopts context identity for workflow control staged before skills and personas", () => {
    const directories = makeWorkspace()
    const dbFile = seededWorkspace(directories, (file) => { seedLegacyWorkflowControl(file, "legacy-session") })

    const result = prepareWorkspaceState(directories)

    try {
      expect(controlSkills(dbFile)).toEqual([])
      expect(controlPersonas(dbFile)).toEqual([])
      expect(adoptionCount(dbFile)).toBe(0)
    } finally {
      result.generation.release()
    }
  })

  it("isolates a malformed migration candidate without discarding workspace state", () => {
    const directories = makeWorkspace()
    const dbFile = seededWorkspace(directories, (file) => {
      seedLegacyWorkflowControl(file, "legacy-session")
      seedIdentitylessWorkflowControl(file, "malformed-session")
    })
    const malformedBefore = workflowControlPayload(dbFile, "malformed-session")

    const result = prepareWorkspaceState(directories)
    try {
      expect(controlSkills(dbFile)).toEqual([])
      expect(workflowControlPayload(dbFile, "malformed-session")).toBe(malformedBefore)
      expect(adoptionCount(dbFile)).toBe(0)
    } finally {
      result.generation.release()
    }
  })

  it("runs the stored-fact upgrades again only when a fact or an upgrade is new since they last ran", async () => {
    const directories = makeWorkspace()
    const dbFile = seededWorkspace(directories, (file) => { seedLegacyWorkflowControl(file, "legacy-session") })
    const open = () => {
      const upgrades: string[] = []
      const prepared = prepareWorkspaceState(directories, (reached) => { upgrades.push(startupPhase(reached).label) })
      prepared.generation.release()
      return upgrades
    }

    const first = open()
    expect(first.length).toBeGreaterThan(1)
    expect(controlSkills(dbFile)).toEqual([])

    // Nothing appended since: no pass runs, and the store gains no row.
    const head = headPosition(dbFile)
    expect(open()).toEqual([])
    expect(headPosition(dbFile)).toBe(head)

    // A new fact can need an upgrade, so every pass looks again.
    const store = createSqliteEventStore(dbFile)
    try {
      await createSessionManager({ projectRoot: directories.projectRoot, executionCwd: directories.projectRoot, store }).createChat({ name: "Chat" })
    } finally {
      store.close()
    }
    expect(open()).toEqual(first)
    expect(open()).toEqual([])

    // A release that adds a pass has not examined the store with it yet.
    const db = new Database(dbFile)
    try {
      db.query("update event set payload = json_remove(payload, '$.passes[0]') where type = 'workspace.facts.settled'").run()
    } finally {
      db.close()
    }
    expect(open()).toEqual(first)

    // A release that renames a pass's label, as it does when the pass changes
    // its id to examine rows below its old watermark, runs that pass again.
    const settle = new Database(dbFile)
    try {
      settle.query("update event set payload = replace(payload, 'retired self-review policy, refused rows', 'retired self-review policy') where type = 'workspace.facts.settled'").run()
    } finally {
      settle.close()
    }
    expect(open()).toEqual(first)
  })

  it("counts each stored-fact pass inside the upgrade step and holds the startup bar at that step", () => {
    const directories = makeWorkspace()
    seededWorkspace(directories, (file) => { seedLegacyWorkflowControl(file, "legacy-session") })
    const reached: StartupReached[] = []
    prepareWorkspaceState(directories, (step) => { reached.push(step) }).generation.release()

    expect(reached.length).toBeGreaterThan(1)
    const phases = reached.map(startupPhase)
    expect(phases[0]!.label).toBe(`Upgrading stored facts, pass 1 of ${phases.length}: agent input contracts`)
    for (const [index, phase] of phases.entries()) {
      expect(phase.label.startsWith(`Upgrading stored facts, pass ${index + 1} of ${phases.length}: `)).toBe(true)
      expect(phase.progress).toEqual(startupPhase({ step: "stored-facts" }).progress)
    }
  })

  it("builds the session-type index of a store from an older release once, in its own startup step", () => {
    const directories = makeWorkspace()
    const dbFile = seededWorkspace(directories, (file) => {
      const store = createSqliteEventStore(file)
      try {
        store.append({ aggregateId: "session:older", type: "older.fact", version: 1, timestamp: 1, actor: "flywheel", sessionId: "older", payload: {} })
      } finally {
        store.close()
      }
      const db = new Database(file)
      try {
        db.exec("drop index event_session_type_position_idx")
      } finally {
        db.close()
      }
    })
    const starts = [0, 1].map(() => {
      const reached: StartupReached[] = []
      prepareWorkspaceState(directories, (step) => { reached.push(step) }).generation.release()
      return reached.filter(({ step }) => step === "event-index")
    })

    expect(starts).toEqual([[{ step: "event-index" }], []])
    const db = new Database(dbFile, { readonly: true })
    try {
      expect(db.query("select 1 from sqlite_schema where name = 'event_session_type_position_idx'").get()).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it("records one adoption when two starts race the same workspace", async () => {
    const directories = makeWorkspace()
    const dbFile = seededWorkspace(directories, (file) => { seedLegacyWorkflowControl(file, "legacy-session") })

    await raceWithSecondStart(directories)

    expect(controlSkills(dbFile)).toEqual([])
    expect(adoptionCount(dbFile)).toBe(0)
  })
})

/** One prepared workspace holding the facts `seed` writes, with its generation
 *  released: every case below prepares it again, and a lease left open reads as
 *  a live owner of the generation that start inspects. */
function seededWorkspace(directories: ProjectDirectories, seed: (dbFile: string) => void): string {
  const prepared = prepareWorkspaceState(directories)
  try {
    seed(prepared.dbFile)
  } finally {
    prepared.generation.release()
  }
  return prepared.dbFile
}

/** Seed one chat session into the database at `dbFile`.
 *
 *  The facts are written into a workspace of their own and the settled file is
 *  copied into place, because a closed store's prepared statements keep its
 *  connection alive until they are collected: a database this process still
 *  holds open cannot be moved and read again. The copy is a file this process
 *  has never opened, which is what a start that retires a generation finds. */
async function seedChatSession(baseDir: string, dbFile: string): Promise<void> {
  const seedRoot = path.join(baseDir, "seed")
  const seedFile = path.join(seedRoot, "flywheel.sqlite")
  fs.mkdirSync(seedRoot, { recursive: true })
  const store = createSqliteEventStore(seedFile)
  try {
    await createSessionManager({ projectRoot: seedRoot, executionCwd: seedRoot, store }).createChat({ name: "Chat" })
  } finally {
    // Closing folds the write-ahead log back into the file, so the copy below
    // carries every fact the seed wrote.
    store.close()
  }
  fs.copyFileSync(seedFile, dbFile)
  fs.rmSync(seedRoot, { recursive: true, force: true })
}

/** Workflow control as it was committed before definition identity covered
 *  composed skills and reachable personas. */
function seedLegacyWorkflowControl(dbFile: string, sessionId: string): void {
  const projectRoot = retainedProject()
  const definitions = retainedDefinitions(projectRoot)
  const workflow = retiredFixtureWorkflow(definitions.captureRevision(), "debug", projectRoot)
  const revision = definitions.captureRevision()
  const view = retiredBuiltInDefinition("debug")
  if (!view) throw new Error("Test fixture needs the step-grammar view of the debug workflow")
  // The control that the last build before phases compiled, under the
  // identity that it recorded, at the sequence that its root counted.
  const identity = retiredStepIdentity(view, workflow, resolveWorkflowAgents(workflow), { skills: revision.skills, personas: revision.personas })
  const recorded = prePhaseControl("debug", identity)
  const control = { ...recorded, aggregateSeq: recorded.aggregateSeq + 1 }
  const { skills: _skills, personas: _personas, ...definitionIdentity } = identity
  const store = createSqliteEventStore(dbFile)
  try {
    store.append({
      aggregateId: workflowAggregateId(sessionId),
      type: "workflow.control.initialized",
      version: 2,
      timestamp: 1,
      actor: "flywheel",
      sessionId,
      payload: { control: { ...control, issues: [], seals: [], definitionIdentity } },
    })
  } finally {
    store.close()
  }
}

/** Prepare the workspace from a second thread while this one prepares it too. */
async function raceWithSecondStart(directories: ProjectDirectories): Promise<void> {
  const worker = new Worker(new URL("fixtures/prepare-workspace-state-worker.ts", import.meta.url), {
    workerData: { directories },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on("error", reject)
      worker.on("message", (message: { ready?: boolean; prepared?: boolean; error?: string }) => {
        if (message.ready) {
          worker.postMessage("prepare", [])
          const prepared = prepareWorkspaceState(directories)
          prepared.generation.release()
          return
        }
        if (message.prepared) resolve()
        else reject(new Error(message.error ?? "second start failed"))
      })
    })
  } finally {
    await worker.terminate()
  }
}

/** A staged control fact whose missing identity makes only that session unreadable. */
function seedIdentitylessWorkflowControl(dbFile: string, sessionId: string): void {
  const store = createSqliteEventStore(dbFile)
  try {
    store.append({
      aggregateId: workflowAggregateId(sessionId),
      type: "workflow.control.initialized",
      version: 2,
      timestamp: 1,
      actor: "flywheel",
      sessionId,
      payload: { control: {} },
    })
  } finally {
    store.close()
  }
}

function workflowControlPayload(dbFile: string, sessionId: string): string | undefined {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<{ payload: string }, [string]>(
      "select payload from event where aggregate_id = ? and type = 'workflow.control.initialized'",
    ).get(workflowAggregateId(sessionId))?.payload
  } finally {
    db.close()
  }
}

function controlSkills(dbFile: string) {
  return controlIdentityField(dbFile, "skills")
}

function controlPersonas(dbFile: string) {
  return controlIdentityField(dbFile, "personas")
}

function controlIdentityField(dbFile: string, field: string) {
  const db = new Database(dbFile, { readonly: true })
  try {
    const row = db.query<{ value: string | null }, []>(`
      select json_extract(payload, '$.control.definitionIdentity.${field}') as value
      from event where type = 'workflow.control.initialized'
    `).get()
    return row?.value === null || row?.value === undefined ? undefined : JSON.parse(row.value)
  } finally {
    db.close()
  }
}

function adoptionCount(dbFile: string): number {
  const db = new Database(dbFile, { readonly: true })
  try {
    const row = db.query<{ count: number }, []>(
      "select count(*) as count from event where type = 'workflow.definition_identity.migrated'",
    ).get()
    return row?.count ?? 0
  } finally {
    db.close()
  }
}

/** A fresh workspace and the directory authorities startup would publish for
 *  it. Each case owns its own project root and its own account state. */
function makeWorkspace(): ProjectDirectories {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return testDirectories(dir)
}

function flywheelDir(baseDir: string): string {
  return path.join(baseDir, ".flywheel")
}

/** Everything the project holds that is not the generation gate, sorted. */
function stateEntries(baseDir: string): string[] {
  return fs.readdirSync(flywheelDir(baseDir)).filter((name) => !name.startsWith("project-generation.lock")).sort()
}

function writeUnder(directory: string, name: string, content: string): void {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, name), content)
}

/** Stamp one database, creating it when it is not there yet, and leave it at
 *  rest: an uncheckpointed write-ahead log is a live writer's state, and a case
 *  that retires a generation from inside this process must hand the retirement
 *  the workspace a stopped release left, not a half-written one. */
function stampEpoch(dbFile: string, epoch: number): void {
  const db = new Database(dbFile, { create: true })
  try {
    db.exec(`PRAGMA user_version = ${epoch}`)
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } finally {
    db.close()
  }
}

function headPosition(dbFile: string): number {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<{ position: number }, []>("select coalesce(max(position), 0) as position from event").get()?.position ?? 0
  } finally {
    db.close()
  }
}

function readEpoch(dbFile: string): number {
  const db = new Database(dbFile)
  try {
    const row = db.query<{ user_version?: unknown }, []>("PRAGMA user_version").get()
    return typeof row?.user_version === "number" ? row.user_version : 0
  } finally {
    db.close()
  }
}
