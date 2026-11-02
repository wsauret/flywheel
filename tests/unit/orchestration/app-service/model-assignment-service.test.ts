import { describe, expect, test } from "bun:test"
import { repoDefinitions, repoModules } from "../../../helpers/project-definitions.js"
import { Redacted } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AuthContext } from "../../../../src/infra/auth/auth-context.js"
import type { ModelFamily } from "../../../../src/infra/llm/model-family.js"
import { asAsyncEventReadSurface, type AsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { authDir } from "../../../../src/infra/paths.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { createRuntimeModelAssignmentService } from "../../../../src/orchestration/app-service/model-assignment-service.js"
import { createAdmittedModelAssignmentService } from "../../../../src/orchestration/app-service/model-assignment-admission.js"
import { loadConfig } from "../../../../src/orchestration/config/loader.js"
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js"
import type { RoleAssignments } from "../../../../src/orchestration/session/schemas.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { fakeModelInfos, fakeModelsClient, makeModelsClient, modelInfo } from "../../../helpers/model-tier-fixtures.js"
import { chatEntry } from "./app-service-doubles.js"
import { createDefinitionAvailability } from "../../../../src/orchestration/app-service/definition-availability.js"
import type { DefinitionAvailabilityOwner } from "../../../../src/orchestration/app-service/definition-availability.js"
import type { AgentDefinition } from "../../../../src/infra/agent-definition.js"
import type { ModuleId } from "../../../../src/orchestration/modules.js"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { CONFIG_DEFAULTS } from "../../../../src/orchestration/config/schema.js"
import { captureRoleAssignments } from "../../../../src/orchestration/config/session-role-resolver.js"
import { decodeModuleState } from "../../../../src/orchestration/config/module-descriptor.js"
import { fakeListingClient } from "../../../helpers/fake-listing-client.js"

import { roleSlot } from "../../../../src/orchestration/config/role-selection.js"
import { authProviders } from "../../../helpers/auth-context.js"
import { managerDouble, type ManagerDouble } from "./model-assignment-service-fixtures.js"
import { testSessionAuthAdmission } from "../../../fixtures/runtime-supervisor-fixtures.js"

const temporaryDirectory = temporaryDirectories()

const DEFAULT_ROLES = {
  chat: { model: "gpt-5.5", effort: "medium", provider: "openai_api" },
  "workflow-agent": { model: "gpt-5.5", effort: "high", provider: "openai_api" },
} satisfies RoleAssignments

const UNUSED_EVENT_READER = inMemoryEventReader([])

const UNUSED_EVENT_WRITER = {
  append: async () => { throw new Error("unused event writer") },
  appendBatch: async () => { throw new Error("unused event writer") },
  pruneSupersededEvents: async () => { throw new Error("unused event writer") },
} satisfies AsyncEventWriter

function transientChatStore() {
  return {
    get: (id: string) => id === "chat-new"
      ? chatEntry({ conversationId: "conv-new", description: "New Chat", outputBlocks: () => [] })
      : undefined,
  }
}

const EXPLORER: AgentDefinition = {
  kind: "persona",
  name: "explorer",
  description: "Investigates.",
  systemPrompt: "Investigate.",
  tools: ["read"],
  role: "explorer",
  maxTurns: 20,
}

function availabilityOwner(capabilities: readonly ModuleId[]): Promise<DefinitionAvailabilityOwner> {
  const skills = testSkillRevision([testSkill("plan"), testSkill("fly.spec-create"), testSkill("fly.spec-review")])
  const personas = { revision: "explorer", personas: new Map([["explorer", EXPLORER]]), resolutions: [] }
  const definitionRevision = {
    ...repoDefinitions().captureRevision(),
    skills,
    personaRevision: personas,
    personas: personas.personas,
  }
  return createDefinitionAvailability({
    definitions: { captureRevision: () => definitionRevision },
    modules: repoModules,
    capabilities: { state: () => {
      const state = decodeModuleState("")
      return { ...state, capabilities, moduleIds: capabilities }
    } },
  })
}

const FULL_AVAILABILITY = await availabilityOwner(["workflows", "skills", "subagents", "learning", "background-commands"])

const AUTH: AuthContext = {
  providers: authProviders({ apiKeys: { openai_api: "[redacted secret]" } }),
  credentialLineages: {}, droppedCredentials: [],
}

const AVAILABLE_MODELS: ReadonlyMap<ModelFamily, ReadonlySet<string>> = new Map([
  ["openai", new Set(["gpt-5.5", "gpt-5-mini"])],
])
const ASSIGNMENT_MODELS_CLIENT = makeModelsClient({
  "gpt-5.5": modelInfo("openai", "gpt-5.5", "gpt", 5, 30, "2026-04-01"),
  "gpt-5-mini": modelInfo("openai", "gpt-5-mini", "gpt-mini", 0.25, 2, "2026-04-01"),
})

async function compoundService(manager: ManagerDouble, prepareModelEligibility?: () => Promise<void>, availability = FULL_AVAILABILITY, eligibility = pickerEligibility(), moduleSelection = () => composeFirstPartyModules()) {
  const dir = temporaryDirectory("flywheel-models-")
  const directories = testDirectories(dir)
  const configPath = join(dir, "flywheel.toml")
  writeFileSync(configPath, '[profiles.default.roles.chat]\nmodel = "gpt-5.5"\neffort = "medium"\n')
  const configOwner = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, configPath, watch: false })
  const service = createRuntimeModelAssignmentService({
    roleCaptureStore: manager,
    sessionStore: transientChatStore(),
    projectRoot: dir,

    eventStore: asAsyncEventReadSurface(UNUSED_EVENT_READER),
    eventWriter: UNUSED_EVENT_WRITER,
    availability,
    moduleSelection,
    config: () => configOwner.snapshot().config,
    refreshConfig: async () => (await configOwner.refresh()).config,
    materializeDefaults: async () => DEFAULT_ROLES,
    prepareModelEligibility,
    configDepsForScope: () => ({
      userDataRoot: directories.userDataRoot,
      authDirectory: () => authDir(directories.userDataRoot, "default"),
      authProfileId: () => "default",
      resolveKey: async () => undefined,
      moduleSelection,
      configPath,
      config: CONFIG_DEFAULTS,
      auth: AUTH,
      availableModels: new Map([...AVAILABLE_MODELS].map(([family, models]) => [family, new Set([...models].filter((model) => eligibility.has(model)))])),
      providerModelEligibility: () => eligibility,
      providerModelCatalogs,
      listingClient: fakeListingClient(AVAILABLE_MODELS),
      modelsClient: ASSIGNMENT_MODELS_CLIENT,
      modelInfos: ASSIGNMENT_MODELS_CLIENT.modelInfos,
    }),
  })
  return { service, configPath, configOwner }
}

