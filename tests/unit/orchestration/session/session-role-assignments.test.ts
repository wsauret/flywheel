import { afterEach, describe, expect, it } from "bun:test"
import { parseSchema, safeParse } from "../../../helpers/schema-assertions.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, type EventStore } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSessionMetadataProjection } from "../../../../src/orchestration/session/session-metadata-projection.js"
import { buildSessionRolesSnapshottedFact, parseSessionMetadataFact } from "../../../../src/orchestration/session/session-metadata-facts.js"
import { SessionSchema, type RoleAssignments, type Session } from "../../../../src/orchestration/session/schemas.js"
import { RoleSettingEntrySchema } from "../../../../src/infra/role-settings.js"
import { cleanupTmpRoot, makeTmpDir, minimalSession } from "./_session-manager-fixtures.js"
import { makeMetadataStore } from "./_session-metadata-test-helpers.js"

const ownedStores: EventStore[] = []
const T1 = "2026-03-20T10:00:00.000Z"
const T2 = "2026-03-20T10:01:00.000Z"
const T3 = "2026-03-20T10:02:00.000Z"
const chat = { model: "gpt-6.1-sol", effort: "medium", providerOptions: { openai: { text_verbosity: "low" } } } as const
const worker = { model: "claude-opus-5.5", effort: "high" }
const changed = { model: "gpt-6-astra", effort: "high" }
const settings: RoleAssignments = { chat, "workflow-agent": worker }

afterEach(() => {
  for (const store of ownedStores.splice(0)) store.close()
  cleanupTmpRoot()
})

function openStore(root = makeTmpDir()): EventStore {
  const store = createSqliteEventStore(resolveEventStoreDbFile(root))
  ownedStores.push(store)
  return store
}

function append(store: EventStore, id: string, type: string, payload: { [key: string]: unknown }, version: number): void {
  store.append({ aggregateId: `session:${id}`, type, version, timestamp: Date.now(), actor: "flywheel", sessionId: id, payload })
}

function created(store: EventStore, id: string, session: Session = minimalSession({ lastUpdated: T1 })): void {
  append(store, id, "session.created", session, 3)
}

describe("authored session settings", () => {
  it("accepts model-only and effort-only settings but rejects malformed current fields", () => {
    expect(parseSchema(RoleSettingEntrySchema, { effort: "high" })).toEqual({ effort: "high" })
    expect(parseSchema(RoleSettingEntrySchema, { model: "mid" })).toEqual({ model: "mid" })
    for (const invalid of [{ model: "" }, { effort: "" }, { provider: "old" }, { extra: true }, { providerOptions: { google: { temperature: 3 } } }]) {
      expect(safeParse(RoleSettingEntrySchema, invalid).success).toBe(false)
    }
    const parsed = parseSchema(SessionSchema, { ...minimalSession(), roleAssignments: { defaults: {}, overrides: settings } })
    expect(parsed.roleAssignments?.overrides.chat).toEqual(chat)
  })

  it("keeps only authored fields from a current snapshot", async () => {
    const store = openStore()
    created(store, "authored")
    const roles = { defaults: { "brief.build.at.worker.effort": { effort: "high" } }, overrides: { chat: { model: "saved-model" } } }
    append(store, "authored", "session.roles.snapshotted", { roles, lastUpdated: T2 }, 4)
    expect((await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()).sessions.authored?.roleAssignments).toEqual(roles)
  })

  it.each([1, 2])("converts flat version %s entries into saved overrides, including a tier setting", async (version) => {
    const store = openStore()
    created(store, "history")
    const roles = version === 1 ? { chat: { model: "mid", effort: "low", provider: "old" } } : { chat: { model: "mid", effort: "low" } }
    append(store, "history", "session.roles.snapshotted", { roles, lastUpdated: T2 }, version)
    const projection = createSessionMetadataProjection(asAsyncEventReadSurface(store))
    expect((await projection.replay()).sessions.history?.roleAssignments).toEqual({ defaults: {}, overrides: { chat: { model: "mid", effort: "low" } } })
    expect(store.countByAggregate("session:history")).toBe(2)
  })

  it("drops generated defaults from old session.created snapshots but preserves overrides and fixed fields", async () => {
    const store = openStore()
    const historical = {
      defaults: {
        chat,
        "brief.build.at.worker.effort": { model: "mid", effort: "high" },
        "brief.build.at.writer.model": { model: "mid", effort: "high" },
        "brief.build.at.judge": { model: "mid", effort: "high" },
      },
      overrides: { "workflow-agent": changed },
    }
    append(store, "history", "session.created", { ...minimalSession(), roleAssignments: historical }, 4)
    created(store, "snapshot")
    append(store, "snapshot", "session.roles.snapshotted", { roles: historical, lastUpdated: T2 }, 3)
    const state = await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()
    expect(state.sessions.history?.roleAssignments).toEqual({
      defaults: {
        "brief.build.at.worker.effort": { effort: "high" },
        "brief.build.at.writer.model": { model: "mid" },
        "brief.build.at.judge": { model: "mid", effort: "high" },
      }, overrides: { "workflow-agent": changed },
    })
    expect(state.sessions.snapshot?.roleAssignments).toEqual(state.sessions.history?.roleAssignments)
    expect(store.countByAggregate("session:snapshot")).toBe(2)
  })

  it("keeps old provider-bearing fact bytes readable but removes provider hints at recovery", async () => {
    const legacy = { type: "session.roles.updated", version: 1, actor: "flywheel", payload: { roleId: "chat", assignment: { ...chat, provider: "openai" }, lastUpdated: T2 } } as const
    expect(parseSessionMetadataFact(legacy)).toEqual(legacy)
    const store = openStore()
    created(store, "legacy")
    append(store, "legacy", "session.roles.snapshotted", { roles: settings, lastUpdated: T1 }, 2)
    append(store, "legacy", legacy.type, legacy.payload, legacy.version)
    expect((await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()).sessions.legacy?.roleAssignments?.overrides.chat).toEqual(chat)
  })

  it("canonicalizes old role keys and model spelling without repair facts", async () => {
    const store = openStore()
    created(store, "normalized")
    append(store, "normalized", "session.roles.snapshotted", { roles: { "step.build": { model: "claude-opus-5-5", effort: "high" } }, lastUpdated: T2 }, 2)
    expect((await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()).sessions.normalized?.roleAssignments?.overrides["brief.build"]?.model).toBe("claude-opus-5.5")
    expect(store.countByAggregate("session:normalized")).toBe(2)
  })
})

