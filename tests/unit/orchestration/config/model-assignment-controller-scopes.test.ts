import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createModelAssignmentController } from "../../../../src/orchestration/config/models/model-assignment-controller.js"
import { ConfigStaleWriteError } from "../../../../src/orchestration/config/writer.js"
import type { ModelPickerConfigDeps } from "../../../../src/orchestration/config/models/model-assignment-types.js"
import { createSessionManager, type SessionManager } from "../../../../src/orchestration/session/manager.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/module-contract/module-composition.js"
import { installedConfigSchema, type FlywheelConfig } from "../../../../src/orchestration/config/schema/schema.js"
import { parseSchema } from "../../../helpers/schema-assertions.js"
import { roleSlot, type AgentPersonaRoles } from "../../../../src/orchestration/config/models/role-selection.js"
import { cleanupTmpRoot, makeDepsWithStore, makeTmpDir, publishTestSubagent, publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"
import { createRoleAssignmentReader } from "../../../../src/orchestration/app-service/auth/models/role-assignment-projection.js"
import type { AgentPersonas } from "../../../../src/orchestration/session/metadata/frontend-attempts.js"
import { sessionServingSelection } from "../../../../src/protocol/auth/role-protocol-types.js"
import { roleCapture } from "../../../helpers/role-capture.js"
import { modelInfo, makeModelsClient } from "../../../helpers/model-tier-fixtures.js"
import { testAuthContext } from "../../../helpers/auth-context.js"
import type { LocalSqliteEventStore } from "../../../../src/infra/store/event-store-types.js"
import { workflowRunReader } from "../../../../src/orchestration/module-contract/module-catalog.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/store/event-store-types.js"
import type { RoleAssignmentSnapshot } from "../../../../src/orchestration/session/metadata/schemas.js"

const models = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "claude-opus-5.5"]
const metadata = makeModelsClient(Object.fromEntries(models.map((model) => [model, modelInfo(model.startsWith("claude") ? "anthropic" : "openai", model, "fixture", 2, 8, "2026-10-01")])))
const ABSENT = { kind: "absent" } as const
const stores: LocalSqliteEventStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); cleanupTmpRoot() })

function setup() {
  const root = makeTmpDir()
  const { deps, store } = makeDepsWithStore(root)
  stores.push(store)
  const configPath = join(root, "flywheel.toml")
  writeFileSync(configPath, "")
  return { manager: createSessionManager(deps), store, configPath, root }
}

async function publishMember(manager: SessionManager, store: LocalSqliteEventStore, opts: Parameters<typeof publishTestWorkflow>[1]) {
  const workflowId = await publishTestWorkflow(manager, opts)
  const id = await startTestWorkflowMember(manager, store, workflowId)
  const run = await workflowRunReader(asAsyncEventReadSurface(store)).read(workflowId)
  if (!run) throw new Error("Expected workflow run")
  return { id, inheritedRoles: run.roleAssignments }
}

function controller(manager: SessionManager, sessionId: string | undefined, configPath: string, profileRoles: FlywheelConfig["profiles"][string]["roles"] = {}, available = models, catalog: Pick<ModelPickerConfigDeps, "modelInfos" | "selectedModelRoutes"> = {}, inheritedRoles?: RoleAssignmentSnapshot, personas: AgentPersonaRoles = new Map()) {
  let config = parseSchema(installedConfigSchema(), { profiles: { default: { roles: profileRoles } } })
  const configDeps: ModelPickerConfigDeps & { authProfileId: () => string } = {
    configPath, userDataRoot: makeTmpDir(), authDirectory: () => "/scratch/auth", authProfileId: () => "default",
    resolveKey: async () => undefined, moduleSelection: () => composeFirstPartyModules(),
    auth: testAuthContext({ apiKeys: { openai_api: "key", anthropic_api: "key" } }),
    get config() { return config },
    availableModels: new Map([["openai", new Set(available.filter((model) => !model.startsWith("claude")))], ["anthropic", new Set(available.filter((model) => model.startsWith("claude")))]]), modelInfos: metadata.modelInfos, modelsClient: metadata,
    providerModelEligibility: () => new Map(available.map((model) => [model, { explicitlyEnabled: true, transport: model.startsWith("claude") ? "anthropic-messages" as const : "openai-responses" as const }])),
    ...catalog,
  }
  return createModelAssignmentController({
    scope: sessionId === undefined ? { kind: "defaults" } : inheritedRoles ? { kind: "workflow-agent", sessionId, roleCaptureStore: manager, inheritedRoles, personas } : { kind: "session", sessionId, roleCaptureStore: manager }, configDeps,
    afterGlobalConfigWrite: async () => {
      config = parseSchema(installedConfigSchema(), Bun.TOML.parse(readFileSync(configPath, "utf8")))
      return config
    },
  })
}