test("waits for provider-model eligibility before loading assignments", async () => {
  const gate = Promise.withResolvers<void>()
  let entered = false
  let settled = false
  const { service } = await compoundService(managerDouble(), async () => {
    entered = true
    await gate.promise
  })

  const pending = service.loadAssignments({ scope: { kind: "defaults" }, slots: [roleSlot("chat")] }).then((rows) => {
    settled = true
    return rows
  })
  await Promise.resolve()

  expect(entered).toBe(true)
  expect(settled).toBe(false)
  gate.resolve()
  expect(await pending).not.toHaveLength(0)
})

test("waits for provider-model eligibility before listing model options", async () => {
  const gate = Promise.withResolvers<void>()
  let entered = false
  let settled = false
  const { service } = await compoundService(managerDouble(), async () => {
    entered = true
    await gate.promise
  })

  const pending = service.listModelOptions({ scope: { kind: "defaults" }, slot: roleSlot("chat") }).then((rows) => {
    settled = true
    return rows
  })
  await Promise.resolve()

  expect(entered).toBe(true)
  expect(settled).toBe(false)
  gate.resolve()
  expect(await pending).not.toHaveLength(0)
})

describe("active profile model overlays", () => {
  test("reads the active profile accessor for each write and later materialization", async () => {
    const manager = managerDouble()
    const dir = temporaryDirectory("flywheel-model-profile-accessor-")
    const directories = testDirectories(dir)
    const configPath = join(dir, "flywheel.toml")
    writeFileSync(configPath, '[profiles.profile-a.roles.chat]\nmodel = "powerful"\neffort = "medium"\n')
    let profileId = "profile-a"
    let directory = authDir(directories.userDataRoot, profileId)
    const activeProfileId = () => profileId
    const activeAuthDirectory = () => directory
    const resolveKey = async (value: string) => Redacted.make(value)
    const configDeps = {
      userDataRoot: directories.userDataRoot,
      authDirectory: activeAuthDirectory,
      authProfileId: activeProfileId,
      resolveKey,
      moduleSelection: () => composeFirstPartyModules(),
      configPath,
      auth: AUTH,
      availableModels: AVAILABLE_MODELS,
      modelsClient: ASSIGNMENT_MODELS_CLIENT,
      config: CONFIG_DEFAULTS,
      providerModelEligibility: () => pickerEligibility(),
      providerModelCatalogs,
      listingClient: fakeListingClient(AVAILABLE_MODELS),
      modelInfos: ASSIGNMENT_MODELS_CLIENT.modelInfos,
    }
    const service = createRuntimeModelAssignmentService({
      roleCaptureStore: manager,
      sessionStore: transientChatStore(),
      projectRoot: dir,
      eventStore: asAsyncEventReadSurface(UNUSED_EVENT_READER),
      eventWriter: UNUSED_EVENT_WRITER,
      availability: FULL_AVAILABILITY,
      moduleSelection: () => composeFirstPartyModules(),
      config: () => loadConfig(configPath).config,
      refreshConfig: async () => loadConfig(configPath).config,
      configDepsForScope: () => configDeps,
    })

    expect((await service.globalDefaultRoles()).chat).toMatchObject({ model: "gpt-5.5", effort: "medium" })
    await service.saveEffort({ scope: { kind: "defaults" }, slot: roleSlot("chat"), model: "gpt-5-mini", effort: "low" })
    profileId = "profile-b"
    directory = authDir(directories.userDataRoot, profileId)
    await service.saveEffort({ scope: { kind: "defaults" }, slot: roleSlot("chat"), model: "gpt-5.5", effort: "high" })

    expect(Bun.TOML.parse(readFileSync(configPath, "utf8"))).toEqual({
      profiles: {
        "profile-a": { roles: { chat: { model: "gpt-5-mini", effort: "low" } } },
        "profile-b": { roles: { chat: { model: "gpt-5.5", effort: "high" } } },
      },
    })
    expect((await service.globalDefaultRoles()).chat).toMatchObject({ model: "gpt-5.5", effort: "high" })
  })
})

