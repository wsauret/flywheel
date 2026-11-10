import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, type AsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { authDir } from "../../../../src/infra/paths.js"
import { createRuntimeModelAssignmentService } from "../../../../src/orchestration/app-service/model-assignment-service.js"
import { CONFIG_DEFAULTS, FlywheelConfigSchema } from "../../../../src/orchestration/config/schema.js"
import { parseSchema } from "../../../helpers/schema-assertions.js"
import { roleSlot } from "../../../../src/orchestration/config/role-selection.js"
import type { RoleAssignments } from "../../../../src/orchestration/session/schemas.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { testDirectories } from "../../../helpers/directories.js"
import { chatEntry } from "./app-service-doubles.js"
import { availabilityOwner, managerDouble, type ManagerDouble } from "./model-assignment-service-fixtures.js"
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js"

const DEFAULT_ROLES = {
  chat: { model: "gpt-5.5", effort: "medium", provider: "openai_api" },
  "workflow-agent": { model: "gpt-5.5", effort: "high", provider: "openai_api" },
} satisfies RoleAssignments

const FULL_AVAILABILITY = await availabilityOwner(["workflows", "skills", "subagents", "learning", "background-commands"])
const EVENT_WRITER = {
  append: async () => { throw new Error("unused event writer") },
  appendBatch: async () => { throw new Error("unused event writer") },
  pruneSupersededEvents: async () => { throw new Error("unused event writer") },
} satisfies AsyncEventWriter

function modelAssignmentService(manager: ManagerDouble, defaults: RoleAssignments = DEFAULT_ROLES, availability = FULL_AVAILABILITY) {
  return createRuntimeModelAssignmentService({
    roleCaptureStore: manager,
    sessionStore: { get: (id: string) => id === "chat-new" ? chatEntry({ conversationId: "conv-new", description: "New Chat", outputBlocks: () => [] }) : undefined },
    projectRoot: "/scratch/flywheel-models-test",
    eventStore: asAsyncEventReadSurface(inMemoryEventReader([])),
    eventWriter: EVENT_WRITER,
    availability,
    moduleSelection: () => composeFirstPartyModules(),
    config: () => parseSchema(FlywheelConfigSchema, { profiles: { default: { roles: Object.fromEntries(Object.entries(defaults).map(([role, value]) => [role, { model: value.model, effort: value.effort }])) } } }),
    refreshConfig: async () => CONFIG_DEFAULTS,
    materializeDefaults: async () => defaults,
    configDepsForScope: () => ({
      userDataRoot: testDirectories("/scratch/flywheel-models-test").userDataRoot,
      authDirectory: () => authDir(testDirectories("/scratch/flywheel-models-test").userDataRoot, "default"),
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules(),
      authProfileId: () => "default",
      availableModels: new Map([["openai", new Set(["gpt-5.5", "gpt-5-mini"])]]),
      modelInfos: fakeModelsClient.modelInfos,
      config: CONFIG_DEFAULTS,
      providerModelEligibility: () => new Map(),
    }),
  })
}

describe("RuntimeModelAssignmentService", () => {
  test("materializes a transient chat before session-scoped model reads", async () => {
    const manager = managerDouble()
    const rows = await modelAssignmentService(manager).loadAssignments({ scope: { kind: "session", sessionId: "chat-new" }, slots: [roleSlot("chat")] })
    expect(manager.created()).toEqual([{ id: "chat-new", conversationId: "conv-new", name: "New Chat", initialState: "active", initialRoles: {} }])
    expect(rows[0]).toMatchObject({ label: "Chat", model: "gpt-5.5", effort: "medium" })
  })

  test("uses an existing session snapshot without rematerializing defaults", async () => {
    const manager = managerDouble()
    manager.seed("chat-new", { ...DEFAULT_ROLES, chat: { model: "gpt-5-mini", effort: "low", provider: "openai_api" } })
    const rows = await modelAssignmentService(manager).loadAssignments({ scope: { kind: "session", sessionId: "chat-new" }, slots: [roleSlot("chat")] })
    expect(manager.created()).toHaveLength(0)
    expect(rows[0]).toMatchObject({ model: "gpt-5-mini", effort: "low" })
  })

  test("re-reads an equivalent durable chat after a duplicate materialization race", async () => {
    const manager = managerDouble()
    manager.failNextCreateAfterWrite()
    const rows = await modelAssignmentService(manager).loadAssignments({ scope: { kind: "session", sessionId: "chat-new" }, slots: [roleSlot("chat")] })
    expect(manager.created()).toHaveLength(1)
    expect(rows[0]).toMatchObject({ model: "gpt-5.5", effort: "medium" })
  })

  test("session-scoped save on a transient chat writes the materialized snapshot", async () => {
    const manager = managerDouble()
    const result = await modelAssignmentService(manager).saveEffort({ scope: { kind: "session", sessionId: "chat-new" }, slot: roleSlot("chat"), model: "gpt-5-mini", effort: "low" })
    expect(result).toEqual({ label: "Chat" })
    expect((await manager.read("chat-new"))?.roleAssignments?.overrides.chat).toEqual({ model: "gpt-5-mini", effort: "low" })
  })

  test("a save clears a pinned provider in the session snapshot", async () => {
    const manager = managerDouble()
    manager.seed("chat-new", DEFAULT_ROLES)
    await modelAssignmentService(manager).saveEffort({ scope: { kind: "session", sessionId: "chat-new" }, slot: roleSlot("chat"), model: "gpt-5-mini", effort: "low" })
    expect((await manager.read("chat-new"))?.roleAssignments?.overrides.chat).toEqual({ model: "gpt-5-mini", effort: "low" })
  })

  test("the projected roster reads a file brief seat from the session snapshot", async () => {
    const manager = managerDouble()
    manager.seed("chat-new", { ...DEFAULT_ROLES, "brief.myflow.review": { model: "gpt-5-mini", effort: "low" } })
    const rows = await modelAssignmentService(manager).loadAssignments({ scope: { kind: "session", sessionId: "chat-new" }, slots: [roleSlot("chat"), roleSlot("explorer"), roleSlot("brief.myflow.review")] })
    expect(rows.map((row) => row.slot.roleId)).toEqual(["chat", "explorer", "brief.myflow.review"])
    expect(rows[2]).toMatchObject({ model: "gpt-5-mini", effort: "low" })
  })

  test("the projected roster keeps file brief seats but drops disabled persona roles", async () => {
    const service = modelAssignmentService(managerDouble(), DEFAULT_ROLES, await availabilityOwner(["skills"]))
    const rows = await service.loadAssignments({ scope: { kind: "session", sessionId: "chat-new" }, slots: [roleSlot("chat"), roleSlot("explorer"), roleSlot("brief.plan-flow.plan"), roleSlot("brief.plan-flow.plan.persona.explorer")] })
    expect(rows.map((row) => row.slot.roleId)).toEqual(["chat", "brief.plan-flow.plan"])
  })

  test("a reset answers only for the slots the selection still assigns", async () => {
    const service = modelAssignmentService(managerDouble(), DEFAULT_ROLES, await availabilityOwner(["skills"]))
    const result = await service.resetDefaults({ scope: { kind: "session", sessionId: "chat-new" }, slots: [roleSlot("chat"), roleSlot("explorer")] })
    expect(result.rows.map((row) => row.slot.roleId)).toEqual(["chat"])
  })
})