describe("session assignment settings", () => {
  it("refuses per-brief defaults without changing the profile", async () => {
    const { manager, configPath } = setup()
    const api = controller(manager, undefined, configPath)
    for (const roleId of ["brief.plan", "brief.plan.at.worker"]) {
      await expect(api.saveEffort(roleSlot(roleId), "gpt-6-luna", "low", ABSENT)).rejects.toThrow("Per-brief defaults are retired. Set the Workflow Agent default, or set this agent's model in its workflow session.")
    }
    expect(readFileSync(configPath, "utf8")).toBe("")
  })

  it("saves one explicit pair without copying defaults or changing another session", async () => {
    const { manager, store, configPath } = setup()
    const first = await manager.createChat({ name: "first" })
    const second = await manager.createChat({ name: "second", initialRoles: { chat: { model: "gpt-6.1-sol", effort: "medium" } } })
    const before = (await manager.read(second))?.roleAssignments
    await controller(manager, first, configPath).saveEffort(roleSlot("chat"), "gpt-6-luna", "low", ABSENT)
    expect((await manager.read(first))?.roleAssignments).toEqual({ defaults: {}, overrides: { chat: { model: "gpt-6-luna", effort: "low" } } })
    expect((await manager.read(second))?.roleAssignments).toEqual(before)
    expect(store.read({ aggregateId: `session:${first}`, types: ["session.roles.updated"] })).toHaveLength(1)
    expect(readFileSync(configPath, "utf8")).toBe("")
  })

  it("keeps picker effort suggestions owned by each role when another role changes", async () => {
    const { manager, configPath } = setup()
    const id = await manager.createChat({ name: "efforts" })
    const api = controller(manager, id, configPath)
    await api.saveEffort(roleSlot("explorer"), "gpt-6-luna", "medium", ABSENT)
    expect((await api.loadAssignments([roleSlot("explorer")]))[0]?.effort).toBe("medium")
    expect((await api.listModelOptions(roleSlot("title-generation"))).find((row) => row.model === "gpt-6-luna")?.effort).toBe("low")
    expect((await api.listModelOptions(roleSlot("chat"))).find((row) => row.model === "gpt-6-luna")?.effort).toBe("medium")
    expect(readFileSync(configPath, "utf8")).toBe("")
  })

  it("projects current profile policy without writing generated defaults", async () => {
    const { manager, configPath } = setup()
    const id = await manager.createChat({ name: "live" })
    expect((await controller(manager, id, configPath, { chat: { model: "gpt-6-astra", effort: "high" } }).loadAssignments([roleSlot("chat")]))[0]).toMatchObject({ model: "gpt-6-astra", effort: "high" })
    expect((await controller(manager, id, configPath, { chat: { model: "gpt-6-luna", effort: "low" } }).loadAssignments([roleSlot("chat")]))[0]).toMatchObject({ model: "gpt-6-luna", effort: "low" })
    expect((await manager.read(id))?.roleAssignments).toEqual({ defaults: {}, overrides: {} })
    const previous = process.env.FLYWHEEL_CHAT_MODEL
    process.env.FLYWHEEL_CHAT_MODEL = "gpt-6-luna"
    try {
      const api = controller(manager, id, configPath, { chat: { model: "gpt-6-astra", effort: "high" } })
      expect((await api.loadAssignments([roleSlot("chat")]))[0]).toMatchObject({ model: "gpt-6-luna", effort: "high" })
      await api.saveEffort(roleSlot("chat"), "gpt-6-astra", "medium", ABSENT)
      expect((await api.loadAssignments([roleSlot("chat")]))[0]).toMatchObject({ model: "gpt-6-astra", effort: "medium" })
    } finally {
      if (previous === undefined) delete process.env.FLYWHEEL_CHAT_MODEL
      else process.env.FLYWHEEL_CHAT_MODEL = previous
    }
  })

  it("keeps provider options for an effort edit and gives no warning when a seat changes model family", async () => {
    const { manager, configPath } = setup()
    const id = await manager.createChat({ name: "options", initialRoles: { chat: {
      model: "gpt-6.1-sol", effort: "medium", providerOptions: { openai: { text_verbosity: "low" } },
    } } })
    const api = controller(manager, id, configPath)
    expect(await api.saveEffort(roleSlot("chat"), "gpt-6.1-sol", "high", ABSENT)).toEqual({ label: "Chat" })
    expect((await manager.read(id))?.roleAssignments?.overrides.chat?.providerOptions).toEqual({ openai: { text_verbosity: "low" } })
    expect(await api.saveEffort(roleSlot("chat"), "claude-opus-5.5", "high", ABSENT)).toEqual({ label: "Chat" })
    expect((await manager.read(id))?.roleAssignments?.overrides.chat?.providerOptions).toBeUndefined()
    expect(await api.saveEffort(roleSlot("workflow-agent"), "claude-opus-5.5", "high", ABSENT)).toEqual({ label: "Workflow" })
    expect(await api.saveEffort(roleSlot("workflow-agent"), "gpt-6-astra", "high", { kind: "value", value: { model: "claude-opus-5.5", effort: "high" } })).toEqual({ label: "Workflow" })
    await expect(api.saveEffort(roleSlot("chat"), null, null, ABSENT)).rejects.toThrow("cannot inherit")
  })

  it("clears a session pair on reset and follows profile policy without changing TOML", async () => {
    const { manager, configPath } = setup()
    const id = await manager.createChat({ name: "reset", initialRoles: { chat: { model: "gpt-6-luna", effort: "low" } } })
    const before = readFileSync(configPath)
    const rows = await controller(manager, id, configPath, { chat: { model: "gpt-6-astra", effort: "high" } }).resetDefaults([roleSlot("chat")], () => true, {})
    expect(rows[0]).toMatchObject({ model: "gpt-6-astra", effort: "high" })
    expect((await manager.read(id))?.roleAssignments).toEqual({ defaults: {}, overrides: {} })
    expect(readFileSync(configPath).equals(before)).toBe(true)
  })

  // A default model that cannot serve stays the seat, so its agent waits for it (PI-MODEL-087).
  it.each(["gpt-6-astra", "lost-model"])("keeps a workflow's default effort over %s until a person saves another pair", async (model) => {
    const { manager, store, configPath } = setup()
    const authored = { "brief.plan.at.worker.effort": { effort: "low" } }
    const { id, inheritedRoles } = await publishMember(manager, store, { name: "default-effort", workflowDefinitionId: "plan", initialRoles: authored })
    const seat = roleSlot("brief.plan.at.worker")
    const api = controller(manager, id, configPath, { "workflow-agent": { model, effort: "high" } }, models, {}, inheritedRoles)
    expect((await api.loadAssignments([seat]))[0]).toMatchObject({ model, effort: "low" })
    expect((await api.listModelOptions(seat)).find((row) => row.current)?.effort).toBe(model === "lost-model" ? undefined : "low")
    await api.saveEffort(seat, "gpt-6-luna", "high", ABSENT)
    expect(readFileSync(configPath, "utf8")).toBe("")
    expect((await manager.read(id))?.roleAssignments).toEqual({ defaults: {}, overrides: { "brief.plan.at.worker": { model: "gpt-6-luna", effort: "high" } } })
    expect((await api.loadAssignments([seat]))[0]).toMatchObject({ model: "gpt-6-luna", effort: "high" })
    await api.resetDefaults([seat], () => true, {})
    expect((await api.loadAssignments([seat]))[0]).toMatchObject({ model, effort: "low" })
    expect((await manager.read(id))?.roleAssignments).toEqual({ defaults: {}, overrides: {} })
  })

  it("keeps a running record's setting local to that record and session", async () => {
    const { manager, store, configPath } = setup()
    const { id, inheritedRoles } = await publishMember(manager, store, { name: "dynamic", workflowDefinitionId: "plan" })
    const seat = roleSlot("brief.plan.at.worker")
    const other = roleSlot("brief.plan.at.other")
    const api = controller(manager, id, configPath, { "brief.plan": { model: "gpt-6-astra", effort: "high" } }, models, {}, inheritedRoles)
    expect((await api.loadAssignments([seat]))[0]).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" })
    await api.saveEffort(seat, "gpt-6-luna", "low", ABSENT)
    expect(await api.loadAssignments([seat, other])).toMatchObject([
      { model: "gpt-6-luna", effort: "low" },
      { model: "gpt-6.1-sol", effort: "medium" },
    ])
    expect((await manager.read(id))?.roleAssignments).toEqual({ defaults: {}, overrides: { "brief.plan.at.worker": { model: "gpt-6-luna", effort: "low" } } })
    expect(readFileSync(configPath, "utf8")).toBe("")
    await api.saveEffort(seat, null, null, ABSENT)
    expect((await api.loadAssignments([seat]))[0]).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" })
  })

  it("offers a model that cannot take the workflow's default effort at an effort it supports", async () => {
    const { manager, store, configPath } = setup()
    const authored = { "brief.plan.at.worker.effort": { effort: "high" } }
    const { id, inheritedRoles } = await publishMember(manager, store, { name: "default-effort", workflowDefinitionId: "plan", initialRoles: authored })
    const low = modelInfo("openai", "custom-low", "fixture", 2, 8, "2026-10-01", { reasoningEfforts: ["low"] })
    const api = controller(manager, id, configPath, {}, [...models, "custom-low"], {
      modelInfos: new Map([...metadata.modelInfos, ["custom-low", low]]),
      selectedModelRoutes: new Map([["custom-low", { wireModelId: "custom-low", providerHint: "openai", dataUse: "standard", providers: [], metadata: low }]]),
    }, inheritedRoles)
    const seat = roleSlot("brief.plan.at.worker")
    const offered = (await api.listModelOptions(seat)).find((row) => row.model === "custom-low")
    expect(offered).toMatchObject({ selectable: true, effort: "low", efforts: ["low"] })
    expect(await api.listEffortOptions(seat, "custom-low")).toContainEqual(expect.objectContaining({ selectable: true, effort: "low" }))
    await api.saveEffort(seat, "custom-low", "low", ABSENT)
    expect((await manager.read(id))?.roleAssignments).toEqual({ defaults: {}, overrides: { "brief.plan.at.worker": { model: "custom-low", effort: "low" } } })
    expect((await api.loadAssignments([seat]))[0]).toMatchObject({ model: "custom-low", effort: "low" })
    // The person's pair now serves whole, so its effort is the suggestion.
    expect((await api.listModelOptions(seat)).find((row) => row.model === "gpt-6.1-sol")).toMatchObject({ selectable: true, effort: "low" })
    await api.saveEffort(seat, "gpt-6.1-sol", "high", ABSENT)
    expect((await api.loadAssignments([seat]))[0]).toMatchObject({ model: "gpt-6.1-sol", effort: "high" })
    expect(readFileSync(configPath, "utf8")).toBe("")
  })

  it("uses an explicit reviewer subtype until that setting is removed", async () => {
    const { manager, configPath } = setup()
    const id = await manager.createChat({ name: "review", initialRoles: { reviewer: { model: "gpt-6-astra", effort: "high" } } })
    const api = controller(manager, id, configPath)
    await api.saveEffort(roleSlot("reviewer-design"), "gpt-6-luna", "low", ABSENT)
    expect((await api.loadAssignments([roleSlot("reviewer-design")]))[0]).toMatchObject({ model: "gpt-6-luna", effort: "low" })
    await api.saveEffort(roleSlot("reviewer-design"), null, null, ABSENT)
    expect((await api.loadAssignments([roleSlot("reviewer-design")]))[0]).toMatchObject({ model: "gpt-6-astra", effort: "high" })
  })

  it.each([
    ["model", "gpt-6-astra"], ["both", "gpt-6-astra"], ["model", "lost-model"], ["both", "lost-model"],
  ] as const)("offers every model and effort over a workflow's default %s of %s, and an inherit returns to the default", async (fields, model) => {
    const { manager, store, configPath } = setup()
    const authored = { [fields === "both" ? "brief.plan.at.worker" : "brief.plan.at.worker.model"]: {
      model, ...(fields === "both" ? { effort: "high" } : {}),
    } }
    const { id, inheritedRoles } = await publishMember(manager, store, { name: "default-model", workflowDefinitionId: "plan", initialRoles: authored })
    const seat = roleSlot("brief.plan.at.worker")
    const api = controller(manager, id, configPath, {}, models, {}, inheritedRoles)
    const reading = createRoleAssignmentReader({
      readSession: (sessionId) => manager.read(sessionId),
      inheritedRoles: async () => inheritedRoles,
      capture: async () => roleCapture(models, {}),
      personas: async () => new Map(),
      childRole: async () => undefined,
      workflowSeat: async () => ({ briefId: "plan", definitionId: "worker" }),
      userDataRoot: "/scratch",
    })
    const serving = async () => sessionServingSelection(await reading(id) ?? undefined)
    // A default pair whose model is unreachable stays the seat, and no offered row is current (PI-MODEL-087).
    const authoredPair = { model, effort: fields === "both" ? "high" : "medium" }
    const options = await api.listModelOptions(seat)
    expect(options.map((row) => row.model)).not.toContain("lost-model")
    expect(options.filter((row) => row.model !== null).map((row) => row.model).toSorted()).toEqual(models.toSorted())
    expect(options.every((row) => row.selectable && row.reason === undefined)).toBe(true)
    if (model === "lost-model") expect(options.find((row) => row.current)).toBeUndefined()
    else expect(options.find((row) => row.current)).toMatchObject(authoredPair)
    expect((await api.listEffortOptions(seat, "gpt-6-luna")).every((row) => row.selectable)).toBe(true)
    expect(await serving()).toEqual(authoredPair)
    await api.saveEffort(seat, "gpt-6-luna", "low", ABSENT)
    expect((await manager.read(id))?.roleAssignments).toEqual({ defaults: {}, overrides: { "brief.plan.at.worker": { model: "gpt-6-luna", effort: "low" } } })
    expect(await serving()).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect((await api.listModelOptions(seat)).find((row) => row.current)).toMatchObject({ model: "gpt-6-luna", effort: "low" })
    await api.saveEffort(seat, null, null, ABSENT)
    expect((await manager.read(id))?.roleAssignments).toEqual({ defaults: {}, overrides: {} })
    expect(await serving()).toEqual(authoredPair)
    expect((await api.loadAssignments([seat]))[0]).toMatchObject(authoredPair)
    expect(readFileSync(configPath, "utf8")).toBe("")
  })

  it.each(["persona child", "persona workflow agent"] as const)("a %s's picker marks the serving selection that its viewer shows, before and after a viewer edit", async (kind) => {
    const { manager, store, configPath, root } = setup()
    const profile = { chat: { model: "gpt-6-astra", effort: "high" }, "workflow-agent": { model: "gpt-6-astra", effort: "high" }, explorer: { model: "gpt-6-luna", effort: "low" } } as const
    const personas: AgentPersonas = new Map([["worker", { id: "explorer", roles: ["explorer"] }]])
    const member = kind === "persona workflow agent" ? await publishMember(manager, store, { name: "personas", workflowDefinitionId: "plan" }) : undefined
    const id = member?.id ?? await publishTestSubagent(manager, root, "child", await manager.createChat({ name: "parent" }))
    const reading = createRoleAssignmentReader({
      readSession: (sessionId) => manager.read(sessionId),
      inheritedRoles: async () => member?.inheritedRoles ?? { defaults: {}, overrides: {} },
      capture: async () => roleCapture(models, profile),
      personas: async () => personas,
      childRole: async () => ({ roleId: "explorer" }),
      workflowSeat: async () => ({ briefId: "plan", definitionId: "worker" }),
      userDataRoot: "/scratch",
    })
    const api = controller(manager, id, configPath, profile, models, {}, member?.inheritedRoles, personas)
    const picked = async () => {
      const view = await reading(id)
      const slot = view?.serving?.slot
      if (slot === undefined) throw new Error("Expected a serving seat")
      const option = (await api.listModelOptions(slot)).find((row) => row.current)
      const model = option?.inheritModel ?? option?.model ?? undefined
      return {
        slot, serving: sessionServingSelection(view ?? undefined),
        row: await api.loadAssignments([slot]).then(([row]) => row && { model: row.model, effort: row.effort }),
        option: { model, effort: option?.effort },
        effort: model === undefined ? undefined : (await api.listEffortOptions(slot, model)).find((row) => row.current && row.effort !== null)?.effort,
      }
    }
    const before = await picked()
    expect(before.slot.roleId).toBe(kind === "persona child" ? "explorer" : "brief.plan.at.worker")
    expect(before.serving).toEqual({ model: "gpt-6-luna", effort: "low" })
    expect(before).toMatchObject({ row: before.serving, option: before.serving, effort: "low" })
    await api.saveEffort(before.slot, "gpt-6.1-sol", "medium", ABSENT)
    const after = await picked()
    expect(after.slot).toEqual(before.slot)
    expect(after.serving).toEqual({ model: "gpt-6.1-sol", effort: "medium" })
    expect(after).toMatchObject({ row: after.serving, option: after.serving, effort: "medium" })
  })

  it("keeps empty availability as no selection while saving a pair for later recovery", async () => {
    const { manager, configPath } = setup()
    const id = await manager.createChat({ name: "empty", initialRoles: { chat: { model: "lost", effort: "low" } } })
    const api = controller(manager, id, configPath, {}, [])
    expect(await api.loadAssignments([roleSlot("chat")])).toEqual([])
    expect((await manager.read(id))?.roleAssignments?.overrides.chat).toEqual({ model: "lost", effort: "low" })
    await api.saveEffort(roleSlot("chat"), "gpt-6-luna", "high", ABSENT)
    expect((await manager.read(id))?.roleAssignments?.overrides.chat).toEqual({ model: "gpt-6-luna", effort: "high" })
    expect(await api.loadAssignments([roleSlot("chat")])).toEqual([])
    expect((await controller(manager, id, configPath).loadAssignments([roleSlot("chat")]))[0]).toMatchObject({ model: "gpt-6-luna", effort: "high" })
    expect(readFileSync(configPath, "utf8")).toBe("")
  })
})