describe("held global default roles", () => {
  test("resolves once for unchanged inputs and again when the configured roles or the enabled models change", async () => {
    const dir = temporaryDirectory("flywheel-held-defaults-")
    const directories = testDirectories(dir)
    let reads = 0
    class CountingInfos extends Map<string, ReturnType<typeof modelInfo>> {
      override get(key: string) { reads += 1; return super.get(key) }
    }
    const modelInfos = new CountingInfos(ASSIGNMENT_MODELS_CLIENT.modelInfos)
    let config = CONFIG_DEFAULTS
    let availableModels = AVAILABLE_MODELS
    let eligibilityRevision = 1
    const service = createRuntimeModelAssignmentService({
      roleCaptureStore: managerDouble(),
      sessionStore: transientChatStore(),
      projectRoot: dir,
      eventStore: asAsyncEventReadSurface(UNUSED_EVENT_READER),
      eventWriter: UNUSED_EVENT_WRITER,
      availability: FULL_AVAILABILITY,
      moduleSelection: () => composeFirstPartyModules(),
      config: () => config,
      refreshConfig: async () => config,
      configDepsForScope: () => ({
        userDataRoot: directories.userDataRoot,
        authDirectory: () => authDir(directories.userDataRoot, "default"),
        authProfileId: () => "default",
        resolveKey: async () => undefined,
        moduleSelection: () => composeFirstPartyModules(),
        config,
        auth: AUTH,
        // A fresh map per read, as the admitted picker is per eligibility revision.
        get availableModels() { return new Map(availableModels) },
        providerModelEligibility: () => pickerEligibility(),
        modelsClient: ASSIGNMENT_MODELS_CLIENT,
        modelInfos,
        eligibilityRevision,
      }),
    })

    const first = await service.globalDefaultRoles()
    const afterFirst = reads
    expect(afterFirst).toBeGreaterThan(0)
    expect(await service.globalDefaultRoles()).toEqual(first)
    expect(reads).toBe(afterFirst)

    // A fresh snapshot with the same roles is the same input.
    config = { ...CONFIG_DEFAULTS }
    await service.globalDefaultRoles()
    expect(reads).toBe(afterFirst)

    modelInfos.set("gpt-5.5", modelInfo("openai", "gpt-5.5", "gpt", 0.5, 2, "2026-04-01"))
    eligibilityRevision += 1
    expect((await service.globalDefaultRoles()).chat?.model).toBe("gpt-5-mini")
    expect(reads).toBeGreaterThan(afterFirst)

    config = { ...CONFIG_DEFAULTS, profiles: { default: { roles: { chat: { model: "gpt-5.5", effort: "high" } }, git_ai_attribution: false, allow_training_routes: false, providers: {} } } }
    expect((await service.globalDefaultRoles()).chat).toMatchObject({ model: "gpt-5.5", effort: "high" })
    const afterConfigChange = reads
    expect(afterConfigChange).toBeGreaterThan(afterFirst)

    availableModels = new Map([["openai", new Set(["gpt-5-mini"])]])
    await service.globalDefaultRoles()
    expect(reads).toBeGreaterThan(afterConfigChange)
  })
})

