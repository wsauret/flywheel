import { describe, expect, spyOn, test } from "bun:test"
import { Log } from "../../../../src/infra/log.js"
import type { AgentDefinition } from "../../../../src/infra/agent-definition.js"
import type { ModuleId } from "../../../../src/orchestration/modules.js"
import { configuredAgentTypes, createDefinitionAvailability, type DefinitionAvailabilitySnapshot } from "../../../../src/orchestration/app-service/definition-availability.js"
import { createRuntimeConfigOwner } from "../../../../src/orchestration/config/runtime-config-owner.js"
import { moduleDescriptor } from "../../../../src/orchestration/config/module-descriptor.js"
import type { CapabilityGrant } from "../../../../src/orchestration/config/module-policy.js"
import type { PersonaRegistryRevision } from "../../../../src/workflows/agents/registry.js"
import type { ProjectDefinitionRegistryRevision } from "../../../../src/workflows/definition-registry.js"
import type { SkillRegistryRevision } from "../../../../src/workflows/skill-schema.js"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { repoDefinitions, repoModules } from "../../../helpers/project-definitions.js"
import { nonEmpty } from "../../../helpers/non-empty.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const temporaryDirectory = temporaryDirectories()

const persona = (name: string, role: string, overrides: Partial<Extract<AgentDefinition, { kind: "persona" }>> = {}): AgentDefinition => ({
  kind: "persona",
  name,
  description: `${name} persona.`,
  systemPrompt: "Work.",
  tools: ["read"],
  role,
  maxTurns: 20,
  ...overrides,
})

const reviewer = persona("reviewer", "reviewer", { tools: ["read", "search"], requiredSkills: ["code-review"] })
/** Declares the memory tool, which Learning serves: a ceiling, not a requirement. */
const writer = persona("writer", "implementer", { tools: ["read", "memory"] })
/** Grants the implementer role, so it can reach `writer`. */
const lead = persona("lead", "lead", { subagentRoles: ["implementer"] })
/** One grant hop from `reviewer`, which requires a skill. */
const coordinator = persona("coordinator", "coordinator", { subagentRoles: ["lead", "reviewer"] })
/** Requires a skill, two grant hops below `director`. */
const drafter = persona("drafter", "drafter", { requiredSkills: ["code-review"] })
const editor = persona("editor", "editor", { subagentRoles: ["drafter"] })
const director = persona("director", "director", { subagentRoles: ["editor"] })
const ping = persona("ping", "ping", { subagentRoles: ["pong"] })
const pong = persona("pong", "pong", { requiredSkills: ["code-review"], subagentRoles: ["ping"] })

const plain = testSkill("plain")
const codeReview = testSkill("code-review")
const withAgents = testSkill("delegating", { agents: ["reviewer"] })
const dependsOnDelegating = testSkill("composed", { dependencies: ["delegating"] })
const cyclicA = testSkill("cyclic-a", { dependencies: ["cyclic-b"] })
const cyclicB = testSkill("cyclic-b", { dependencies: ["cyclic-a"] })

const revision = testSkillRevision([plain, codeReview, withAgents, dependsOnDelegating, cyclicA, cyclicB])

/** A workflow with one phase for each named skill, each with an inline brief
 *  that composes that skill. */
const workflow = (id: string, skills: readonly string[], overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  id,
  name: id,
  phases: nonEmpty(skills.map((skill) => ({ phase: skill, brief: `Do the ${skill} work.`, name: skill, dependencies: [skill], writes: [] }))),
  ...overrides,
})

/** One persona revision, identified by the names it holds: a test that edits
 *  the tree states the new identity by listing the new members. */
function personaRevision(...agents: readonly AgentDefinition[]): PersonaRegistryRevision {
  return { revision: agents.map((agent) => agent.name).join("+"), personas: new Map(agents.map((agent) => [agent.name, agent])), resolutions: [] }
}

function projectRevision(
  personas: PersonaRegistryRevision,
  skills: SkillRegistryRevision = revision,
): ProjectDefinitionRegistryRevision {
  return {
    ...repoDefinitions().captureRevision(),
    skills,
    personaRevision: personas,
    personas: personas.personas,
  }
}

function grantOf(capabilities: readonly ModuleId[]): CapabilityGrant {
  return { operation: "test operation", required: capabilities, ...moduleDescriptor(capabilities, capabilities, true) }
}