// A defaults write states the profile entry its client showed, so a client
// that read the file before another client's write changes nothing
// (ARCH-RUNTIME-060).
describe("defaults assignment writes compare and swap", () => {
  const chat = roleSlot("chat")
  const shown = { chat: { model: "gpt-6-astra", effort: "high" } } as const
  const twoClients = () => {
    const { manager, configPath } = setup()
    writeFileSync(configPath, '[profiles.default.roles.chat]\nmodel = "gpt-6-astra"\neffort = "high"\n')
    return { configPath, first: controller(manager, undefined, configPath, shown), second: controller(manager, undefined, configPath, shown) }
  }

  it("Two clients that both showed model A: the first save to B commits, the second save to C is refused as stale", async () => {
    const { configPath, first, second } = twoClients()
    const [firstRow] = await first.loadAssignments([chat])
    const [secondRow] = await second.loadAssignments([chat])
    expect([firstRow?.configured, secondRow?.configured]).toEqual([
      { kind: "value", value: { model: "gpt-6-astra", effort: "high" } },
      { kind: "value", value: { model: "gpt-6-astra", effort: "high" } },
    ])
    await first.saveEffort(chat, "gpt-6-luna", "low", firstRow!.configured)
    await expect(second.saveEffort(chat, "gpt-6.1-sol", "medium", secondRow!.configured)).rejects.toBeInstanceOf(ConfigStaleWriteError)
    expect(readFileSync(configPath, "utf8")).toBe('[profiles.default.roles.chat]\nmodel = "gpt-6-luna"\neffort = "low"\n')
  })

  it("A reset to detected defaults whose expected slot values are stale writes nothing", async () => {
    const { configPath, first, second } = twoClients()
    const [firstRow] = await first.loadAssignments([chat])
    const [secondRow] = await second.loadAssignments([chat])
    await first.saveEffort(chat, "gpt-6-luna", "low", firstRow!.configured)
    const after = readFileSync(configPath, "utf8")
    await expect(second.resetDefaults([chat], () => true, { chat: secondRow!.configured })).rejects.toBeInstanceOf(ConfigStaleWriteError)
    expect(readFileSync(configPath, "utf8")).toBe(after)
  })

  it("A reset whose map omits a role that holds a value is refused as stale", async () => {
    const { configPath, first } = twoClients()
    const before = readFileSync(configPath, "utf8")
    await expect(first.resetDefaults([chat], () => true, {})).rejects.toBeInstanceOf(ConfigStaleWriteError)
    expect(readFileSync(configPath, "utf8")).toBe(before)
  })

  // The web client lists no parent role such as reviewer, so its reset names
  // only the roles it shows and leaves the parent's saved value.
  it("A reset that does not name reviewer leaves its saved value", async () => {
    const { manager, configPath } = setup()
    writeFileSync(configPath, '[profiles.default.roles.chat]\nmodel = "gpt-6-astra"\neffort = "high"\n\n[profiles.default.roles.reviewer]\nmodel = "gpt-6-luna"\neffort = "low"\n')
    const api = controller(manager, undefined, configPath, { chat: { model: "gpt-6-astra", effort: "high" }, reviewer: { model: "gpt-6-luna", effort: "low" } })
    const [row] = await api.loadAssignments([chat])
    await api.resetDefaults([chat], () => true, { chat: row!.configured })
    expect(Bun.TOML.parse(readFileSync(configPath, "utf8"))).toEqual({ profiles: { default: { roles: { reviewer: { model: "gpt-6-luna", effort: "low" } } } } })
  })
})
