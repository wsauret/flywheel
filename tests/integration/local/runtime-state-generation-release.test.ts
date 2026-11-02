import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { unguardedSpawnOwned } from "../../helpers/real-process-fixture.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { createLauncherScope } from "../../../src/infra/process-supervisor.js"
import { createTestRuntimeComposition } from "../../helpers/runtime-composition.js"
import { DebugLog } from "../../../src/infra/debug-log.js"

/** The embedded (in-process) host of the runtime composition: one shutdown
 *  barrier whose last step closes the event store and hands back this project's
 *  state generation. The generation is a descriptor-held lease recorded as a
 *  shared-holder entry stamped with the owning PID, so an entry left behind
 *  reads as a live owner for as long as the process runs and no later start may
 *  replace an old generation.
 *
 *  Construction is the other half of that contract: a composition that fails
 *  after preparation owns the generation and every resource it acquired since,
 *  so each failure below is injected at one construction point and the release
 *  of everything acquired before it is observed. */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-state-generation-"))

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function sharedHolders(projectRoot: string): string[] {
  const stateDirectory = path.join(projectRoot, ".flywheel")
  return fs.existsSync(stateDirectory)
    ? fs.readdirSync(stateDirectory).filter((entry) => entry.startsWith("project-generation.lock.shared"))
    : []
}

/** The construction points that acquire something the generation outlives: the
 *  event-store runtime, the MCP connections, the background Worker lane, the
 *  runner pool, and the account-global availability authority. */
type FailureStage = "event store layer" | "session manager" | "background lane" | "session store" | "app service"

let failAt: FailureStage | undefined
/** Injects the one outcome that makes the durable drain unsafe: a final batch the
 *  substrate refused. The lane reports it, and nothing later in the barrier may
 *  run over the events it stands for. */
let failDrain = false
const disposals: string[] = []

// Snapshots, not live namespaces: a module mock replaces the namespace binding
// too, so a delegating mock that read it back would call itself.
const realEventStoreEffect = await import("../../../src/infra/event-store-effect.js")
const realManager = await import("../../../src/orchestration/session/manager.js")
const realMcp = await import("../../../src/orchestration/modules/mcp/manager.js")
const realLane = await import("../../../src/orchestration/app-service/runtime-background-lane.js")
const realWriterLane = await import("../../../src/infra/event-store-writer-lane.js")
const realSessionStore = await import("../../../src/orchestration/session-store/store.js")
const realAppService = await import("../../../src/orchestration/app-service/app-service.js")
const realAvailability = await import("../../../src/orchestration/agent-runtime/llm/shared-provider-availability.js")
const realRoleProjection = await import("../../../src/orchestration/app-service/role-protocol-projection.js")
const realSessionAuth = await import("../../../src/orchestration/session/session-auth-profile.js")
const EventStoreLive = realEventStoreEffect.EventStoreLive
const createEventStoreWriterLane = realWriterLane.createEventStoreWriterLane
const createSessionManager = realManager.createSessionManager
const createMcpManager = realMcp.createMcpManager
const createRuntimeBackgroundLane = realLane.createRuntimeBackgroundLane
const createSessionStore = realSessionStore.createSessionStore
const createFlywheelAppService = realAppService.createFlywheelAppService
const disposeSharedProviderAvailability = realAvailability.disposeSharedProviderAvailability
const composeRoleProtocolProjection = realRoleProjection.composeRoleProtocolProjection
const createSessionAuthAdmission = realSessionAuth.createSessionAuthAdmission

/** The order in which a normal shutdown settles the role projection and the
 *  session auth admission it reads through. Separate from `disposals`, which
 *  records only what a failed construction rolls back. */
const shutdownSettlements: string[] = []

spyOn(realRoleProjection, "composeRoleProtocolProjection").mockImplementation((scope, deps) =>
  composeRoleProtocolProjection({
    ...scope,
    own: (name, value, dispose) => scope.own(name, value, async (owned) => {
      await dispose(owned)
      shutdownSettlements.push("role projection")
    }),
  }, deps))

spyOn(realSessionAuth, "createSessionAuthAdmission").mockImplementation((deps) => {
  const admission = createSessionAuthAdmission(deps)
  return { ...admission, dispose: async () => { shutdownSettlements.push("auth admission"); await admission.dispose() } }
})