describe("admitted global default role projection", () => {

  async function admittedService(source: string, activeProfileId: () => string, admitDefaults = testSessionAuthAdmission().admitDefaults) {
    const dir = temporaryDirectory("flywheel-model-label-")
    const directories = testDirectories(dir)
    const configPath = join(dir, "flywheel.toml")
    writeFileSync(configPath, source)
    const runtimeConfig = await createRuntimeConfigOwner({ userDataRoot: directories.userDataRoot, configPath, watch: false })
    let eligibilityPreparations = 0
    const baseAdmission = testSessionAuthAdmission()
    const service = createAdmittedModelAssignmentService({
      userDataRoot: directories.userDataRoot,
      projectRoot: dir,
      manager: managerDouble(),
      sessionStore: transientChatStore(),
      eventReader: asAsyncEventReadSurface(UNUSED_EVENT_READER),
      eventWriter: UNUSED_EVENT_WRITER,
      availability: FULL_AVAILABILITY,
      runtimeConfig,
      resolveKey: async () => undefined,
      moduleSelection: () => composeFirstPartyModules(),
      sessionAuthAdmission: { ...baseAdmission, admitDefaults },
      activeProfileId,
      prepareEligibility: async () => { eligibilityPreparations += 1 },
      eligibilityState: () => { throw new Error("explicit model label must not read eligibility") },
      readAdmission: async () => {
        await admitDefaults()
        throw new Error("unexpected successful read admission")
      },
    })
    return { service, config: () => runtimeConfig.snapshot().config, eligibilityPreparations: () => eligibilityPreparations }
  }

  test("publishes role metadata without admission but waits before projecting an explicit saved model", async () => {
    let admissions = 0
    const held = Promise.withResolvers<Awaited<ReturnType<ReturnType<typeof testSessionAuthAdmission>["admitDefaults"]>>>()
    const { service, eligibilityPreparations } = await admittedService(`
[roles.chat]
model = "global-model"
effort = "low"
[profiles.work.roles.chat]
model = "profile-model"
effort = "high"
`, () => "work", () => {
      admissions += 1
      return held.promise
    })

    expect((await service.modelRoles()).roles.some(({ id }) => id === "chat")).toBe(true)
    expect(admissions).toBe(0)
    const pending = service.globalDefaultRoles()
    expect(admissions).toBe(1)
    const unavailable = new Error("read admission unavailable")
    held.reject(unavailable)
    await expect(pending).rejects.toBe(unavailable)
    expect(eligibilityPreparations()).toBe(0)
  })

  test.each([
    ["tier", '[roles.chat]\nmodel = "powerful"\neffort = "medium"\n'],
    ["automatic", ""],
  ] as const)("keeps %s defaults on the admitted path", async (_kind, source) => {
    let admissions = 0
    const expected = new Error("admitted path")
    const { service, eligibilityPreparations } = await admittedService(source, () => "default", async () => {
      admissions += 1
      throw expected
    })

    expect(service.globalDefaultRoles()).rejects.toBe(expected)
    expect(admissions).toBe(1)
    expect(eligibilityPreparations()).toBe(0)
  })
})

