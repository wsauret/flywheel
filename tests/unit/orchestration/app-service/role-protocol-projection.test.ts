import { afterEach, describe, expect, test } from "bun:test"
import type { RuntimeUiPatchInput } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { composeRoleProtocolProjection, createRoleProtocolProjection } from "../../../../src/orchestration/app-service/role-protocol-projection.js"
import { createRuntimeOwnership } from "../../../../src/orchestration/app-service/runtime-ownership.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createWorkflowRunWriter } from "../../../../src/orchestration/modules/workflows/run-facts.js"
import { cleanupTmpRoot, makeDepsWithStore, makeTmpDir, publishTestWorkflow } from "../session/_session-manager-fixtures.js"
import { createRoleAssignmentReader, projectRoleAssignments } from "../../../../src/orchestration/app-service/role-assignment-projection.js"
import type { SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import type { ReplayedSession } from "../../../../src/orchestration/session/schemas.js"
import { roleCapture } from "../../../helpers/role-capture.js"
import { sessionServingLabel } from "../../../../src/protocol/role-protocol-types.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { authStatusCursor } from "../../../../src/protocol/auth-status-protocol-types.js"

function chat(model: string): ReplayedSession {
  return {
    label: "Chat",
    lastUpdated: "2026-08-31T00:00:00.000Z",
    lifecycleState: "active",
    executionCwd: "/scratch/flywheel-test",
    kind: "chat",
    command: "chat",
    conversationId: "conversation-1",
    roleAssignments: { defaults: {}, overrides: { chat: { model, effort: "medium" } } },
  }
}

afterEach(cleanupTmpRoot)

describe("role protocol projection", () => {
  test("does not publish a delayed read after disposal", async () => {
    const read = Promise.withResolvers<ReplayedSession | null>()
    const started = Promise.withResolvers<void>()
    let listener: ((change: SessionMetadataChange) => void) | undefined
    let held = false
    const published: RuntimeUiPatchInput[] = []
    const projection = createRoleProtocolProjection({
      manager: {
        subscribe: (onChange) => { listener = onChange; return () => { listener = undefined } },
      },
      readRoles: async () => {
        if (!held) return null
        started.resolve()
        return { assignments: projectRoleAssignments((await read.promise)?.roleAssignments?.overrides ?? {}) }
      },
      publish: (input) => { published.push(input); return { ...input, position: 1, prevPosition: 0 } },
    })
    await projection.snapshot("session-1")
    held = true
    listener?.({ kind: "changed", sessionIds: ["session-1"] })
    await started.promise
    const disposing = projection.dispose()
    read.resolve(chat("gpt-5"))
    await disposing
    expect(published).toEqual([])
    expect(listener).toBeUndefined()
  })
  test("publishes the current role snapshot for metadata changes and removals", async () => {
    const sessions = new Map<string, ReplayedSession>([["session-1", chat("gpt-5")]])
    const listeners = new Set<(change: SessionMetadataChange) => void>()
    const published: RuntimeUiPatchInput[] = []
    const projection = createRoleProtocolProjection({
      manager: {
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
      readRoles: async (sessionId) => ({ assignments: projectRoleAssignments(sessions.get(sessionId)?.roleAssignments?.overrides ?? {}) }),
      publish: (input) => {
        published.push(input)
        return { ...input, position: published.length, prevPosition: published.length - 1 }
      },
    })

    expect(await projection.snapshot("session-1")).toEqual({ assignments: { chat: { model: "gpt-5", effort: "medium" } } })

    sessions.set("session-1", chat("gpt-6"))
    for (const listener of listeners) listener({ kind: "changed", sessionIds: ["session-1"] })
    await Bun.sleep(0)
    sessions.delete("session-1")
    for (const listener of listeners) listener({ kind: "deleted", sessionId: "session-1" })
    await Bun.sleep(0)

    expect(published).toEqual([
      {
        cursor: { scope: "session", domain: "roles", sessionId: "session-1" },
        payload: { kind: "roles.updated", roles: { assignments: { chat: { model: "gpt-6", effort: "medium" } } } },
      },
      {
        cursor: { scope: "session", domain: "roles", sessionId: "session-1" },
        payload: { kind: "roles.removed" },
      },
    ])

    await projection.dispose()
    expect(listeners.size).toBe(0)
  })
  test.each(["explorer", "chat"])("publishes the %s child's runner selection and a viewer edit on the same cursor", async (roleId) => {
    let snapshot = { defaults: {}, overrides: {} }
    let listener: ((change: SessionMetadataChange) => void) | undefined
    const published: RuntimeUiPatchInput[] = []
    const changed = Promise.withResolvers<void>()
    const readRoles = createRoleAssignmentReader({
      readSession: async () => ({ kind: "subagent", roleAssignments: snapshot }),
      childRole: async () => ({ roleId }),
      capture: async () => roleCapture(["chat-model", "persona-model", "edited-model"], {
        chat: { model: "chat-model", effort: "low" },
        explorer: { model: "persona-model", effort: "high" },
      }),
      personas: async () => new Map(),
      inheritedRoles: async () => ({ defaults: {}, overrides: {} }),
      workflowSeat: async () => undefined,
      userDataRoot: "/scratch",
    })
    const projection = createRoleProtocolProjection({
      manager: { subscribe: (fn) => { listener = fn; return () => {} } },
      readRoles,
      publish: (input) => { published.push(input); changed.resolve(); return { ...input, position: 1, prevPosition: 0 } },
    })
    expect(sessionServingLabel(await projection.snapshot("child") ?? undefined)).toBe(roleId === "chat" ? "chat-model low" : "persona-model high")
    expect((await projection.snapshot("child"))?.serving?.slot).toEqual({ kind: "role", roleId })
    snapshot = { defaults: {}, overrides: { [roleId]: { model: "edited-model", effort: "medium" } } }
    listener?.({ kind: "changed", sessionIds: ["child"] })
    await changed.promise
    expect(published).toMatchObject([{
      cursor: { scope: "session", domain: "roles", sessionId: "child" },
      payload: { kind: "roles.updated", roles: { serving: { selection: { model: "edited-model", effort: "medium" } } } },
    }])
    expect(sessionServingLabel(await readRoles("child") ?? undefined)).toBe("edited-model medium")
    // A session Chat setting takes over a persona child, and becomes its serving seat.
    snapshot = { defaults: {}, overrides: { chat: { model: "chat-model", effort: "high" } } }
    expect((await readRoles("child"))?.serving).toEqual({ slot: { kind: "role", roleId: "chat" }, selection: { model: "chat-model", effort: "high" } })
    await projection.dispose()
  })
  test.each([3, 30])("a run settings change reads the run policy once for %s card rows", async (members) => {
    const { deps, store } = makeDepsWithStore(makeTmpDir())
    try {
      const manager = createSessionManager(deps)
      const workflowId = await publishTestWorkflow(manager)
      const requests = countStateRequests(deps.projectionReader)
      const ids = Array.from({ length: members }, (_, index) => `agent-${index}`)
      const published: string[] = []
      const settled = Promise.withResolvers<void>()
      const projection = composeRoleProtocolProjection(createRuntimeOwnership(() => {}), {
        manager: {
          subscribe: () => () => {},
          read: async (sessionId) => ({
            label: sessionId, lastUpdated: "2026-08-31T00:00:00.000Z", lifecycleState: "active", kind: "workflow-agent", command: "workflow-agent",
            conversationId: `${sessionId}-conversation`, launchedFrom: { parentSessionId: workflowId, toolUseId: "launch" },
            workflowMembership: { kind: "historical-follow-up", workflowId, followUpId: sessionId }, roleAssignments: { defaults: {}, overrides: {} },
          }),
        },
        publish: (input) => {
          if (input.cursor.domain === "roles") published.push(input.cursor.sessionId)
          if (published.length === members) settled.resolve()
          return { ...input, position: 1, prevPosition: 0 }
        },
        reader: requests.reader,
        userDataRoot: "/scratch",
        capture: async () => roleCapture(["chat-model"]),
        definitions: { personas: () => new Map() },
        bus: { addListener: () => {}, removeListener: () => {} },
        onStored: (listener) => store.onStored(listener),
        onProfilesChanged: () => async () => {},
      })
      for (const id of ids) await projection.snapshot(id)
      requests.take()
      const writer = createWorkflowRunWriter(deps.projectionReader, (...args) => manager.commitWorkflow(...args))
      expect(await writer.update(workflowId, (run) => ({ ...run, roleAssignments: { ...run.roleAssignments, overrides: { "workflow-agent": { model: "chat-model", effort: "high" } } } }))).toBeTruthy()
      await settled.promise
      expect(published.toSorted()).toEqual(ids.toSorted())
      expect(requests.take().map(({ method, aggregateId }) => [method, aggregateId])).toEqual([["readPage", `workflow:${workflowId}`]])
      await projection.dispose()
    } finally {
      store.close()
    }
  })
  test("a profile role edit and an auth publication burst each push every held reading once", async () => {
    const ids = ["chat-1", "chat-2", "chat-3"]
    let profiles: (() => void) | undefined
    let onPatch: ((event: FrontendEvent) => void) | undefined
    let onChange: ((change: SessionMetadataChange) => void) | undefined
    let published: string[] = []
    let drained = Promise.withResolvers<void>()
    const projection = composeRoleProtocolProjection(createRuntimeOwnership(() => {}), {
      manager: { subscribe: (listener) => { onChange = listener; return () => {} }, read: async () => chat("chat-model") },
      publish: (input) => {
        if (input.cursor.domain !== "roles") return { ...input, position: 1, prevPosition: 0 }
        if (input.cursor.sessionId === "sentinel") drained.resolve()
        else published.push(input.cursor.sessionId)
        return { ...input, position: 1, prevPosition: 0 }
      },
      reader: asAsyncEventReadSurface(inMemoryEventReader([])),
      userDataRoot: "/scratch",
      capture: async () => roleCapture(["chat-model"]),
      definitions: { personas: () => new Map() },
      bus: { addListener: (listener) => { onPatch = listener }, removeListener: () => {} },
      onStored: () => () => {},
      onProfilesChanged: (changed) => { profiles = changed; return async () => {} },
    })
    // A deletion queues behind every refresh on the same lane, so its patch
    // marks the point after which no refresh push remains.
    const pushes = async (trigger: () => void) => {
      published = []
      drained = Promise.withResolvers<void>()
      trigger()
      onChange?.({ kind: "deleted", sessionId: "sentinel" })
      await drained.promise
      return published.toSorted()
    }
    for (const id of ids) await projection.snapshot(id)
    expect(await pushes(() => profiles?.())).toEqual(ids)
    // One unscoped auth publication patches the defaults and then every session.
    expect(await pushes(() => {
      for (const scope of [{ kind: "defaults" } as const, ...ids.map((sessionId) => ({ kind: "session" as const, sessionId }))]) {
        onPatch?.({ type: "patch", patch: { cursor: authStatusCursor(scope), position: 1, prevPosition: 0, payload: { kind: "roles.removed" } } })
      }
    })).toEqual(ids)
    await projection.dispose()
  })
  test.each([3, 30])("a local edit reads only the changed session among %s card rows", async (members) => {
    let listener: ((change: SessionMetadataChange) => void) | undefined
    const requests = countStateRequests(asAsyncEventReadSurface(inMemoryEventReader([])))
    const completed = Promise.withResolvers<void>()
    const projection = createRoleProtocolProjection({
      manager: { subscribe: (fn) => { listener = fn; return () => {} } },
      readRoles: async (sessionId) => {
        await requests.reader.readSlice({ aggregateId: `session:${sessionId}`, limit: 1 })
        return { assignments: {} }
      },
      publish: (input) => { completed.resolve(); return { ...input, position: 1, prevPosition: 0 } },
    })
    for (let index = 0; index < members; index++) await projection.snapshot(`agent-${index}`)
    requests.take()
    listener?.({ kind: "changed", sessionIds: ["agent-0"] })
    await completed.promise
    expect(requests.take().map(({ aggregateId }) => aggregateId)).toEqual(["session:agent-0"])
    await projection.dispose()
  })
})