function owner(
  capabilities: readonly ModuleId[],
  options: {
    readonly personas?: PersonaRegistryRevision
    readonly skills?: SkillRegistryRevision
    readonly error?: string
    readonly disabledTypes?: readonly string[]
  } = {},
) {
  const personas = options.personas ?? personaRevision(reviewer, writer)
  const definitionRevision = projectRevision(personas, options.skills)
  return createDefinitionAvailability({
    modules: repoModules,
    definitions: {
      captureRevision: () => definitionRevision,
    },
    capabilities: { state: () => moduleDescriptor(capabilities, capabilities, true, options.error) },
    agentTypes: { disabled: () => options.disabledTypes ?? [] },
  })
}

async function snapshotOf(capabilities: readonly ModuleId[], options: Parameters<typeof owner>[1] = {}) {
  return (await owner(capabilities, options)).snapshot()
}

test("availability retains the project revision that owns its personas", async () => {
  const personas = personaRevision(reviewer, writer)
  const snapshot = await snapshotOf(["workflows", "skills", "subagents"], { personas })

  expect(snapshot.definitionRevision.personaRevision).toBe(personas)
  expect(snapshot.availablePersonas.get("reviewer")).toBe(personas.personas.get("reviewer"))
})

describe("definition availability", () => {
  test("full selection makes every installed definition available", async () => {
    const snapshot = await snapshotOf(["workflows", "skills", "subagents", "learning", "background-commands"])
    expect(snapshot.skills.get("plain")?.available).toBe(true)
    expect(snapshot.personas.get("reviewer")?.available).toBe(true)
    expect([...snapshot.availablePersonas.keys()].sort()).toEqual(["reviewer", "writer"])
  })

  test("skills off makes every skill unavailable with one reason", async () => {
    const snapshot = await snapshotOf(["workflows", "subagents"])
    const skill = snapshot.skills.get("plain")
    expect(skill?.available).toBe(false)
    expect(skill?.missing).toEqual(["skills"])
    expect(skill?.reason).toBe("skills is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml")
  })

  test("workflows off leaves skills available", async () => {
    const snapshot = await snapshotOf(["skills", "subagents"])
    expect(snapshot.skills.get("plain")?.available).toBe(true)
  })

  test("a skill with authored agent slots requires subagents", async () => {
    const snapshot = await snapshotOf(["skills", "workflows"])
    expect(snapshot.skills.get("plain")?.available).toBe(true)
    expect(snapshot.skills.get("delegating")?.missing).toEqual(["subagents"])
    expect(snapshot.skills.get("delegating")?.reason).toBe("subagents is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml")
  })

  test("a skill dependency requirement is transitive", async () => {
    const snapshot = await snapshotOf(["skills", "workflows"])
    expect(snapshot.skills.get("composed")?.missing).toEqual(["subagents"])
  })

  test("a workflow derives requirements through its bindings and their persona closures", async () => {
    const captured = (await owner(["skills", "workflows"])).capture()
    expect(captured.workflowRequirements(workflow("plain-flow", ["plain"]))).toEqual(["skills", "workflows"])
    expect(captured.workflowRequirements(workflow("delegating-flow", ["delegating"]))).toEqual(["skills", "subagents", "workflows"])
  })

  test("a cyclic dependency terminates and stays available", async () => {
    const snapshot = await snapshotOf(["skills"])
    expect(snapshot.skills.get("cyclic-a")?.available).toBe(true)
    expect(snapshot.skills.get("cyclic-b")?.available).toBe(true)
  })

  test("a persona derives requirements from requiredSkills and dispatchability, and its declared tools are a ceiling, not a requirement", async () => {
    const withSubagents = await snapshotOf(["skills", "subagents"])
    expect(withSubagents.personas.get("reviewer")?.available).toBe(true)
    // Learning, which serves the declared memory tool, is off: the persona stays.
    expect(withSubagents.personas.get("writer")?.available).toBe(true)

    const withoutSkills = await snapshotOf(["subagents"])
    expect(withoutSkills.personas.get("reviewer")?.missing).toEqual(["skills"])
    expect(withoutSkills.personas.get("writer")?.available).toBe(true)

    const withoutSubagents = await snapshotOf(["skills", "learning"])
    expect(withoutSubagents.personas.get("reviewer")?.missing).toEqual(["subagents"])
    expect([...withoutSubagents.availablePersonas.keys()]).toEqual([])
  })

  test("a persona requires what the personas its roles grant require", async () => {
    const personas = personaRevision(reviewer, writer, lead, coordinator)
    const snapshot = await snapshotOf(["subagents"], { personas })
    // coordinator grants the reviewer role, and the only reviewer requires a skill.
    expect(snapshot.personas.get("coordinator")?.missing).toEqual(["skills"])
    expect([...snapshot.availablePersonas.keys()].sort()).toEqual(["lead", "writer"])
  })

  test("a persona requirement carries through nested role grants", async () => {
    const personas = personaRevision(drafter, editor, director)
    // director -> editor -> drafter for Skills.
    const nested = await snapshotOf(["subagents"], { personas })
    expect(nested.personas.get("director")?.missing).toEqual(["skills"])

    const whole = await snapshotOf(["subagents", "skills"], { personas })
    expect(whole.personas.get("director")?.available).toBe(true)
  })

  test("a role grant cycle terminates and folds both members' requirements", async () => {
    const personas = personaRevision(ping, pong)
    const snapshot = await snapshotOf(["subagents"], { personas })
    expect(snapshot.personas.get("ping")?.missing).toEqual(["skills"])
    expect(snapshot.personas.get("pong")?.missing).toEqual(["skills"])

    const enabled = await snapshotOf(["subagents", "skills"], { personas })
    expect([...enabled.availablePersonas.keys()].sort()).toEqual(["ping", "pong"])
  })

  test("Subagents off removes every persona and transitive role requirement", async () => {
    const personas = personaRevision(reviewer, writer, lead, coordinator)
    const snapshot = await snapshotOf(["skills", "learning"], { personas })

    expect([...snapshot.availablePersonas.keys()]).toEqual([])
    expect(snapshot.personas.get("coordinator")?.missing).toEqual(["subagents"])
  })

  test("model invocation eligibility follows the authored metadata and availability", async () => {
    const hidden = testSkill("hidden", { modelInvocable: false })
    const invocable = testSkill("invocable")
    const snapshot = await snapshotOf(["skills"], { skills: testSkillRevision([hidden, invocable]) })
    expect(snapshot.skills.get("hidden")).toMatchObject({ modelInvocable: false })
    expect(snapshot.skills.get("invocable")).toMatchObject({ modelInvocable: true })

    const disabled = await snapshotOf([], { skills: testSkillRevision([hidden, invocable]) })
    expect(disabled.skills.get("invocable")).toMatchObject({ modelInvocable: false })
  })

  test("a refresh observes a newly published project revision; an admitted snapshot does not", async () => {
    let definitions = projectRevision(personaRevision(reviewer))
    const availability = await createDefinitionAvailability({
      definitions: { captureRevision: () => definitions },
      modules: repoModules,
      capabilities: { state: () => moduleDescriptor(["skills", "subagents", "learning"], ["skills", "subagents", "learning"], true) },
    })
    const admitted = availability.snapshot()
    expect([...admitted.availablePersonas.keys()]).toEqual(["reviewer"])

    definitions = projectRevision(personaRevision(reviewer, writer))
    expect([...admitted.availablePersonas.keys()]).toEqual(["reviewer"])
    expect([...(await availability.refresh()).availablePersonas.keys()].sort()).toEqual(["reviewer", "writer"])
  })

  test("a refresh republishes the snapshot and notifies only on a change", async () => {
    let capabilities: readonly ModuleId[] = ["skills"]
    const definitions = projectRevision(personaRevision())
    const availability = await createDefinitionAvailability({
      definitions: { captureRevision: () => definitions },
      modules: repoModules,
      capabilities: { state: () => moduleDescriptor(capabilities, capabilities, true) },
    })
    const seen: number[] = []
    availability.onChange((snapshot) => { seen.push(snapshot.capabilities.length) })
    expect(await availability.refresh()).toBe(availability.snapshot())
    expect(seen).toEqual([])

    capabilities = []
    await availability.refresh()
    expect(seen).toEqual([0])
  })

  test("admission captures the published project revision without another source read", async () => {
    let reads = 0
    const definitions = projectRevision(personaRevision(reviewer, writer))
    const availability = await createDefinitionAvailability({
      definitions: { captureRevision: () => { reads += 1; return definitions } },
      modules: repoModules,
      capabilities: { state: () => moduleDescriptor(["skills", "subagents", "learning"], ["skills", "subagents", "learning"], true) },
    })
    expect(reads).toBe(1)

    const published = availability.snapshot()
    const captured = availability.capture()
    expect(captured.underGrant(grantOf(["skills", "subagents", "learning"]))).toBe(published)
    const narrowed = captured.underGrant(grantOf(["skills"]))
    expect(narrowed.definitionRevision).toBe(definitions)
    expect(narrowed.personas.get("reviewer")?.missing).toEqual(["subagents"])
    expect(reads).toBe(1)
  })

  test("a refresh of an unchanged project revision publishes the same snapshot", async () => {
    const availability = await owner(["skills", "subagents", "learning"])
    const published = availability.snapshot()
    expect(await availability.refresh()).toBe(published)
  })
})