spyOn(realEventStoreEffect, "EventStoreLive").mockImplementation((dbFile) =>
  failAt === "event store layer"
    ? Layer.effectContext(Effect.die(new Error("event store layer boom")))
    : Layer.merge(
      EventStoreLive(dbFile),
      Layer.effectDiscard(Effect.acquireRelease(Effect.void, () => Effect.sync(() => { disposals.push("event store") }))),
    ))

spyOn(realWriterLane, "createEventStoreWriterLane").mockImplementation((...args) => {
  const lane = createEventStoreWriterLane(...args)
  return { ...lane, dispose: async () => failDrain ? { kind: "failed" as const, error: { message: "substrate refused the final batch" }, acked: [] } : lane.dispose() }
})

spyOn(realManager, "createSessionManager").mockImplementation((options) => {
  if (failAt === "session manager") throw new Error("session manager boom")
  return createSessionManager(options)
})

spyOn(realMcp, "createMcpManager").mockImplementation((options) => {
  const manager = createMcpManager(options)
  return { ...manager, dispose: async () => { disposals.push("mcp"); await manager.dispose() } }
})

spyOn(realLane, "createRuntimeBackgroundLane").mockImplementation((projectRoot, options) => {
  if (failAt === "background lane") throw new Error("background lane boom")
  const lane = createRuntimeBackgroundLane(projectRoot, options)
  return { ...lane, dispose: async () => { disposals.push("background lane"); await lane.dispose() } }
})

spyOn(realSessionStore, "createSessionStore").mockImplementation((...args) => {
  if (failAt === "session store") throw new Error("session store boom")
  const store = createSessionStore(...args)
  return { ...store, disposeAll: async () => { disposals.push("session store"); await store.disposeAll() } }
})

spyOn(realAppService, "createFlywheelAppService").mockImplementation((deps) => {
  if (failAt === "app service") throw new Error("app service boom")
  return createFlywheelAppService(deps)
})

spyOn(realAvailability, "disposeSharedProviderAvailability").mockImplementation(async () => {
  disposals.push("availability")
  await disposeSharedProviderAvailability()
})

// This file's module mocks are process-global, so the injections are cleared
// after each test as well as before it: a test file that shares the process must
// not inherit an injected failure from the last test that ran here.
const clearInjections = (): void => {
  failAt = undefined
  failDrain = false
  disposals.length = 0
  shutdownSettlements.length = 0
}

beforeEach(clearInjections)
afterEach(clearInjections)

/** One project the composition prepares for itself, with an isolated account
 *  home so the availability authority it opens is this test's own file. */
function workspace(name: string) {
  const projectRoot = path.join(TMP, name)
  const accountHome = path.join(TMP, `${name}-home`)
  const userDataRoot = path.join(accountHome, ".flywheel")
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(userDataRoot, { recursive: true })
  const persistentProcessManager = createPersistentProcessManager()
  return {
    projectRoot,
    persistentProcessManager,
    options: {
      executionCwd: projectRoot,
      projectRoot,
      accountHome,
      userDataRoot,
      workerUrl: new URL("../../../src/orchestration/app-service/worker-entry.ts", import.meta.url).href,
      launcher: createLauncherScope({ spawnOwned: unguardedSpawnOwned(), adoptOwned: () => Promise.reject(new Error("no command is adopted here")) }),
      persistentProcesses: persistentProcessManager.client(),
      allowPersistentProcesses: false,
    },
  }
}

