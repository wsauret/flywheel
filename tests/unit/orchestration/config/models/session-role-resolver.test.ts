import { expect, spyOn, test } from "bun:test"
import { createSqliteEventStore } from "../../../../../src/infra/store/sqlite-event-store.js"
import { asAsyncEventReadSurface } from "../../../../../src/infra/store/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { createSessionManager } from "../../../../../src/orchestration/session/manager.js"
import { ensureSessionRoleSnapshot } from "../../../../../src/orchestration/config/models/session-role-resolver.js"
import { createSessionRoleResolver, resolveSessionRoles } from "../../../../../src/orchestration/agent-runtime/request/roles/session-roles.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { roleCapture } from "../../../../helpers/role-capture.js"
import { resolveWorkflowAgentRole } from "../../../../../src/orchestration/config/models/role-selection.js"
import { resolveCapturedRole } from "../../../../../src/orchestration/config/models/role-resolution.js"
import type { RoleSettings } from "../../../../../src/orchestration/session/metadata/schemas.js"
import { Redacted } from "effect"
import { captureProviderConnection } from "../../../../../src/infra/auth/auth-context.js"
import { testAuthContext } from "../../../../helpers/auth-context.js"
import { modelInfo } from "../../../../helpers/model-tier-fixtures.js"
import { testEligibility, testProviderRegistry } from "../../../../helpers/provider-authority.js"

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

test("replays a saved pair on resume, keeps it when lost (PI-MODEL-087), and follows current profile policy without writes", async () => {
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
    expect((await resolve()).get("chat")).toMatchObject({ model: "saved-model", effort: "low" })
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
  expect((await resolveSessionRoles(saved, roleCapture(["claude-opus-5.5"], profile), "/scratch", slots)).get("brief.plan.at.worker")).toMatchObject({ model: "saved-model", effort: "high" })
})

test("keeps a default effort and an unreachable saved model, and resolves unset fields live", async () => {
  const snapshot = { defaults: {
    "brief.review.at.worker.effort": { effort: "max" },
    "brief.review.at.other.model": { model: "lost-model" },
  }, overrides: {} }
  const first = await resolveSessionRoles(snapshot, roleCapture(["gpt-6.1-sol"], { "workflow-agent": { model: "lost-model", effort: "low" } }), "/scratch")
  expect(first.get("brief.review.at.worker")).toMatchObject({ model: "lost-model", effort: "high" })
  expect(first.get("brief.review.at.other")).toMatchObject({ model: "lost-model" })
  const next = await resolveSessionRoles(snapshot, roleCapture(["claude-opus-5.5"]), "/scratch")
  expect(next.get("brief.review.at.worker")).toMatchObject({ model: "claude-opus-5.5", effort: "high" })
  expect(snapshot.defaults["brief.review.at.worker.effort"]).toEqual({ effort: "max" })
  const persona = await resolveSessionRoles(snapshot, roleCapture(["gpt-6-luna", "gpt-6.1-sol"], {
    explorer: { model: "gpt-6-luna", effort: "low" },
  }), "/scratch", [], undefined, new Map([["worker", { roles: ["explorer"] }]]))
  expect(resolveWorkflowAgentRole({ briefId: "review", definitionId: "worker" }, persona, "explorer")).toMatchObject({
    model: "gpt-6-luna", effort: "high",
  })
})