describe("agent types turned off", () => {
  const ALL: readonly ModuleId[] = ["workflows", "skills", "subagents", "learning"]
  const general: AgentDefinition = { kind: "general", name: "general", description: "A clone.", maxTurns: 20, subagentRoles: ["explorer"] }
  const explorer = persona("explorer", "explorer")
  const advisor = persona("advisor", "advisor")
  const security = persona("reviewer-code-security", "reviewer-security")
  const quality = persona("reviewer-code-quality", "reviewer-quality")
  const custom = persona("triager", "triage")
  const personas = personaRevision(general, explorer, advisor, security, quality, custom)
  const offReason = (type: string) => `agent type ${type} is turned off. Remove it from subagents.disabled_types in flywheel.toml to turn it on`
  const available = async (disabledTypes: readonly string[], skills?: SkillRegistryRevision) =>
    [...(await snapshotOf(ALL, { personas, disabledTypes, ...(skills ? { skills } : {}) })).availablePersonas.keys()].sort()

  test("a role turns off its personas, with a reason that names the type and the key", async () => {
    const snapshot = await snapshotOf(ALL, { personas, disabledTypes: ["advisor"] })
    expect(snapshot.personas.get("advisor")).toMatchObject({ available: false, missing: [], reason: offReason("advisor") })
    expect(snapshot.disabledTypes).toEqual(["advisor"])
    expect([...snapshot.availablePersonas.keys()].sort()).toEqual(["explorer", "general", "reviewer-code-quality", "reviewer-code-security", "triager"])
  })

  test("the parent role reviewer turns off every reviewer role, and one reviewer role turns off alone", async () => {
    expect(await available(["reviewer"])).toEqual(["advisor", "explorer", "general", "triager"])
    const parent = await snapshotOf(ALL, { personas, disabledTypes: ["reviewer"] })
    expect(parent.personas.get("reviewer-code-security")?.reason).toBe(offReason("reviewer"))
    expect(await available(["reviewer-security"])).toEqual(["advisor", "explorer", "general", "reviewer-code-quality", "triager"])
  })

  test("general turns off the general agent, and a user persona's own role turns it off", async () => {
    expect(await available(["general"])).toEqual(["advisor", "explorer", "reviewer-code-quality", "reviewer-code-security", "triager"])
    expect(await available(["triage"])).toEqual(["advisor", "explorer", "general", "reviewer-code-quality", "reviewer-code-security"])
  })

  test("a type that is off leaves a grant, and the persona that grants it stays available", async () => {
    // general grants the explorer role.
    expect(await available(["explorer"])).toEqual(["advisor", "general", "reviewer-code-quality", "reviewer-code-security", "triager"])
  })

  test("a skill that declares an agent whose type is off is unavailable with that reason, through its dependents too", async () => {
    const delegating = testSkill("delegating", { agents: ["reviewer-code-security"] })
    const composed = testSkill("composed", { dependencies: ["delegating"] })
    const skills = testSkillRevision([plain, delegating, composed])
    const snapshot = await snapshotOf(ALL, { personas, skills, disabledTypes: ["reviewer-security"] })
    expect(snapshot.skills.get("delegating")).toMatchObject({ available: false, modelInvocable: false, reason: offReason("reviewer-security") })
    expect(snapshot.skills.get("composed")?.available).toBe(false)
    expect(snapshot.skills.get("plain")?.available).toBe(true)
    expect((await snapshotOf(ALL, { personas, skills, disabledTypes: ["advisor"] })).skills.get("delegating")?.available).toBe(true)
  })

  test("a package delegated to an agent whose type is off is unavailable, and a workflow that composes it is refused by the type", async () => {
    const ship = persona("ship", "ship", { requiredSkills: ["publish"] })
    const publish = testSkill("publish", { delegate: "ship" })
    const skills = testSkillRevision([plain, publish])
    const shipOff = await owner(ALL, { personas: personaRevision(general, ship), skills, disabledTypes: ["ship"] })
    expect(shipOff.snapshot().skills.get("publish")).toMatchObject({ available: false, reason: offReason("ship") })
    expect(shipOff.capture().workflowTypeRefusal(workflow("release", ["publish"]))).toBe(offReason("ship"))
    expect((await snapshotOf(ALL, { personas: personaRevision(general, ship), skills })).skills.get("publish")?.available).toBe(true)
  })

  test("every entry family resolves the same pair to the same snapshot, and a capture keeps the types it captured", async () => {
    let disabled: readonly string[] = ["advisor"]
    const definitions = projectRevision(personas)
    const availability = await createDefinitionAvailability({
      definitions: { captureRevision: () => definitions },
      modules: repoModules,
      capabilities: { state: () => moduleDescriptor(ALL, ALL, true) },
      agentTypes: { disabled: () => disabled },
    })
    const captured = availability.capture()
    expect(captured.underGrant(grantOf(ALL))).toBe(availability.snapshot())
    disabled = []
    expect(captured.underGrant(grantOf(ALL)).personas.get("advisor")?.available).toBe(false)
    expect(availability.capture().underGrant(grantOf(ALL)).personas.get("advisor")?.available).toBe(true)
  })

  test("an entry that names no installed type warns once per unmatched set at publication and turns nothing off", async () => {
    const warn = spyOn(Log.create({ service: "definition-availability" }), "warn").mockImplementation(() => {})
    try {
      let disabled: readonly string[] = ["Advisor", "reviewers"]
      const definitions = projectRevision(personas)
      const availability = await createDefinitionAvailability({
        definitions: { captureRevision: () => definitions },
        modules: repoModules,
        capabilities: { state: () => moduleDescriptor(ALL, ALL, true) },
        agentTypes: { disabled: () => disabled },
      })
      const unmatched = () => warn.mock.calls.map(([, attributes]) => attributes)
      expect(unmatched()).toEqual([{ ids: ["Advisor", "reviewers"] }])
      expect(availability.snapshot().availablePersonas.size).toBe(personas.personas.size)
      // A parent role that covers an installed persona is a match.
      disabled = ["Advisor", "reviewer", "reviewers"]
      await availability.refresh()
      expect(unmatched()).toEqual([{ ids: ["Advisor", "reviewers"] }])
      disabled = ["adviser"]
      await availability.refresh()
      expect(unmatched()).toEqual([{ ids: ["Advisor", "reviewers"] }, { ids: ["adviser"] }])
      expect(availability.snapshot().availablePersonas.size).toBe(personas.personas.size)
    } finally {
      warn.mockRestore()
    }
  })

  test("a published change of disabled_types republishes without a module change, and turning a type on restores it", async () => {
    const root = temporaryDirectory("definition-availability-types-")
    mkdirSync(join(root, ".flywheel"))
    const configPath = join(root, ".flywheel", "flywheel.toml")
    writeFileSync(configPath, "")
    const config = await createRuntimeConfigOwner({ configPath, watch: false })
    const definitions = projectRevision(personas)
    const agentTypes = configuredAgentTypes(config)
    const availability = await createDefinitionAvailability({
      definitions: { captureRevision: () => definitions },
      modules: repoModules,
      capabilities: { state: () => moduleDescriptor(ALL, ALL, true) },
      agentTypes,
    })
    const stop = agentTypes.follow(availability)
    const publish = async (toml: string) => {
      const changed = new Promise<DefinitionAvailabilitySnapshot>((resolve) => { const off = availability.onChange((snapshot) => { off(); resolve(snapshot) }) })
      writeFileSync(configPath, toml)
      await config.refresh()
      return changed
    }
    try {
      const before = availability.snapshot()
      const off = await publish('[subagents]\ndisabled_types = ["advisor", "reviewer"]\n')
      expect(off.identity).not.toBe(before.identity)
      expect(off.personas.get("advisor")?.available).toBe(false)
      expect(off.personas.get("reviewer-code-quality")?.available).toBe(false)
      // One entry that joins the two names is another list: it turns neither off.
      const joined = await publish('[subagents]\ndisabled_types = ["advisor\\u0000reviewer"]\n')
      expect(joined).not.toBe(off)
      expect(joined.personas.get("advisor")?.available).toBe(true)
      expect(await publish("")).toBe(before)
    } finally {
      await stop()
      await config.dispose()
    }
  })
})
