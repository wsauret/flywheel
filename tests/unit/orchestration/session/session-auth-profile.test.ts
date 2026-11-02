import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncGuardedEventWriter, type EventStore, type EventStoreAppend } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSessionMetadataProjection, createSingleSessionMetadataProjection } from "../../../../src/orchestration/session/session-metadata-projection.js"
import { buildSessionMetadataAppend, createSessionMetadataStore } from "../../../../src/orchestration/session/session-metadata-store.js"
import { createSessionAuthAdmission, ensureSessionAuthProfile, resolveSessionAuthProfile } from "../../../../src/orchestration/session/session-auth-profile.js"
import type { AuthProfileResolution } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { cleanupTmpRoot, makeTmpDir, minimalSession } from "./_session-manager-fixtures.js"

const stores: EventStore[] = []
const T1 = "2026-03-20T10:00:00.000Z"

const auth = (overrides: Partial<AuthProfileResolution> = {}): AuthProfileResolution => ({
  id: "default",
  persistedId: "default",
  displayName: "Default",
  source: "default",
  directory: "/scratch/auth/default",
  availableProfiles: [{ id: "default", displayName: "Default" }],
  projectBinding: undefined,
  retirements: {},
  ...overrides,
})

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  cleanupTmpRoot()
})

describe("session auth profile authority", () => {
  test("retires session profiles and writes supplied roles as settings before the next immutable capture", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await metadata.create(minimalSession({ authProfileId: "default" }), "saved")
    let resolution = auth()
    let materializations = 0
    const roles = { chat: { model: "gpt-5.5", effort: "medium" as const } }
    const admission = createSessionAuthAdmission({
      manager: metadata,
      authProfiles: { inspect: () => resolution },
      materialize: async (id, profileId, expectedAuthProfileId) => {
        materializations += 1
        await metadata.selectAuthProfileWithRoleSnapshot(id, profileId, roles, { authProfileId: expectedAuthProfileId })
      },
      prepare: async (profileId) => {
        if (profileId === "work") expect((await metadata.readOrThrow("saved")).roleAssignments).toEqual({ defaults: {}, overrides: roles })
        return profileId
      },
    })
    const original = await admission.admit("saved")
    resolution = auth({ id: "work", persistedId: "work", retirements: { default: "work" }, availableProfiles: [{ id: "work", displayName: "Work" }] })
    expect(resolveSessionAuthProfile({}, { ...resolution, persistedId: "default" }).persistedId).toBe("work")
    expect((await admission.admit("saved")).workflowDeps).toBe("work")
    expect((await admission.admit("saved")).profile.persistedId).toBe("work")
    expect(materializations).toBe(1)
    expect(original.workflowDeps).toBe("default")
    expect(resolveSessionAuthProfile({ authProfileId: "default" }, { ...resolution, source: "environment", id: "work" })).toEqual({ persistedId: "work", effectiveId: "work" })
    await admission.dispose()
  })

  // The run owns its agents' profile: an agent admits on its run's profile
  // while the default is another one, and admission writes nothing onto the
  // agent, so the agent never holds a copy that can drift from its run.
  test("admits a workflow agent on its run's profile without writing a selection onto the agent", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await metadata.create({
      kind: "workflow-agent", command: "workflow-agent", conversationId: "member-conversation",
      label: "Member", lifecycleState: "active", lastUpdated: T1,
      launchedFrom: { parentSessionId: "parent", toolUseId: "launch" },
      workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt" },
    }, "agent")
    const resolution = auth({ availableProfiles: [{ id: "default", displayName: "Default" }, { id: "work", displayName: "Work" }] })
    const admission = createSessionAuthAdmission({
      manager: metadata,
      authProfiles: { inspect: () => resolution },
      materialize: async () => { throw new Error("Unexpected retirement") },
      prepare: async (profileId) => profileId,
      workflows: { snapshot: async (workflowId) => {
        expect(workflowId).toBe("run")
        return auth({ id: "work", persistedId: "work", availableProfiles: resolution.availableProfiles })
      } },
    })
    const admitted = await admission.admit("agent")
    expect(admitted.profile).toEqual({ persistedId: "work", effectiveId: "work" })
    expect(admitted.workflowDeps).toBe("work")
    expect(admission.current("agent")).toBe(admitted)
    expect((await metadata.readOrThrow("agent")).authProfileId).toBeUndefined()
    expect(store.read({ aggregateId: "session:agent", types: ["session.auth.profile.selected"] })).toEqual([])
    await admission.dispose()
  })

  test("does not replace an explicit selection with a delayed retirement snapshot", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await metadata.create(minimalSession({ authProfileId: "old" }), "saved")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let resolution = auth({ retirements: { old: "successor" }, availableProfiles: [
      { id: "successor", displayName: "Successor" },
    ] })
    const selection = ensureSessionAuthProfile({
      manager: metadata,
      sessionId: "saved",
      authProfiles: { inspect: () => resolution },
      materialize: async (id, profileId, expectedAuthProfileId) => {
        entered.resolve()
        await release.promise
        expect(await metadata.selectAuthProfileWithRoleSnapshot(id, profileId, {}, { authProfileId: expectedAuthProfileId })).toBe(false)
      },
    })
    await entered.promise
    resolution = { ...resolution, availableProfiles: [...resolution.availableProfiles, { id: "chosen", displayName: "Chosen" }] }
    const chosenRoles = { chat: { model: "gpt-5.5", effort: "medium" as const } }
    await metadata.selectAuthProfileWithRoleSnapshot("saved", "chosen", chosenRoles)
    release.resolve()
    expect(await selection).toEqual({ persistedId: "chosen", effectiveId: "chosen" })
    expect((await metadata.readOrThrow("saved")).authProfileId).toBe("chosen")
    expect((await metadata.readOrThrow("saved")).roleAssignments).toEqual({ defaults: {}, overrides: chosenRoles })
  })

  test("materializes a successor retired again while its roles are prepared", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await metadata.create(minimalSession({ authProfileId: "old" }), "saved")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let resolution = auth({ retirements: { old: "successor" }, availableProfiles: [{ id: "successor", displayName: "Successor" }] })
    const admission = createSessionAuthAdmission({
      manager: metadata,
      authProfiles: { inspect: () => resolution },
      materialize: async (id, profileId, expectedAuthProfileId) => {
        if (profileId === "successor") { entered.resolve(); await release.promise }
        const model = profileId === "successor" ? "gpt-5.5" : "gpt-6-luna"
        await metadata.selectAuthProfileWithRoleSnapshot(id, profileId, { chat: { model, effort: "medium" } }, { authProfileId: expectedAuthProfileId })
      },
      prepare: async (profileId) => {
        const saved = await metadata.readOrThrow("saved")
        expect(saved.authProfileId).toBe(profileId)
        expect(saved.roleAssignments).toEqual({ defaults: {}, overrides: { chat: { model: "gpt-6-luna", effort: "medium" } } })
        return profileId
      },
    })
    const pending = admission.admit("saved")
    await entered.promise
    resolution = { ...resolution, retirements: { old: "latest", successor: "latest" }, availableProfiles: [{ id: "latest", displayName: "Latest" }] }
    release.resolve()
    expect((await pending).workflowDeps).toBe("latest")
    await admission.dispose()
  })

  test("captures a legacy session profile once and projects it", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await metadata.create(minimalSession({ lastUpdated: T1 }), "legacy")

    expect(await metadata.captureAuthProfileIfAbsent("legacy", "default")).toBe(true)
    expect(await metadata.captureAuthProfileIfAbsent("legacy", "other")).toBe(false)
    expect((await metadata.readOrThrow("legacy")).authProfileId).toBe("default")
    expect(store.read({ aggregateId: "session:legacy", types: ["session.auth.profile.selected"] })).toHaveLength(1)

    await metadata.create(minimalSession({ lastUpdated: T1, authProfileId: "default" }), "current")
    expect(store.read({ aggregateId: "session:current" }).map((event) => event.type)).toEqual(["session.created", "session.auth.profile.selected"])

    store.append({ aggregateId: "session:legacy", type: "session.auth.profile.selected", version: 1, timestamp: Date.parse("2020-01-01T00:00:00.000Z"), actor: "flywheel", sessionId: "legacy", payload: { authProfileId: "default" } })
    store.append({ aggregateId: "session:legacy", type: "session.auth.profile.selected", version: 1, timestamp: Date.parse("2019-01-01T00:00:00.000Z"), actor: "flywheel", sessionId: "legacy", payload: { authProfileId: "other" } })
    expect((await metadata.readOrThrow("legacy")).authProfileId).toBe("other")
  })

  test("rejects profile and role selection when deletion wins the publication race", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const seed = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await seed.create(minimalSession({ lastUpdated: T1 }), "doomed")

    let releasePublication: (() => void) | undefined
    const publicationPaused = Promise.withResolvers<void>()
    const publicationRelease = new Promise<void>((resolve) => { releasePublication = resolve })
    const writer: AsyncGuardedEventWriter = {
      append: async (event) => store.append(event),
      appendBatch: async (events: readonly EventStoreAppend[]) => store.appendBatch(events),
      appendGuarded: async (event) => store.appendGuarded(event),
      appendBatchGuarded: async (events) => {
        if (events.some((event) => event.type === "session.auth.profile.selected")) {
          publicationPaused.resolve()
          await publicationRelease
        }
        return store.appendBatchGuarded(events)
      },
      pruneSupersededEvents: async (aggregateId, eventType) => store.pruneSupersededEvents(aggregateId, eventType),
    }
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer })
    const selection = metadata.selectAuthProfileWithRoleSnapshot("doomed", "work", {
      chat: { model: "gpt-5.5", effort: "medium" },
    })
    await publicationPaused.promise
    store.append(buildSessionMetadataAppend("doomed", {
      type: "session.deleted",
      version: 1,
      actor: "flywheel",
      payload: { lastUpdated: "2026-03-20T10:00:01.000Z" },
    }))
    releasePublication?.()

    expect(await selection).toBe(false)
    expect(store.read({ aggregateId: "session:doomed" }).map((event) => event.type)).toEqual([
      "session.created",
      "session.deleted",
    ])
  })

  test("uses the environment profile only as the effective id", () => {
    expect(resolveSessionAuthProfile({ authProfileId: "default" }, auth({
      id: "external",
      source: "environment",
      availableProfiles: [
        { id: "default", displayName: "Default" },
        { id: "external", displayName: "External" },
      ],
    }))).toEqual({ persistedId: "default", effectiveId: "external" })
  })

  test("rejects a stale synthetic Default after a stored profile replaces bootstrap state", () => {
    expect(() => resolveSessionAuthProfile({ authProfileId: "default" }, auth({
      id: "work",
      persistedId: "work",
      displayName: "Work",
      source: "sticky",
      availableProfiles: [{ id: "work", displayName: "Work" }],
    }))).toThrow("auth profile does not exist: default")
  })

  test("strictly quarantines malformed selected facts", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    store.append({
      aggregateId: "session:broken",
      type: "session.created",
      version: 3,
      timestamp: Date.parse(T1),
      actor: "flywheel",
      sessionId: "broken",
      payload: minimalSession({ lastUpdated: T1 }),
    })
    store.append({
      aggregateId: "session:broken",
      type: "session.auth.profile.selected",
      version: 1,
      timestamp: Date.parse(T1),
      actor: "flywheel",
      sessionId: "broken",
      payload: { authProfileId: "default", extra: true },
    })

    const state = await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()
    expect(state.sessions.broken).toBeUndefined()
    expect(state.errors.broken).toContain("unrecoverable session metadata")
  })

  test("awaits batch projection application before reporting success", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    const projection = createSessionMetadataProjection(asAsyncEventReadSurface(store))
    await metadata.list()
    const failure = new Error("projection failed")
    const apply = spyOn(projection, "apply").mockRejectedValue(failure)
    try {
      await expect(metadata.appendFacts([])).rejects.toThrow("projection failed")
    } finally {
      apply.mockRestore()
    }
  })

  test("concurrent legacy captures keep the first committed profile", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await metadata.create(minimalSession({ lastUpdated: T1 }), "race")
    expect(await Promise.all([
      metadata.captureAuthProfileIfAbsent("race", "first"),
      metadata.captureAuthProfileIfAbsent("race", "second"),
    ])).toEqual([true, false])
    expect((await metadata.readOrThrow("race")).authProfileId).toBe("first")
    expect(store.read({ aggregateId: "session:race", types: ["session.auth.profile.selected"] })).toHaveLength(1)
  })

  test("creates one complete metadata batch when duplicate ids race", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const first = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    const second = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    const session = minimalSession({ lastUpdated: T1, authProfileId: "work" })
    const roles = { chat: { model: "gpt-5.5", effort: "medium" as const } }

    const results = await Promise.allSettled([
      first.create(session, "duplicate", roles),
      second.create(session, "duplicate", roles),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(results.find((result) => result.status === "rejected")?.reason).toMatchObject({
      message: "Session already exists: duplicate",
    })
    expect(store.read({ aggregateId: "session:duplicate" }).map((event) => event.type)).toEqual([
      "session.created",
      "session.auth.profile.selected",
      "session.roles.snapshotted",
    ])
  })

  test("concurrent lifecycle transitions publish only one change", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await metadata.create(minimalSession({ lastUpdated: T1, lifecycleState: "inactive" }), "race")
    expect(await Promise.all([
      metadata.transitionLifecycle("race", "active"),
      metadata.transitionLifecycle("race", "active"),
    ])).toEqual([{ kind: "transitioned", from: "inactive", to: "active" }, { kind: "noop" }])
    expect(store.read({ aggregateId: "session:race", types: ["session.lifecycle.changed"] })).toHaveLength(1)
  })

  test("captures the auth sequence before a suspended read", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await metadata.create(minimalSession({ lastUpdated: T1 }), "race")
    const projection = createSingleSessionMetadataProjection(asAsyncEventReadSurface(store), "race")
    const stale = await projection.replay()
    const paused = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const replay = spyOn(projection, "replay").mockImplementationOnce(async () => {
      paused.resolve()
      await release.promise
      return stale
    })
    try {
      const capture = metadata.captureAuthProfileIfAbsent("race", "late")
      await paused.promise
      store.append(buildSessionMetadataAppend("race", {
        type: "session.auth.profile.selected", version: 1, actor: "flywheel",
        payload: { authProfileId: "winner" },
      }))
      release.resolve()
      expect(await capture).toBe(false)
      expect((await metadata.readOrThrow("race")).authProfileId).toBe("winner")
    } finally {
      release.resolve()
      replay.mockRestore()
    }
  })

  test("preserves user title arbitration and async scoped catalog reads", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await metadata.create(minimalSession({ lastUpdated: T1 }), "session")
    await Promise.all([
      metadata.updateLabel("session", { label: "Mine", shortLabel: "Mine" }, "user"),
      metadata.updateLabel("session", { label: "Generated", shortLabel: "Generated" }, "generated"),
    ])
    expect((await metadata.readOrThrow("session")).label).toBe("Mine")
    expect((await metadata.listForIds(["session", "session", "missing"])).entries.map(({ id }) => id)).toEqual(["session"])
    await metadata.create(minimalSession({ lastUpdated: "2026-03-20T10:00:01.000Z" }), "older")
    await metadata.create(minimalSession({ lastUpdated: "2026-03-20T10:00:02.000Z" }), "newer")
    expect((await metadata.listForIds(["older", "newer", "older"])).entries.map(({ id }) => id)).toEqual(["newer", "older"])
    expect(await metadata.read("missing")).toBeNull()
    await expect(metadata.readOrThrow("missing")).rejects.toThrow("Session not found: missing")
  })

  test("keeps the workspace projection out of targeted reads and writes", async () => {
    const root = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(root))
    stores.push(store)
    const metadata = createSessionMetadataStore({ reader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await metadata.create(minimalSession({ lastUpdated: T1 }), "session")
    const workspace = createSessionMetadataProjection(asAsyncEventReadSurface(store))
    const replay = spyOn(workspace, "replay").mockRejectedValue(new Error("workspace projection used"))
    try {
      expect(await metadata.read("session")).toMatchObject({ lifecycleState: "active" })
      expect(await metadata.updateLabel("session", { label: "Mine", shortLabel: "Mine" }, "user")).toBe(true)
      expect((await metadata.listForIds(["session"])).entries.map((entry) => entry.id)).toEqual(["session"])
    } finally {
      replay.mockRestore()
    }
  })
})
