import { describe, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import { DebugLog, type DebugLogRecordInput } from "../../../../src/infra/debug-log.js"
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { createProjectStateSessionManager, createProjectStateSessionsService } from "../../../../src/orchestration/app-service/project-state-sessions.js"
import { createSessionAutoDelete } from "../../../../src/orchestration/app-service/session-auto-delete.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, supervisorConversationFixture } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { publishTestSubagent } from "../session/_session-manager-fixtures.js"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { fakeProjections } from "./app-service-doubles.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"

type AutoDeletePorts = Parameters<typeof createSessionAutoDelete>[0]

/** Runs the first pass that the production owner makes once it is admitted,
 *  and answers how many chats the pass deleted, with the records it wrote.
 *  A pass with a positive age ends with its sweep record. */
async function sweepOnce(ports: AutoDeletePorts): Promise<{ readonly deleted: number; readonly records: readonly DebugLogRecordInput[] }> {
  const records: DebugLogRecordInput[] = []
  const swept = Promise.withResolvers<number>()
  const record = spyOn(DebugLog, "record").mockImplementation((input) => {
    records.push(input)
    if (input.type === "session.auto_delete.swept" && typeof input.payload === "object" && input.payload !== null && "deleted" in input.payload) swept.resolve(Number(input.payload.deleted))
  })
  const owner = createSessionAutoDelete(ports)
  try {
    owner.start()
    return { deleted: await swept.promise, records }
  } finally {
    record.mockRestore()
    await owner.dispose()
  }
}

/** Admits the production owner while its age setting is off, and lets its
 *  first pass run. The pass ends before it reads the catalog. */
async function sweepWhileOff(ports: AutoDeletePorts): Promise<void> {
  const owner = createSessionAutoDelete(ports)
  owner.start()
  await new Promise((resolve) => setTimeout(resolve, 1))
  await owner.dispose()
}

describe("automatic session deletion", () => {
  test("deletes old chats and owned children, keeps recent or active chats and independent forks, and does nothing while off", async () => {
    const ctx = createSupervisorTestContext()
    const config = await createRuntimeConfigOwner({ configPath: join(ctx.baseDir, "config.toml"), watch: false })
    const state = createProjectStateSessionsService(ctx.manager)
    const manager = createProjectStateSessionManager({ request: (command) => state.request(structuredClone(command)), subscribe: state.subscribe })
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx), manager })
    const now = Date.now()
    const old = now - 14 * 86_400_000
    const age = (id: string, timestamp: number, lifecycleState: "active" | "inactive") => ctx.store.append({
      aggregateId: `session:${id}`, sessionId: id, type: "session.lifecycle.changed", version: 1,
      actor: "flywheel", timestamp, payload: { lifecycleState, lastUpdated: new Date(timestamp).toISOString() },
    })
    try {
      await ctx.manager.createChat({ id: "old", initialState: "inactive" })
      await publishTestSubagent(ctx.manager, ctx.baseDir, "child", "old")
      age("old", old, "inactive")
      age("child", old, "inactive")
      const fork = await ctx.manager.createChatFromContext("old", [{ kind: "user", content: "Independent fork" }])
      await ctx.manager.createChat({ id: "recent", initialState: "inactive" })
      await ctx.manager.createChat({ id: "active" })
      age("active", old, "active")
      const service = createFlywheelAppService({
        projectRoot: ctx.baseDir,
        projection: createFrontendProjection({ sessionStore: ctx.sessionStore, manager, projectRoot: ctx.baseDir }),
        bus: createRuntimeUiBus(), ...fakeProjections(),
        runtimeSupervisor: supervisor,
      })
      const ports = { config, sessions: manager, deleteSession: async (sessionId: string, inactiveBefore: number) => {
        const result = await service.dispatch({ type: "session.delete", sessionId, inactiveBefore })
        if (!result.ok) throw new Error(result.error)
        return result.sessionRemoved === true
      }, now: () => now }
      await sweepWhileOff(ports)
      expect(await ctx.manager.read("old")).not.toBeNull()
      expect((await config.mutate("autoDeleteSessionDays", 0, 14)).ok).toBe(true)
      const failed = await sweepOnce({ ...ports, deleteSession: async () => { throw new Error("Store unavailable") } })
      expect(failed.deleted).toBe(0)
      expect(failed.records).toContainEqual({ type: "session.auto_delete.failed", sessionId: "old", notable: true, payload: { stage: "delete", thresholdDays: 14 } })
      const pass = await sweepOnce(ports)
      expect(pass.deleted).toBe(1)
      expect(await ctx.manager.read("old")).toBeNull()
      expect(await ctx.manager.read("child")).toBeNull()
      for (const id of ["recent", "active", fork]) expect(await ctx.manager.read(id)).not.toBeNull()
      const deletions = pass.records.filter((input) => input.type === "session.auto_delete.deleted")
      expect(deletions).toEqual([{ type: "session.auto_delete.deleted", sessionId: "old", payload: { inactiveDays: 14, thresholdDays: 14 } }])
      const again = await sweepOnce(ports)
      expect(again.deleted).toBe(0)
      expect(again.records.filter((input) => input.type === "session.auto_delete.deleted")).toHaveLength(0)
    } finally {
      await config.dispose()
      await supervisor.disposeAll()
      await disposeSupervisorTestContext(ctx)
    }
  })

  test("keeps an old chat when its child was used more recently", async () => {
    const ctx = createSupervisorTestContext()
    const config = await createRuntimeConfigOwner({ configPath: join(ctx.baseDir, "config.toml"), watch: false })
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx))
    try {
      await ctx.manager.createChat({ id: "parent", initialState: "inactive" })
      await publishTestSubagent(ctx.manager, ctx.baseDir, "child", "parent")
      await ctx.manager.updateLifecycleState("child", "inactive")
      ctx.store.append({ aggregateId: "session:parent", sessionId: "parent", type: "session.lifecycle.changed", version: 1, actor: "flywheel", timestamp: 1, payload: { lifecycleState: "inactive", lastUpdated: "2000-01-01T00:00:00.000Z" } })
      expect((await config.mutate("autoDeleteSessionDays", 0, 1)).ok).toBe(true)
      expect((await sweepOnce({ config, sessions: ctx.manager, deleteSession: supervisor.deleteSession })).deleted).toBe(0)
      expect(await ctx.manager.read("parent")).not.toBeNull()
      expect(await ctx.manager.read("child")).not.toBeNull()
      expect(supervisor.ownedSessionIds()).toEqual([])
      const admission = spyOn(ctx.manager, "admitDeletion").mockRejectedValueOnce(new Error("Admission unavailable"))
      expect((await sweepOnce({ config, sessions: ctx.manager, deleteSession: supervisor.deleteSession })).deleted).toBe(0)
      expect(supervisor.ownedSessionIds()).toEqual([])
      admission.mockRestore()
    } finally {
      await config.dispose()
      await supervisor.disposeAll()
      await disposeSupervisorTestContext(ctx)
    }
  })

  test("starts only after admission, runs on setting changes, and stops on disposal", async () => {
    const ctx = createSupervisorTestContext()
    const config = await createRuntimeConfigOwner({ configPath: join(ctx.baseDir, "config.toml"), watch: false })
    const list = spyOn(ctx.manager, "listMetadata")
    const intervals = spyOn(globalThis, "setInterval")
    const owner = createSessionAutoDelete({ config, sessions: ctx.manager, deleteSession: async () => false })
    try {
      await config.mutate("autoDeleteSessionDays", 0, 1)
      expect(list).not.toHaveBeenCalled()
      owner.start()
      await new Promise((resolve) => setTimeout(resolve, 1))
      expect(list).toHaveBeenCalledTimes(1)
      await config.mutate("autoDeleteSessionDays", 1, 2)
      expect(list).toHaveBeenCalledTimes(2)
      await new Promise((resolve) => setTimeout(resolve, 1))
      const daily = intervals.mock.calls.at(-1)
      if (!daily || typeof daily[0] !== "function") throw new Error("missing daily timer")
      expect(daily[1]).toBe(86_400_000)
      daily[0]()
      await new Promise((resolve) => setTimeout(resolve, 1))
      expect(list).toHaveBeenCalledTimes(3)
      await owner.dispose()
      await config.mutate("autoDeleteSessionDays", 2, 3)
      expect(list).toHaveBeenCalledTimes(3)
    } finally {
      await owner.dispose()
      list.mockRestore()
      intervals.mockRestore()
      await config.dispose()
      await disposeSupervisorTestContext(ctx)
    }
  })

  test("a refused cold deletion keeps the actor acquired by a concurrent activation", async () => {
    const ctx = createSupervisorTestContext()
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId) }),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    })
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const admitDeletion = ctx.manager.admitDeletion
    const admission = spyOn(ctx.manager, "admitDeletion").mockImplementation(async (...args) => {
      entered.resolve()
      await resume.promise
      return admitDeletion(...args)
    })
    try {
      await ctx.manager.createChat({ id: "reopened", initialState: "inactive" })
      await supervisorConversationFixture(() => ctx).commitUserTurn("reopened")
      await publishTestSubagent(ctx.manager, ctx.baseDir, "child", "reopened")
      await ctx.manager.updateLifecycleState("child", "inactive")
      ctx.store.append({ aggregateId: "session:reopened", sessionId: "reopened", type: "session.lifecycle.changed", version: 1, actor: "flywheel", timestamp: 1, payload: { lifecycleState: "inactive", lastUpdated: "2000-01-01T00:00:00.000Z" } })
      const deletion = supervisor.deleteSession("reopened", Date.now() - 86_400_000)
      await entered.promise
      const activation = supervisor.activateSession("reopened")
      resume.resolve()
      expect(await deletion).toBe(false)
      expect(await activation).toBe(true)
      expect(supervisor.ownedSessionIds()).toEqual(["reopened"])
      expect(ctx.sessionStore.has("reopened")).toBe(true)
      expect(await supervisor.sendChat("reopened", "Still open")).toEqual({ ok: true })
    } finally {
      resume.resolve()
      admission.mockRestore()
      await supervisor.disposeAll()
      await disposeSupervisorTestContext(ctx)
    }
  })
})