test("ranks a person's setting for the agent or its workflow above the workflow's default", async () => {
  const run = (overrides = {}) => ({ defaults: {
    "brief.review.at.worker.model": { model: "record-model" },
    "brief.review.at.other": { model: "record-model", effort: "low" },
    "brief.review.at.third.effort": { effort: "max" },
  }, overrides })
  const own = (overrides = {}) => ({ defaults: {}, overrides })
  const capture = () => roleCapture(["record-model", "gpt-6-luna"], { "workflow-agent": { model: "gpt-6-luna", effort: "medium" } })
  const resolve = async (inherited: ReturnType<typeof run>, snapshot: ReturnType<typeof own>) => resolveSessionRoles(snapshot, capture(), "/scratch", [], inherited)
  const unset = await resolve(run(), own())
  expect(unset.get("brief.review.at.worker")).toMatchObject({ model: "record-model", effort: "medium" })
  expect(unset.get("brief.review.at.other")).toMatchObject({ model: "record-model", effort: "low" })
  // An effort-only setting keeps the default model.
  expect((await resolve(run(), own({ "brief.review.at.worker": { effort: "high" } }))).get("brief.review.at.worker"))
    .toMatchObject({ model: "record-model", effort: "high" })
  const agent = await resolve(run(), own({
    "brief.review.at.other": { model: "gpt-6-luna", effort: "high" },
    "brief.review.at.third": { model: "record-model", effort: "low" },
  }))
  expect(agent.get("brief.review.at.other")).toMatchObject({ model: "gpt-6-luna", effort: "high" })
  expect(agent.get("brief.review.at.third")).toMatchObject({ model: "record-model", effort: "low" })
  expect((await resolve(run({ "brief.review": { model: "gpt-6-luna", effort: "low" } }), own())).get("brief.review.at.other"))
    .toMatchObject({ model: "gpt-6-luna", effort: "low" })
  // A person's persona setting ranks above the default; the profile's persona
  // setting fills only the fields that the default leaves unset.
  const personas = new Map(["worker", "other", "third"].map((id) => [id, { roles: ["explorer"] }]))
  const asPersona = async (overrides: RoleSettings, profile = {}) => {
    const roles = await resolveSessionRoles(own(overrides), roleCapture(["record-model", "gpt-6-luna"], profile), "/scratch", [], run(), personas)
    return (definitionId: string) => resolveWorkflowAgentRole({ briefId: "review", definitionId }, roles, "explorer")
  }
  const saved = await asPersona({ explorer: { model: "gpt-6-luna", effort: "high" } })
  for (const id of ["worker", "other", "third"]) expect(saved(id)).toMatchObject({ model: "gpt-6-luna", effort: "high" })
  const profiled = await asPersona({}, { explorer: { model: "gpt-6-luna", effort: "low" }, "workflow-agent": { model: "record-model", effort: "medium" } })
  expect(profiled("worker")).toMatchObject({ model: "record-model", effort: "low" })
  // gpt-6-luna takes the default effort max at its nearest supported effort.
  expect(profiled("third")).toMatchObject({ model: "gpt-6-luna", effort: "high" })
})

test("returns only the saved seat for a ready empty profile, without inventing models or changing settings", async () => {
  const roles = await resolveSessionRoles({ defaults: {}, overrides: { chat: { model: "lost", effort: "low" } } }, roleCapture([]), "/scratch")
  expect([...roles.keys()]).toEqual(["chat"])
  expect(roles.get("chat")).toMatchObject({ model: "lost", effort: "low" })
})

test("a request's session roles and its serving role share one catalog of the capture, which plans each model once", async () => {
  const models = ["gpt-6.1-sol", "gpt-6-luna", "claude-opus-5.5"]
  const capture = roleCapture(models)
  const plan = spyOn(capture.providers.selection, "plan")
  try {
    const access = { selection: capture.providers.selection, connection: capture.connection, eligibility: capture.eligibility, allowTrainingRoutes: capture.runtimeConfig.allowTrainingRoutes }
    const roles = await resolveSessionRoles({ defaults: {}, overrides: {} }, capture, "/scratch")
    const serving = await resolveCapturedRole("chat", { model: "claude-opus-5.5", effort: "high" }, access, "/scratch")
    expect(roles.get("chat")?.model).toBeDefined()
    expect(serving.kind === "selected" ? serving.role.model : serving.kind).toBe("claude-opus-5.5")
    expect(plan).toHaveBeenCalledTimes(models.length)

    // A new capture of the same models is a new catalog.
    await resolveSessionRoles({ defaults: {}, overrides: {} }, { ...capture, connection: { ...capture.connection } }, "/scratch")
    expect(plan).toHaveBeenCalledTimes(2 * models.length)
  } finally {
    plan.mockRestore()
  }
})

test("an unsaved role's tier fallback prefers a model that a subscription offers on included quota over a newer one that only a paid route offers", async () => {
  const auth = testAuthContext({ oauth: ["chatgpt"], apiKeys: { openai_api: "key" } })
  const subscription = { instanceId: "account", credential: { type: "oauth", access: Redacted.make("access"), refresh: Redacted.make("refresh"), expires: 0 } } as const
  const released = new Map([["gpt-paid-newer", "2026-10-01"], ["gpt-included-older", "2026-05-01"]])
  const resolved = await resolveCapturedRole("chat", {}, {
    selection: testProviderRegistry().selection,
    connection: captureProviderConnection({ profileId: "default", authDir: "/scratch/auth", auth, subscriptionCredentials: new Map([["chatgpt", [subscription]]]) }),
    eligibility: testEligibility({
      modelIds: new Set(released.keys()),
      candidateOfferings(candidate, model) {
        const date = released.get(model)
        const offers = candidate.providerId === "openai_api" || (model === "gpt-included-older" && candidate.spendMode === "included")
        if (date === undefined || !offers) return []
        return [{ candidate, wireModelId: model, dataUse: "standard", transport: "openai-responses", resolvedModelMetadata: { ...modelInfo("openai", model, "fixture", 2, 8, date), reasoningEfforts: ["low", "medium", "high"] } }]
      },
    }),
    allowTrainingRoutes: false,
  }, "/scratch")
  expect(resolved.kind === "selected" ? resolved.role.model : resolved.kind).toBe("gpt-included-older")
})
