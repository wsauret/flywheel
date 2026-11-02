import { expect, test } from "bun:test"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createSessionRoleResolver, ensureSessionRoleSnapshot, resolveSessionRoles } from "../../../../src/orchestration/config/session-role-resolver.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { roleCapture } from "../../../helpers/role-capture.js"
import { resolveWorkflowAgentRole } from "../../../../src/orchestration/config/role-selection.js"

const temporaryDirectory = temporaryDirectories()

test("captures empty authored settings once without materializing defaults", async () => {
  const root = temporaryDirectory("role-settings-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(root))
  try {
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
    const sessionId = await manager.createChat({ name: "new" })
    expect(await ensureSessionRoleSnapshot({ manager, sessionId })).toEqual({})
    expect(await ensureSessionRoleSnapshot({ manager, sessionId })).toEqual({})
    expect((await manager.read(sessionId))?.roleAssignments).toEqual({ defaults: {}, overrides: {} })
    expect(store.read({ aggregateId: `session:${sessionId}`, types: ["session.roles.snapshotted"] })).toHaveLength(1)
  } finally { store.close() }
})

test("replays a saved pair on resume, skips it whole when lost, and follows current profile policy without writes", async () => {
  const root = temporaryDirectory("role-resume-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(root))
  try {
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
    const sessionId = await manager.createChat({ name: "resume", initialRoles: { chat: { model: "saved-model", effort: "low" } } })
    let capture = roleCapture(["saved-model", "gpt-6.1-sol"], { chat: { model: "profile-model", effort: "high" } })
    const resolve = () => createSessionRoleResolver({ projectRoot: root, sessionId, reader: asAsyncEventReadSurface(store), capture: async () => capture })()
    const before = store.countByAggregate(`session:${sessionId}`)
    expect((await resolve()).get("chat")).toMatchObject({ model: "saved-model", effort: "low" })
    capture = roleCapture(["gpt-6.1-sol"], { chat: { model: "profile-model", effort: "high" } })
    expect((await resolve()).get("chat")).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" })
    await manager.removeRoleAssignment(sessionId, "chat")
    capture = roleCapture(["profile-model"], { chat: { model: "profile-model", effort: "high" } })
    expect((await resolve()).get("chat")).toMatchObject({ model: "profile-model", effort: "high" })
    capture = roleCapture(["next-profile-model"], { chat: { model: "next-profile-model", effort: "low" } })
    expect((await resolve()).get("chat")).toMatchObject({ model: "next-profile-model", effort: "low" })
    expect(store.countByAggregate(`session:${sessionId}`)).toBe(before + 1)
    expect((await manager.read(sessionId))?.roleAssignments).toEqual({ defaults: {}, overrides: {} })
  } finally { store.close() }
})

test("chooses the first whole session object before profile settings", async () => {
  const roles = await resolveSessionRoles({ defaults: {}, overrides: {
    "workflow-agent": { model: "saved-model", providerOptions: { openai: { text_verbosity: "low" } } },
  } }, roleCapture(["saved-model", "profile-model"], {
    "brief.review": { model: "profile-model", effort: "low", provider_options: { openai: { text_verbosity: "high" } } },
  }), "/scratch", ["brief.review"])
  expect(roles.get("brief.review")).toMatchObject({
    model: "saved-model", effort: "medium", providerOptions: { openai: { text_verbosity: "low" } },
  })
})

test("ignores profile brief settings but resolves authored record settings at each request", async () => {
  const profile = {
    "workflow-agent": { model: "gpt-6.1-sol", effort: "medium" as const },
    "brief.plan": { model: "retired-profile-model", effort: "low" as const },
    "brief.plan.at.worker": { model: "retired-profile-model", effort: "low" as const },
  }
  const snapshot = { defaults: {}, overrides: {} }
  const slots = ["brief.plan", "brief.plan.at.worker"]
  const roles = await resolveSessionRoles(snapshot, roleCapture(["gpt-6.1-sol", "retired-profile-model"], profile), "/scratch", slots)
  for (const slot of slots) expect(roles.get(slot)).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" })
  const saved = { defaults: {}, overrides: { "brief.plan.at.worker": { model: "saved-model", effort: "high" } } }
  expect((await resolveSessionRoles(saved, roleCapture(["saved-model"], profile), "/scratch", slots)).get("brief.plan.at.worker")).toMatchObject({ model: "saved-model", effort: "high" })
  expect((await resolveSessionRoles(saved, roleCapture(["claude-opus-5.5"], profile), "/scratch", slots)).get("brief.plan.at.worker")).toMatchObject({ model: "claude-opus-5.5", effort: "medium" })
})

test("keeps launch effort independent of an unreachable model, and resolves unfixed fields live", async () => {
  const snapshot = { defaults: {
    "brief.review.at.worker.effort": { effort: "max" },
    "brief.review.at.other.model": { model: "lost-model" },
  }, overrides: {} }
  const first = await resolveSessionRoles(snapshot, roleCapture(["gpt-6.1-sol"], { "workflow-agent": { model: "lost-model", effort: "low" } }), "/scratch")
  expect(first.get("brief.review.at.worker")).toMatchObject({ model: "gpt-6.1-sol", effort: "high" })
  expect(first.get("brief.review.at.other")).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" })
  const next = await resolveSessionRoles(snapshot, roleCapture(["claude-opus-5.5"]), "/scratch")
  expect(next.get("brief.review.at.worker")).toMatchObject({ model: "claude-opus-5.5", effort: "high" })
  expect(snapshot.defaults["brief.review.at.worker.effort"]).toEqual({ effort: "max" })
  const persona = await resolveSessionRoles(snapshot, roleCapture(["gpt-6-luna", "gpt-6.1-sol"], {
    explorer: { model: "gpt-6-luna", effort: "low" },
  }), "/scratch")
  expect(resolveWorkflowAgentRole({ briefId: "review", definitionId: "worker" }, persona, "explorer")).toMatchObject({
    model: "gpt-6-luna", effort: "high",
  })
})

test("returns no roles for a ready empty profile without inventing models or changing settings", async () => {
  expect(await resolveSessionRoles({ defaults: {}, overrides: { chat: { model: "lost", effort: "low" } } }, roleCapture([]), "/scratch")).toEqual(new Map())
})