describe("runtime state generation ownership", () => {
  test("the embedded host owns the generation while live, releases it on dispose, and a later host reads back what it wrote", async () => {
    const { projectRoot, options, persistentProcessManager } = workspace("workspace")
    const composition = await createTestRuntimeComposition(options)
    let disposing = false
    let sessionId = ""
    try {
      expect(fs.existsSync(path.join(options.userDataRoot, "auth", "profiles", "default"))).toBe(true)

      expect(sharedHolders(projectRoot)).toHaveLength(1)

      const opened = await composition.client.dispatch({ type: "chat.open" })
      if (!opened.ok || !opened.sessionId) throw new Error("chat.open was refused")
      sessionId = opened.sessionId
      // A new chat holds empty authored role settings until a person picks a model.
      expect((await composition.client.query({ type: "roleSnapshot", sessionIds: [sessionId] })).views).toEqual([{ sessionId, view: expect.objectContaining({ assignments: {} }) }])
      // Named, so the session is deliberate state rather than a blank shell the
      // shutdown tombstones: what survives here is what the drain wrote.
      await composition.client.dispatch({ type: "session.rename", sessionId, title: "Kept Chat" })

      disposing = true
      await expect(composition.dispose({ clientsHold: false })).resolves.toEqual({ kind: "settled" })
      // The role projection resolves provider connections through admission, so
      // its pending pushes finish before admission refuses every later read.
      expect(shutdownSettlements).toEqual(["role projection", "auth admission"])
    } finally {
      // A failed assertion must not leave the host's handles open: Windows
      // refuses to remove a directory that a handle still holds.
      if (!disposing) await composition.dispose({ clientsHold: false })
    }

    expect(sharedHolders(projectRoot)).toEqual([])

    // The barrier's last phase and this member are the same release, so the host
    // that runs the barrier and then also asks for the state can never close
    // the descriptor twice.
    await composition.releaseState()

    expect(sharedHolders(projectRoot)).toEqual([])

    // The release was real and the drain was durable: a second host takes the
    // generation for itself and reads back the session the first one wrote.
    const reopened = await createTestRuntimeComposition(options)
    try {
      expect(sharedHolders(projectRoot)).toHaveLength(1)
      expect((await reopened.client.query({ type: "snapshot" })).rows.map((row) => row.id)).toEqual([sessionId])
    } finally {
      await reopened.dispose({ clientsHold: false })
    }
    expect(sharedHolders(projectRoot)).toEqual([])
    persistentProcessManager.releaseAll()
  }, 60_000)

  test("a writer lane that cannot drain blocks the state release", async () => {
    const { projectRoot, options, persistentProcessManager } = workspace("unsafe-drain")
    failDrain = true
    const composition = await createTestRuntimeComposition(options)

    const result = await composition.dispose({ clientsHold: false })

    expect(result).toMatchObject({ kind: "blocked", phase: "flush-durable-state" })
    // Events this process accepted and never wrote are still unwritten: handing
    // the generation back would let another start replace it over that loss.
    expect(sharedHolders(projectRoot)).toHaveLength(1)

    failDrain = false
    for (const phase of ["dispose-availability", "drain-clients", "close-client-streams"] as const) {
      const owners = composition.shutdown.owners[phase] ?? []
      await Promise.all(owners.map(async (owner) => { await owner.requestInterruption(); await owner.settled() }))
    }
    await composition.releaseState()
    expect(sharedHolders(projectRoot)).toEqual([])
    persistentProcessManager.releaseAll()
  }, 60_000)
})

/** Reverse acquisition order, one entry per resource acquired before the
 *  injected failure. The generation is not in this list: it is released last,
 *  and the shared-holder assertion is what proves that release. */
const EXPECTED_DISPOSALS: ReadonlyArray<readonly [FailureStage, readonly string[]]> = [
  ["event store layer", ["background lane"]],
  ["session manager", ["event store", "background lane"]],
  ["background lane", []],
  ["session store", ["event store", "background lane"]],
  ["app service", ["availability", "session store", "mcp", "event store", "background lane"]],
]

describe("a composition that fails after preparation", () => {
  test.each(EXPECTED_DISPOSALS)("releases the generation and everything acquired before %s", async (stage, expected) => {
    const { projectRoot, options, persistentProcessManager } = workspace(`fail-${stage.replaceAll(" ", "-")}`)
    failAt = stage
    const records: unknown[] = []
    const record = spyOn(DebugLog, "record").mockImplementation((entry) => {
      if (entry.type === "startup.finished") records.push(entry.payload)
    })
    try {
      await expect(createTestRuntimeComposition(options)).rejects.toThrow(`${stage} boom`)
      const failedStage = stage === "background lane" ? "prepare" : stage === "app service" ? "services" : "kernel"
      expect(records).toEqual(expect.arrayContaining([expect.objectContaining({
        owner: "project-execution",
        outcome: "failed",
        stages: expect.objectContaining({
          [failedStage]: expect.objectContaining({ status: "failed", count: 1, durationMs: expect.any(Number) }),
        }),
      })]))
      expect(disposals).toEqual([...expected])
      expect(sharedHolders(projectRoot)).toEqual([])
    } finally {
      record.mockRestore()
      persistentProcessManager.releaseAll()
    }
  }, 60_000)
})
