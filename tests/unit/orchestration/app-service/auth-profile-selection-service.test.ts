import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { AuthProfileManager } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { createRuntimeAuthProfileSelectionService } from "../../../../src/orchestration/app-service/auth-profile-selection-service.js"
import { dispatchAuthMutation } from "../../../../src/orchestration/app-service/auth-mutations.js"
import { createSessionManager, type SessionManager } from "../../../../src/orchestration/session/manager.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import type { RoleAssignments, Session } from "../../../../src/orchestration/session/schemas.js"
import type { RuntimeAuthProfileWriteScope } from "../../../../src/protocol/auth-profile-selection-protocol-types.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { createAuthPublicationBaseline, createAuthStatusPublisher } from "../../../../src/orchestration/app-service/auth-publication.js"
import { createAuthStatusProjection } from "../../../../src/orchestration/app-service/auth-status-projection.js"
import { resolveAuthProfileScope } from "../../../../src/orchestration/app-service/auth-profile-scope.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import type { RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"
import { workflowRunReader, workflowRunWriter } from "../../../../src/orchestration/module-catalog.js"
import { createWorkflowAuthOwner } from "../../../../src/orchestration/workflow-host/auth-owner.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"

const temporaryDirectory = temporaryDirectories()

type SessionManagerDouble = Pick<SessionManager, "read" | "selectAuthProfileWithRoleSnapshot"> & { calls(): number }

function sessionDouble(projectRoot: string, fail = false): SessionManagerDouble {
  const session = sessionFixture(projectRoot)
  let calls = 0
  return {
    read: async (id) => id === "foreground" ? session : null,
    async selectAuthProfileWithRoleSnapshot() {
      calls += 1
      if (fail) throw new Error("foreground session is unavailable")
      return true
    },
    calls: () => calls,
  }
}

function sessionFixture(projectRoot: string): Session {
  const now = "2026-01-01T00:00:00.000Z"
  return {
    kind: "chat",
    command: "chat",
    conversationId: "conversation-1",
    label: "Foreground",
    lastUpdated: now,
    lifecycleState: "active",
    executionCwd: projectRoot,
  }
}

async function profileManager(env: { readonly FLYWHEEL_AUTH_PROFILE?: string } = {}) {
  const root = temporaryDirectory("auth-profile-selection-service-")
  const projectRoot = join(root, "project")
  const manager = new AuthProfileManager({ userDataRoot: root, projectRoot, env })
  await manager.create("Work")
  return { manager, projectRoot, userDataRoot: root }
}

const noWorkflow = async (): Promise<boolean> => { throw new Error("no workflow in this test") }

const prepareSessionTarget = async (): Promise<{ roles: RoleAssignments; publish: (scope: RuntimeAuthProfileWriteScope) => Promise<void> }> => ({
  roles: { chat: { model: "gpt-5.5", effort: "medium" } },
  publish: async () => {},
})

