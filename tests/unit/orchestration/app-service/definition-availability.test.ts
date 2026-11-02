import { describe, expect, test } from "bun:test"
import type { AgentDefinition } from "../../../../src/infra/agent-definition.js"
import type { ModuleId } from "../../../../src/orchestration/modules.js"
import { createDefinitionAvailability } from "../../../../src/orchestration/app-service/definition-availability.js"
import { moduleDescriptor } from "../../../../src/orchestration/config/module-descriptor.js"
import type { CapabilityGrant } from "../../../../src/orchestration/config/module-policy.js"
import type { PersonaRegistryRevision } from "../../../../src/workflows/agents/registry.js"
import type { ProjectDefinitionRegistryRevision } from "../../../../src/workflows/definition-registry.js"
import type { SkillRegistryRevision } from "../../../../src/workflows/skill-schema.js"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { repoDefinitions, repoModules } from "../../../helpers/project-definitions.js"
import { nonEmpty } from "../../../helpers/non-empty.js"

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
const writer = persona("writer", "implementer", { tools: ["read", "memory"] })
/** Grants the implementer role, so it can reach `writer` and its memory tool. */
const lead = persona("lead", "lead", { subagentRoles: ["implementer"] })
/** Two grant hops from `writer`, and one from `reviewer`. */
const coordinator = persona("coordinator", "coordinator", { subagentRoles: ["lead", "reviewer"] })
const ping = persona("ping", "ping", { subagentRoles: ["pong"] })
const pong = persona("pong", "pong", { tools: ["read", "memory"], subagentRoles: ["ping"] })

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

  test("a persona derives requirements from requiredSkills, tools, and dispatchability", async () => {
    const withSubagents = await snapshotOf(["skills", "subagents"])
    expect(withSubagents.personas.get("reviewer")?.available).toBe(true)
    expect(withSubagents.personas.get("writer")?.missing).toEqual(["learning"])

    const withoutSkills = await snapshotOf(["subagents", "learning"])
    expect(withoutSkills.personas.get("reviewer")?.missing).toEqual(["skills"])
    expect(withoutSkills.personas.get("writer")?.available).toBe(true)

    const withoutSubagents = await snapshotOf(["skills", "learning"])
    expect(withoutSubagents.personas.get("reviewer")?.missing).toEqual(["subagents"])
    expect([...withoutSubagents.availablePersonas.keys()]).toEqual([])
  })

  test("a persona requires what the personas its roles grant require", async () => {
    const personas = personaRevision(reviewer, writer, lead, coordinator)
    const snapshot = await snapshotOf(["skills", "subagents"], { personas })
    // lead grants the implementer role, and the only implementer writes memory.
    expect(snapshot.personas.get("lead")?.missing).toEqual(["learning"])
    expect([...snapshot.availablePersonas.keys()].sort()).toEqual(["reviewer"])
  })

  test("a persona requirement carries through nested role grants", async () => {
    const personas = personaRevision(reviewer, writer, lead, coordinator)
    // coordinator -> lead -> writer for Learning, coordinator -> reviewer for Skills.
    const nested = await snapshotOf(["subagents"], { personas })
    expect(nested.personas.get("coordinator")?.missing).toEqual(["learning", "skills"])

    const withLearning = await snapshotOf(["subagents", "learning"], { personas })
    expect(withLearning.personas.get("coordinator")?.missing).toEqual(["skills"])

    const whole = await snapshotOf(["subagents", "learning", "skills"], { personas })
    expect(whole.personas.get("coordinator")?.available).toBe(true)
  })

  test("a role grant cycle terminates and folds both members' requirements", async () => {
    const personas = personaRevision(ping, pong)
    const snapshot = await snapshotOf(["subagents"], { personas })
    expect(snapshot.personas.get("ping")?.missing).toEqual(["learning"])
    expect(snapshot.personas.get("pong")?.missing).toEqual(["learning"])

    const enabled = await snapshotOf(["subagents", "learning"], { personas })
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