function pickerEligibility() {
  return new Map([...AVAILABLE_MODELS.values()].flatMap((models) => [...models].map((model) => [model, {
    explicitlyEnabled: false,
    transport: "openai-responses" as const,
    offering: {
      candidate: { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" },
      wireModelId: model,
      dataUse: "standard",
      transport: "openai-responses",
      resolvedModelMetadata: fakeModelsClient.modelInfos.get(model),
    },
  }] as const)))
}

function providerModelCatalogs() {
  return new Map([["openai_api", {
    catalog: new Set(["gpt-5.5", "gpt-5-mini"]),
    curatedDefault: new Set(["gpt-5.5", "gpt-5-mini"]),
    enabled: new Set<string>(),
    disabled: new Set<string>(),
    effective: new Set(["gpt-5.5", "gpt-5-mini"]),
  }]] as const)
}

describe("defaults-and-session write scope", () => {
  test("save writes the default and mirrors it into the session snapshot", async () => {
    const manager = managerDouble()
    const { service, configPath } = await compoundService(manager)
    const before = readFileSync(configPath, "utf-8")

    const result = await service.saveEffort({
      scope: { kind: "defaults-and-session", sessionId: "chat-new" },
      slot: roleSlot("chat"),
      model: "gpt-5-mini",
      effort: "low",
    })

    expect(result).toMatchObject({ label: "Chat", mirrored: true })
    expect(readFileSync(configPath, "utf-8")).not.toBe(before)
    expect((await manager.read("chat-new"))?.roleAssignments?.overrides.chat).toMatchObject({ model: "gpt-5-mini", effort: "low" })
  })

  test("save removes a provider pin from the defaults TOML", async () => {
    const manager = managerDouble()
    const { service, configPath } = await compoundService(manager)
    writeFileSync(configPath, '[roles.chat]\nmodel = "gpt-5.5"\neffort = "medium"\nprovider = "openai_api"\n')

    await service.saveEffort({
      scope: { kind: "defaults" },
      slot: roleSlot("chat"),
      model: "gpt-5-mini",
      effort: "low",
    })

    const saved = readFileSync(configPath, "utf-8")
    expect(saved).not.toContain("provider")
    expect(Bun.TOML.parse(saved)).toEqual({
      profiles: { default: { roles: { chat: { model: "gpt-5-mini", effort: "low" } } } },
    })
  })

  test("a defaults save is visible to an immediate assignment reload", async () => {
    const { service } = await compoundService(managerDouble())

    await service.saveEffort({
      scope: { kind: "defaults" },
      slot: roleSlot("chat"),
      model: "gpt-5-mini",
      effort: "low",
    })

    const rows = await service.loadAssignments({ scope: { kind: "defaults" }, slots: [roleSlot("chat")] })

    expect(rows[0]).toMatchObject({ model: "gpt-5-mini", effort: "low" })
    await service.saveEffort({ scope: { kind: "defaults" }, slot: roleSlot("explorer"), model: "gpt-5-mini", effort: "high" })
    const roleEfforts = await service.loadAssignments({ scope: { kind: "defaults" }, slots: [roleSlot("explorer"), roleSlot("title-generation"), roleSlot("chat")] })
    expect(roleEfforts.map(({ effort }) => effort)).toEqual(["high", "low", "low"])
    expect((await service.listModelOptions({ scope: { kind: "defaults" }, slot: roleSlot("chat") })).find((row) => row.model === "gpt-5-mini")?.effort).toBe("low")
  })

  test.each([true, false])("role effort supplies every picker option when eligible is %s", async (eligible) => {
    const manager = managerDouble()
    manager.seed("chat-new", { ...DEFAULT_ROLES, chat: { model: "gpt-5.5", effort: "low", provider: "openai_api" } })
    const eligibility = pickerEligibility()
    if (!eligible) eligibility.delete("gpt-5.5")
    const { service } = await compoundService(manager, undefined, FULL_AVAILABILITY, eligibility)

    for (const [scope, effort] of [
      [{ kind: "defaults" }, "medium"],
      [{ kind: "session", sessionId: "chat-new" }, "low"],
    ] as const) {
      const rows = await service.listModelOptions({ scope, slot: roleSlot("chat") })
      if (eligible) expect(rows.find((row) => row.model === "gpt-5.5")).toMatchObject({ current: true, selectable: true, effort })
      else expect(rows.find((row) => row.model === "gpt-5.5")).toBeUndefined()
      expect(rows.find((row) => row.model === "gpt-5-mini")?.effort).toBe(eligible ? effort : "medium")
    }
  })

  test("a session save changes only that session's role effort", async () => {
    const manager = managerDouble()
    manager.seed("chat-new", DEFAULT_ROLES)
    const { service, configPath } = await compoundService(manager)
    const before = readFileSync(configPath, "utf8")

    await service.saveEffort({
      scope: { kind: "session", sessionId: "chat-new" },
      slot: roleSlot("chat"),
      model: "gpt-5-mini",
      effort: "high",
    })

    const rows = await service.listModelOptions({ scope: { kind: "defaults" }, slot: roleSlot("chat") })
    expect(rows.find((row) => row.model === "gpt-5-mini")?.effort).toBe("medium")
    expect((await manager.read("chat-new"))?.roleAssignments?.overrides.chat).toEqual({ model: "gpt-5-mini", effort: "high" })
    expect(readFileSync(configPath, "utf8")).toBe(before)
  })

  test("an effort-only record save retains the inherited model's provider options", async () => {
    const manager = managerDouble()
    const providerOptions = { openai: { service_tier: "priority" } }
    manager.seed("chat-new", { "brief.demo.build": { model: "gpt-5.5", effort: "medium", providerOptions } })
    const { service } = await compoundService(manager)
    await service.saveEffort({
      scope: { kind: "session", sessionId: "chat-new" },
      slot: roleSlot("brief.demo.build.at.build"),
      model: "gpt-5.5",
      effort: "high",
    })
    expect((await manager.read("chat-new"))?.roleAssignments?.overrides["brief.demo.build.at.build"]).toEqual({
      model: "gpt-5.5", effort: "high", providerOptions,
    })
  })

  test("a broken saved model stays outside choices and a reachable replacement overwrites it", async () => {
    const { service, configPath, configOwner } = await compoundService(managerDouble())
    writeFileSync(configPath, '[profiles.default.roles.chat]\nmodel = "lost-model"\neffort = "high"\n')
    await configOwner.refresh()
    const query = { scope: { kind: "defaults" as const }, slot: roleSlot("chat") }
    const [assignment] = await service.loadAssignments({ scope: query.scope, slots: [query.slot] })
    expect(assignment).toMatchObject({ model: "gpt-5-mini", effort: "medium", savedModel: "lost-model", modelSource: "default", matchesInheritedPair: true })
    const options = await service.listModelOptions(query)
    expect(options.map((row) => row.model)).not.toContain("lost-model")
    expect(options.every((row) => row.selectable)).toBe(true)
    await service.saveEffort({ ...query, model: "gpt-5-mini", effort: "low" })
    expect(loadConfig(configPath, {}).config.profiles.default?.roles.chat).toEqual({ model: "gpt-5-mini", effort: "low" })
  })

  test.each(["defaults", "session", "defaults-and-session"] as const)("%s Workflow Agent saves write the profile without a session mirror", async (kind) => {
    const manager = managerDouble()
    manager.seed("chat-new", {})
    manager.failRoleWrites()
    const { service, configPath } = await compoundService(manager)
    const scope = kind === "defaults" ? { kind } : { kind, sessionId: "chat-new" }
    const result = await service.saveEffort({ scope, slot: roleSlot("workflow-agent"), model: "gpt-5-mini", effort: "low" })
    expect(result.warning).toBeUndefined()
    expect(result.mirrored).toBeUndefined()
    expect(loadConfig(configPath, {}).config.profiles.default?.roles["workflow-agent"]).toEqual({ model: "gpt-5-mini", effort: "low" })
    expect((await manager.read("chat-new"))?.roleAssignments).toEqual({ defaults: {}, overrides: {} })
  })

  test.each(["defaults", "session", "defaults-and-session"] as const)("%s brief saves never write the profile", async (kind) => {
    const manager = managerDouble()
    manager.seed("chat-new", {})
    const { service, configPath } = await compoundService(manager)
    const before = readFileSync(configPath, "utf8")
    for (const roleId of ["brief.fly.spec-create", "brief.fly.spec-create.persona.explorer", "brief.fly.spec-create.at.worker"]) {
      const scope = kind === "defaults" ? { kind } : { kind, sessionId: "chat-new" }
      const saved = service.saveEffort({ scope, slot: roleSlot(roleId), model: "gpt-5-mini", effort: "low" })
      if (kind === "session") {
        await saved
        expect((await manager.read("chat-new"))?.roleAssignments?.overrides[roleId]).toEqual({ model: "gpt-5-mini", effort: "low" })
      } else {
        await expect(saved).rejects.toThrow("Per-brief defaults are retired")
      }
    }
    expect(readFileSync(configPath, "utf8")).toBe(before)
  })

  test("saving another role and reading one row preserves saved brief defaults", async () => {
    const { service, configPath, configOwner } = await compoundService(managerDouble())
    writeFileSync(configPath, ["brief.fly.spec-create", "brief.fly.spec-review"].map((id) =>
      `[profiles.default.roles."${id}"]\nmodel = "gpt-5-mini"\neffort = "medium"\n`).join("\n"))
    await configOwner.refresh()
    await service.saveEffort({ scope: { kind: "defaults" }, slot: roleSlot("chat"), model: "gpt-5.5", effort: "medium" })
    await service.loadAssignments({ scope: { kind: "defaults" }, slots: [roleSlot("chat")] })
    const config = loadConfig(configPath, {}).config
    expect(config.profiles.default?.roles["brief.fly.spec-create"]).toEqual({ model: "gpt-5-mini", effort: "medium" })
    expect(config.profiles.default?.roles["brief.fly.spec-review"]).toEqual({ model: "gpt-5-mini", effort: "medium" })
    const captured = await captureRoleAssignments({
      userDataRoot: testDirectories(dirname(configPath)).userDataRoot,
      profileRoles: configOwner.snapshot().config.profiles.default?.roles ?? {},
      availableModels: AVAILABLE_MODELS,
      modelInfos: fakeModelInfos,
      modelsClient: fakeModelsClient,
    })
    expect(captured["brief.fly.spec-create"]).toBeUndefined()
  })

  test("hides disabled or absent module roles without pruning their saved assignments", async () => {
    let composition = composeFirstPartyModules(repoModules)
    const { service, configPath } = await compoundService(managerDouble(), undefined, FULL_AVAILABILITY, pickerEligibility(), () => composition)
    const slot = roleSlot("benchmark-judge")
    await service.saveEffort({ scope: { kind: "defaults" }, slot, model: "gpt-5-mini", effort: "medium" })
    const saved = readFileSync(configPath, "utf8")
    const query = { scope: { kind: "defaults" }, slots: [roleSlot("chat"), roleSlot("reviewer"), slot] } as const
    expect((await service.loadAssignments(query)).map((row) => row.slot.roleId)).toEqual(["chat", "reviewer", slot.roleId])
    for (const next of [composeFirstPartyModules(repoModules, ["development"]), composeFirstPartyModules()]) {
      composition = next
      expect((await service.modelRoles()).roles.some(({ id }) => id === slot.roleId)).toBe(false)
      expect((await service.loadAssignments(query)).map((row) => row.slot.roleId)).toEqual(["chat", "reviewer"])
      expect(readFileSync(configPath, "utf8")).toBe(saved)
      expect(loadConfig(configPath, {}).config.profiles.default?.roles[slot.roleId]).toEqual({ model: "gpt-5-mini", effort: "medium" })
    }
    composition = composeFirstPartyModules(repoModules)
    expect((await service.loadAssignments(query)).find((row) => row.slot.roleId === slot.roleId)).toMatchObject({ model: "gpt-5-mini", effort: "medium" })
  })

  test("refuses profile brief saves when workflow modules are disabled", async () => {
    const availability = await availabilityOwner([])
    const { service, configPath } = await compoundService(managerDouble(), undefined, availability)
    await expect(service.saveEffort({
      scope: { kind: "defaults" },
      slot: roleSlot("brief.fly.spec-create"),
      model: "gpt-5-mini",
      effort: "medium",
    })).rejects.toThrow("Per-brief defaults are retired")
    await service.loadAssignments({ scope: { kind: "defaults" }, slots: [roleSlot("chat")] })
    expect(loadConfig(configPath, {}).config.profiles.default?.roles["brief.fly.spec-create"]).toBeUndefined()
  })

  test("save skips the session mirror for effort-inherit on a concrete model", async () => {
    const manager = managerDouble()
    const { service } = await compoundService(manager)

    const result = await service.saveEffort({
      scope: { kind: "defaults-and-session", sessionId: "chat-new" },
      slot: roleSlot("chat"),
      model: "gpt-5-mini",
      effort: null,
    })

    expect(result.mirrored).toBeFalsy()
    // The session was never touched: no snapshot materialized, no write.
    expect(manager.created()).toHaveLength(0)
  })

  test("reset resets the defaults and the session snapshot", async () => {
    const manager = managerDouble()
    const { service } = await compoundService(manager)
    await service.saveEffort({
      scope: { kind: "defaults" },
      slot: roleSlot("chat"),
      model: "gpt-5-mini",
      effort: "low",
    })
    manager.seed("chat-new", { ...DEFAULT_ROLES, chat: { model: "gpt-5-mini", effort: "low", provider: "openai_api" } })

    const result = await service.resetDefaults({
      scope: { kind: "defaults-and-session", sessionId: "chat-new" },
      slots: [roleSlot("chat")],
    })

    expect(result.warning).toBeUndefined()
    expect(result.mirrored).toBe(true)
    expect(result.rows.length).toBeGreaterThan(0)
    expect(result.rows[0]).toMatchObject({ model: "gpt-5-mini", effort: "medium" })
    expect((await manager.read("chat-new"))?.roleAssignments).toEqual({ defaults: {}, overrides: {} })
    expect((await service.listModelOptions({
      scope: { kind: "defaults" },
      slot: roleSlot("chat"),
    })).find((row) => row.model === "gpt-5-mini")?.effort).toBe("medium")
  })

  test("reset degrades to a warning when the session mirror fails", async () => {
    const manager = managerDouble()
    const { service } = await compoundService(manager)
    manager.seed("chat-new", DEFAULT_ROLES)
    manager.failRoleWrites()

    const result = await service.resetDefaults({
      scope: { kind: "defaults-and-session", sessionId: "chat-new" },
      slots: [roleSlot("chat")],
    })

    expect(result.rows.length).toBeGreaterThan(0)
    expect(result.mirrored).toBe(false)
    expect(result.warning).toContain("this tab was not updated")
  })
})