describe("runtime auth profile selection service", () => {
  // An agent of a workflow has no profile of its own: a profile created from
  // its view becomes its workflow's, which every agent of the run reads.
  test.each(["chat", "workflow-agent"] as const)("a %s-created profile reaches origin and observed scopes without selecting it elsewhere", async (kind) => {
    const { manager: profiles, projectRoot, userDataRoot } = await profileManager()
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const sessions = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
    const workflowId = kind === "workflow-agent" ? await publishTestWorkflow(sessions, { authProfileId: "default" }) : null
    const origin = workflowId === null ? await sessions.createChat({ name: "Origin" }) : await startTestWorkflowMember(sessions, store, workflowId)
    const other = await sessions.createChat({ name: "Other" })
    const runs = workflowRunReader(asAsyncEventReadSurface(store))
    const changes: string[] = []
    const published = new Map<string, RuntimeAuthView>()
    const bus = createRuntimeUiBus()
    bus.addListener((event) => {
      if (event.type !== "patch") return
      const patch = event.patch
      if (patch.cursor.scope === "session" && patch.payload.kind === "auth.changed") published.set(patch.cursor.sessionId, patch.payload.auth)
    })
    const initialProfile = profiles.inspect()
    const projection = createAuthStatusProjection({
      initialProfile,
      moduleSelection: () => composeFirstPartyModules([]),
      subscriptionSpendConsent: (profileId) => ({ kind: "unavailable", profileId, message: "Flywheel could not read this profile's paid-use settings. Paid use is off until it can." }),
      resolveProfile: (scope, defaults) => resolveAuthProfileScope(scope, defaults, sessions, runs, userDataRoot),
    })
    const publish = createAuthStatusPublisher({
      manager: sessions, runs, defaults: () => profiles.inspect(), userDataRoot, projection, attention: { state: () => {} },
      baseline: createAuthPublicationBaseline(), disposed: () => false, refreshChatDefault() {},
      bus,
    })
    const unsubscribe = sessions.subscribe((change) => { if (change.kind === "changed") changes.push(...change.sessionIds) })
    try {
      await projection.snapshot({ kind: "session", sessionId: other })
      const workflowAuth = createWorkflowAuthOwner({
        reader: runs, writer: workflowRunWriter(asAsyncEventReadSurface(store), sessions.commitWorkflow),
        profiles, userDataRoot, onSelected: async () => { await publish() },
      })
      const service = createRuntimeAuthProfileSelectionService({
        selectWorkflowProfile: (id, profileId) => workflowAuth.select(id, profileId),
        profileManager: profiles, sessionManager: sessions,
        prepareSessionTarget: async () => {
          await publish()
          return { roles: {}, publish: async () => { await publish() } }
        },
      })
      const result = await service.create({ type: "auth.profile.create", scope: { kind: "session", sessionId: origin }, displayName: "Created" })
      const descriptor = { id: result.id, displayName: "Created" }
      await bus.drain()
      expect(published.get(origin)?.profile).toMatchObject({ id: result.id, displayName: "Created" })
      expect(published.get(origin)?.profile.availableProfiles).toContainEqual(descriptor)
      expect(published.get(other)?.profile.availableProfiles).toContainEqual(descriptor)
      expect(published.get(other)?.profile.id).toBe(initialProfile.id)
      expect((await sessions.read(other))?.authProfileId).toBeUndefined()
      expect(changes).toEqual(workflowId === null ? [origin] : [])
      expect(profiles.inspect().id).toBe(initialProfile.id)
      if (workflowId !== null) {
        expect((await runs.read(workflowId))?.authProfileId).toBe(result.id)
        expect((await sessions.read(origin))?.authProfileId).toBeUndefined()
      }
    } finally { unsubscribe(); await bus.clear(); store.close() }
  })

  test("writes defaults before mirroring a named session", async () => {
    const { manager, projectRoot } = await profileManager()
    const sessions = sessionDouble(projectRoot)
    const service = createRuntimeAuthProfileSelectionService({ profileManager: manager, sessionManager: sessions, prepareSessionTarget, selectWorkflowProfile: noWorkflow })

    const result = await service.select({ type: "auth.profile.select", scope: { kind: "defaults-and-session", sessionId: "foreground" }, id: "work" })

    expect(result).toEqual({ id: "work", mirrored: true })
    expect((await manager.resolve()).source).toBe("sticky")
    expect(sessions.calls()).toBe(1)
  })

  test("returns refusals without mutating profiles when the environment locks selection", async () => {
    const setup = await profileManager()
    await setup.manager.create("Default")
    await setup.manager.select("default")
    const before = setup.manager.inspect()
    const locked = new AuthProfileManager({ userDataRoot: setup.userDataRoot, projectRoot: setup.projectRoot, env: { FLYWHEEL_AUTH_PROFILE: "Work" } })
    const sessions = sessionDouble(setup.projectRoot)
    const service = createRuntimeAuthProfileSelectionService({ profileManager: locked, sessionManager: sessions, prepareSessionTarget, selectWorkflowProfile: noWorkflow })

    const deps = { authProfileSelection: { ...service, settle: async () => {} } }
    for (const mutation of [
      { type: "auth.profile.select", scope: { kind: "defaults-and-session", sessionId: "foreground" }, id: "default" },
      { type: "auth.profile.create", scope: { kind: "defaults" }, displayName: "Created" },
      { type: "auth.profile.rename", scope: { kind: "defaults" }, id: "work", displayName: "Renamed" },
      { type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work", successorId: "default" },
    ] as const) {
      expect(await dispatchAuthMutation(deps, mutation)).toMatchObject({ ok: false, error: expect.stringContaining("environment-selected") })
      expect(setup.manager.inspect()).toEqual(before)
    }
    expect(sessions.calls()).toBe(0)
  })

  test.each(["defaults", "defaults-and-session"] as const)("names the effective project profile when %s saves a masked default", async (kind) => {
    const { manager, projectRoot } = await profileManager()
    await manager.create("Personal")
    await manager.bind("work")
    const sessions = sessionDouble(projectRoot)
    const service = createRuntimeAuthProfileSelectionService({ profileManager: manager, sessionManager: sessions, prepareSessionTarget, selectWorkflowProfile: noWorkflow })
    const scope = kind === "defaults" ? { kind } : { kind, sessionId: "foreground" }

    expect(await service.select({ type: "auth.profile.select", scope, id: "work" })).not.toHaveProperty("warning")
    const priorSessionCalls = sessions.calls()
    const result = await service.select({ type: "auth.profile.select", scope, id: "personal" })

    expect(result.warning).toBe("Default profile saved, but this project still uses Work because it is pinned.")
    expect(manager.inspect()).toMatchObject({ id: "work", source: "project", projectBinding: "work" })
    expect(sessions.calls() - priorSessionCalls).toBe(kind === "defaults" ? 0 : 1)
    await manager.unbind()
    expect(manager.inspect()).toMatchObject({ id: "personal", source: "sticky" })
    expect(await service.select({ type: "auth.profile.select", scope, id: "personal" })).not.toHaveProperty("warning")
  })

  test.each([false, true])("keeps the default when the named session mirror fails with project binding: %s", async (bound) => {
    const { manager, projectRoot } = await profileManager()
    if (bound) {
      await manager.create("Personal")
      await manager.bind("personal")
    }
    const sessions = sessionDouble(projectRoot, true)
    const service = createRuntimeAuthProfileSelectionService({ profileManager: manager, sessionManager: sessions, prepareSessionTarget, selectWorkflowProfile: noWorkflow })

    const result = await service.select({ type: "auth.profile.select", scope: { kind: "defaults-and-session", sessionId: "foreground" }, id: "work" })

    expect(result.mirrored).toBe(false)
    expect(result.warning).toContain("not updated")
    if (bound) {
      expect(result.warning).toContain("this project still uses Personal")
      expect(manager.inspect().id).toBe("personal")
      await manager.unbind()
    }
    expect(manager.inspect().id).toBe("work")
  })

  test("prepares the selected profile without changing defaults", async () => {
    const { manager, projectRoot } = await profileManager()
    const sessions = sessionDouble(projectRoot)
    const preparedProfiles: string[] = []
    const service = createRuntimeAuthProfileSelectionService({
      selectWorkflowProfile: noWorkflow,
      profileManager: manager,
      sessionManager: sessions,
      prepareSessionTarget: async (profileId) => {
        preparedProfiles.push(profileId)
        return prepareSessionTarget()
      },
    })

    await service.select({ type: "auth.profile.select", scope: { kind: "session", sessionId: "foreground" }, id: "work" })

    expect((await manager.resolve()).source).toBe("default")
    expect(sessions.calls()).toBe(1)
    expect(preparedProfiles).toEqual(["work"])
  })

  test("publishes the complete session scope after committing the decision", async () => {
    const { manager, projectRoot } = await profileManager()
    const sessions = sessionDouble(projectRoot)
    const order: string[] = []
    const published: RuntimeAuthProfileWriteScope[] = []
    const service = createRuntimeAuthProfileSelectionService({
      selectWorkflowProfile: noWorkflow,
      profileManager: manager,
      sessionManager: {
        ...sessions,
        async selectAuthProfileWithRoleSnapshot() {
          order.push("commit")
          return true
        },
      },
      prepareSessionTarget: async () => ({
        roles: { chat: { model: "gpt-5.5", effort: "medium" } },
        publish: async (scope) => { order.push("publish"); published.push(scope) },
      }),
    })

    await service.select({ type: "auth.profile.select", scope: { kind: "session", sessionId: "foreground" }, id: "work" })

    expect(order).toEqual(["commit", "publish"])
    expect(published).toEqual([{ kind: "session", sessionId: "foreground" }])
  })

  test("publishes the complete defaults-and-session scope", async () => {
    const { manager, projectRoot } = await profileManager()
    const published: RuntimeAuthProfileWriteScope[] = []
    const service = createRuntimeAuthProfileSelectionService({
      selectWorkflowProfile: noWorkflow,
      profileManager: manager,
      sessionManager: sessionDouble(projectRoot),
      prepareSessionTarget: async () => ({
        roles: { chat: { model: "gpt-5.5", effort: "medium" } },
        publish: async (scope) => { published.push(scope) },
      }),
    })

    await service.select({ type: "auth.profile.select", scope: { kind: "defaults-and-session", sessionId: "foreground" }, id: "work" })

    expect(published).toEqual([{ kind: "defaults-and-session", sessionId: "foreground" }])
  })

  test("publishes neither session fact when target preparation fails", async () => {
    const { manager, projectRoot } = await profileManager()
    const sessions = sessionDouble(projectRoot)
    const service = createRuntimeAuthProfileSelectionService({
      selectWorkflowProfile: noWorkflow,
      profileManager: manager,
      sessionManager: sessions,
      prepareSessionTarget: async () => { throw new Error("catalog unavailable") },
    })

    await expect(service.select({ type: "auth.profile.select", scope: { kind: "session", sessionId: "foreground" }, id: "work" })).rejects.toThrow("catalog unavailable")
    expect(sessions.calls()).toBe(0)
  })

  test("does not mirror when the default selection fails preflight", async () => {
    const { manager, projectRoot } = await profileManager()
    const sessions = sessionDouble(projectRoot)
    const service = createRuntimeAuthProfileSelectionService({ profileManager: manager, sessionManager: sessions, prepareSessionTarget, selectWorkflowProfile: noWorkflow })

    await expect(service.select({ type: "auth.profile.select", scope: { kind: "defaults-and-session", sessionId: "foreground" }, id: "missing" })).rejects.toThrow("auth profile does not exist")
    expect(sessions.calls()).toBe(0)
    expect((await manager.resolve()).source).toBe("default")
  })

  test("settles profile lifecycle before deletion and refreshes publication", async () => {
    const { manager, projectRoot } = await profileManager()
    let refreshCalls = 0
    const lifecycle: string[] = []
    const refresh = async () => { refreshCalls += 1 }
    const preRemoveProfile = async (profileId: string) => {
      lifecycle.push(`settled:${profileId}`)
      return () => { lifecycle.push(`removed:${profileId}`) }
    }
    const service = createRuntimeAuthProfileSelectionService({ profileManager: manager, sessionManager: sessionDouble(projectRoot), prepareSessionTarget, refresh, preRemoveProfile, selectWorkflowProfile: noWorkflow })
    expect(await service.previewDelete("work")).toEqual({ kind: "fresh-default", source: { id: "work", displayName: "Work" } })
    await manager.create("Personal")
    await expect(service.mutate({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work", successorId: null })).rejects.toThrow("preview changed")
    expect(await service.previewDelete("work")).toEqual({ kind: "automatic", source: { id: "work", displayName: "Work" }, successor: { id: "personal", displayName: "Personal" } })
    await manager.create("Other")
    expect(await service.previewDelete("work")).toEqual({ kind: "choose", source: { id: "work", displayName: "Work" }, candidates: [{ id: "other", displayName: "Other" }, { id: "personal", displayName: "Personal" }] })
    await service.mutate({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "personal", successorId: "other" })
    await expect(service.mutate({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work", successorId: "personal" })).rejects.toThrow("destination does not exist")
    const result = await service.delete({ type: "auth.profile.delete", scope: { kind: "defaults" }, id: "work", successorId: "other" })

    expect(result).toEqual({ id: "work" })
    expect(lifecycle).toEqual(["settled:personal", "removed:personal", "settled:work", "removed:work"])
    expect(refreshCalls).toBe(2)
  })

  test("retains the selected profile but clears session settings after switching A to B to A", async () => {
    const projectRoot = temporaryDirectory("flywheel-auth-profile-cascade-")
    const userDataRoot = join(projectRoot, "account")
    const profiles = new AuthProfileManager({ userDataRoot, projectRoot, env: {} })
    const firstProfile = await profiles.create("First")
    const secondProfile = await profiles.create("Second")
    const firstRoles: RoleAssignments = { chat: { model: "gpt-5.5", effort: "high" } }
    const secondRoles: RoleAssignments = { chat: { model: "gpt-5-mini", effort: "low" } }
    const rolesByProfile = new Map([[firstProfile, firstRoles], [secondProfile, secondRoles]])
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
    const sessionId = await manager.createChat({ name: "Profile cascade" })
    const service = createRuntimeAuthProfileSelectionService({
      selectWorkflowProfile: noWorkflow,
      profileManager: profiles,
      sessionManager: manager,
      prepareSessionTarget: async (profileId) => ({
        roles: rolesByProfile.get(profileId) ?? {},
        publish: async () => {},
      }),
    })

    await service.select({ type: "auth.profile.select", scope: { kind: "session", sessionId }, id: firstProfile })
    await service.select({ type: "auth.profile.select", scope: { kind: "session", sessionId }, id: secondProfile })
    await service.select({ type: "auth.profile.select", scope: { kind: "session", sessionId }, id: firstProfile })
    await service.select({ type: "auth.profile.select", scope: { kind: "defaults" }, id: secondProfile })
    store.close()

    const restartedStore = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    try {
      const restarted = await createSessionManager({ projectRoot, executionCwd: projectRoot, store: restartedStore }).read(sessionId)
      expect(restarted?.authProfileId).toBe(firstProfile)
      expect(restarted?.roleAssignments).toEqual({ defaults: {}, overrides: {} })
      const decisions = restartedStore.read({ aggregateId: `session:${sessionId}` }).filter((event) =>
        event.type === "session.auth.profile.selected" || event.type === "session.roles.snapshotted")
      expect(decisions.map((event) => event.type)).toEqual([
        "session.auth.profile.selected", "session.roles.snapshotted",
        "session.auth.profile.selected", "session.roles.snapshotted",
        "session.auth.profile.selected", "session.roles.snapshotted",
      ])
    } finally {
      restartedStore.close()
    }
  })
})