describe("session settings publication", () => {
  it("creates the authored snapshot atomically and refuses invalid current settings before writing", async () => {
    const root = makeTmpDir()
    const store = openStore(root)
    const metadata = makeMetadataStore(root, store)
    await metadata.create(minimalSession(), "new", settings)
    expect((await metadata.readOrThrow("new")).roleAssignments).toEqual({ defaults: {}, overrides: settings })
    expect(store.read({ aggregateId: "session:new" }).map(({ type, version }) => [type, version])).toEqual([["session.created", 6], ["session.roles.snapshotted", 4]])
    await expect(metadata.create(minimalSession(), "invalid", { chat: { model: "", effort: "high" } })).rejects.toThrow()
    expect(store.countByAggregate("session:invalid")).toBe(0)
  })

  it("captures once across stores and does not capture a missing session", async () => {
    const root = makeTmpDir()
    const first = makeMetadataStore(root, openStore(root))
    const second = makeMetadataStore(root, openStore(root))
    await first.create(minimalSession(), "capture")
    const outcomes = await Promise.all([first.captureRolesIfAbsent("capture", settings), second.captureRolesIfAbsent("capture", settings)])
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect(await first.captureRolesIfAbsent("missing", settings)).toBe(false)
    expect((await second.readOrThrow("capture")).roleAssignments).toEqual({ defaults: {}, overrides: settings })
  })

  it("updates, removes, and replaces settings with restart-safe replay", async () => {
    const root = makeTmpDir()
    const store = openStore(root)
    const metadata = makeMetadataStore(root, store)
    await metadata.create(minimalSession(), "mutate", settings)
    await metadata.updateRoleAssignment("mutate", "chat", changed)
    await metadata.removeRoleAssignment("mutate", "workflow-agent")
    expect((await metadata.readOrThrow("mutate")).roleAssignments).toEqual({ defaults: {}, overrides: { chat: changed } })
    const fixed = { "brief.build.at.worker.model": { model: "claude-opus-5-5" } }
    await metadata.replaceRoleSnapshot("mutate", fixed, { chat })
    expect((await makeMetadataStore(root, openStore(root)).readOrThrow("mutate")).roleAssignments).toEqual({ defaults: fixed, overrides: { chat } })
    expect(buildSessionRolesSnapshottedFact(fixed, T3).payload.roles).toEqual({ defaults: fixed, overrides: {} })
  })

  it("does not revive a deleted session when later settings exist", async () => {
    const store = openStore()
    created(store, "deleted")
    append(store, "deleted", "session.deleted", { lastUpdated: T2 }, 1)
    append(store, "deleted", "session.roles.updated", { roleId: "chat", assignment: changed, lastUpdated: T3 }, 4)
    const state = await createSessionMetadataProjection(asAsyncEventReadSurface(store)).replay()
    expect(state.sessions.deleted).toBeUndefined()
    expect(state.deleted.deleted).toBe(true)
  })
})
