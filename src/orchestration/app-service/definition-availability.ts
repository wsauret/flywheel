/** One orchestration-owned projection of what the installed definitions can do
 *  under the current optional-capability selection (ARCH-STRUCTURE-031).
 *
 *  Definitions stay registered whatever the selection is: history, provenance,
 *  and identity never depend on a preference. Availability is derived here from
 *  authored metadata alone - a skill's agent slots and dependencies, a persona's
 *  required packages, its tools, and every persona its role grants can reach, a
 *  workflow's phases - so no consumer copies a capability flag beside a
 *  definition.
 *
 *  Two things change at different rates, so they are owned separately. The
 *  requirement graph is read from the sources and walked once per skill and
 *  persona revision, inside `refresh`; the skill watcher and the capability
 *  listener drive it, and a burst of changes coalesces into one rebuild. A
 *  snapshot is that graph resolved against one capability selection, memoized
 *  per selection.
 *
 *  Admission therefore reads no directory and walks no graph: it takes the
 *  published graph and resolves it under the grant the operation was admitted
 *  on, so a disable that lands after an operation started cannot change what it
 *  may reach. */

import type { AgentDefinition } from "../../infra/agent-definition.js"
import { errorMessage } from "../../infra/error-message.js"
import { definitionModuleRequirements, type FirstPartyModule, type ModuleId } from "../modules.js"
import { createToolRegistry } from "../tool-catalog.js"
import { installedModules } from "../module-catalog.js"
import { Log } from "../../infra/log.js"
import type { PersonaRegistryRevision } from "../../workflows/agents/registry.js"
import type { ProjectDefinitionRegistryRevision } from "../../workflows/definition-registry.js"
import { grantedSubagentTypes } from "../../workflows/agents/subagent-reachability.js"
import type { SkillRegistryRevision } from "../../workflows/skill-schema.js"
import type { WorkflowDefinition } from "../../workflows/workflow-schema.js"
import { workflowBriefs } from "../../workflows/brief.js"
import { agentRecords } from "../../workflows/workflow-schema.js"
import type { CapabilityGrant } from "../config/module-policy.js"
import type { ModuleState } from "../config/module-descriptor.js"
import { toolModuleRequirements } from "../agent-runtime/tools/tool-registry.js"
import { moduleRequirementsForContribution } from "../module-requirements.js"

import { canonicalModuleIds, missingModuleIds, moduleDisabledReason } from "../../protocol/module-ids.js"
const log = Log.create({ service: "definition-availability" })

/** What one definition needs, what it lacks, and how it may be invoked. */
interface DefinitionAvailability {
  readonly id: string
  /** Capabilities the authored definition needs, in canonical order. */
  readonly requires: readonly ModuleId[]
  /** The subset of `requires` the selection does not hold. Empty when available. */
  readonly missing: readonly ModuleId[]
  readonly available: boolean
  readonly modelInvocable: boolean
  /** One concise sentence naming why this definition is unavailable. */
  readonly reason?: string
}

export interface DefinitionAvailabilitySnapshot {
  /** Identity of this publication: the definition revisions it was built from
   *  and the selection it was resolved against. Two snapshots with the same
   *  identity hold the same availability for every definition. */
  readonly identity: string
  readonly capabilities: readonly ModuleId[]
  /** The skill revision this snapshot was derived from. */
  readonly skillRevision: SkillRegistryRevision
  /** The whole project capture that supplied this availability candidate. */
  readonly definitionRevision: ProjectDefinitionRegistryRevision
  readonly skills: ReadonlyMap<string, DefinitionAvailability>
  readonly personas: ReadonlyMap<string, DefinitionAvailability>
  /** Personas an admitted operation may dispatch: the captured map with every
   *  unavailable persona removed. Runtime assembly receives this map and never
   *  reads the persona tree again inside a request. */
  readonly availablePersonas: ReadonlyMap<string, AgentDefinition>
}

/** The definition and capability sources one projection derives from. */
export interface DefinitionAvailabilityInputs {
  readonly definitions: {
    /** Capture the already-published project catalog by one reference read. */
    captureRevision(): ProjectDefinitionRegistryRevision
  }
  /** Live capability projection. Availability is a publication view, so it reads
   *  the projection; admission of new work is the policy's own boundary. */
  readonly capabilities: { state(): ModuleState }
  /** The catalog requirements resolve against: the one this process installed,
   *  unless a test loaded a module's definition bundle from another. */
  readonly modules?: readonly FirstPartyModule[]
}

/** One admission's stable graph and the snapshots that graph derives under a grant. */
interface DefinitionAvailabilityCapture {
  readonly snapshot: DefinitionAvailabilitySnapshot
  underGrant(grant: CapabilityGrant): DefinitionAvailabilitySnapshot
  /** The capabilities one workflow file needs, resolved against this captured graph. */
  workflowRequirements(workflow: WorkflowDefinition): readonly ModuleId[]
}

export interface DefinitionAvailabilityOwner {
  /** The last published snapshot. Command publication and model assignment read here. */
  snapshot(): DefinitionAvailabilitySnapshot
  /** Capture one published graph before an asynchronous admission decision. The
   * returned grant resolver never observes a later refresh. */
  capture(): DefinitionAvailabilityCapture
  /** Read the definition sources again and republish. A skill reload and a
   *  capability change both land here; calls that arrive while one is running
   *  coalesce into a single further read, and a revision that did not change
   *  reuses the graph it already walked. */
  refresh(): Promise<DefinitionAvailabilitySnapshot>
  /** Join the refresh already started by a synchronous source notification. If
   *  no refresh is active, the current snapshot is already settled. */
  settled(): Promise<DefinitionAvailabilitySnapshot>
  onChange(listener: (snapshot: DefinitionAvailabilitySnapshot) => void): () => void
}

export async function createDefinitionAvailability(
  inputs: DefinitionAvailabilityInputs,
): Promise<DefinitionAvailabilityOwner> {
  const listeners = new Set<(snapshot: DefinitionAvailabilitySnapshot) => void>()
  let graph = await loadGraph(inputs)
  let published = derive(graph, inputs.capabilities.state().capabilities)
  // One read cycle at a time. Everything that asks while one runs shares the
  // single further read that follows it, so a burst of watcher events costs two
  // rebuilds at most and every caller still observes its own change.
  let cycle: Promise<DefinitionAvailabilitySnapshot> | undefined
  let repeat = false

  const reload = async (): Promise<void> => {
    // Keep-last-valid, matching the skill registry: a torn or invalid source
    // read during a refresh (a definition file mid-edit) keeps the last valid
    // graph instead of escaping into the fire-and-forget refresh callers.
    // Only the startup load above throws: a broken install must fail loudly,
    // not boot as an empty roster. The retained graph is still re-derived
    // below, so a capability change that races the bad read publishes.
    try {
      graph = await loadGraph(inputs, graph)
    } catch (err) {
      log.error("definition refresh failed, keeping published snapshot", { identity: graph.identity, error: errorMessage(err) })
    }
    const derived = derive(graph, inputs.capabilities.state().capabilities)
    if (derived === published) return
    published = derived
    for (const listener of listeners) listener(derived)
  }

  const drain = async (): Promise<DefinitionAvailabilitySnapshot> => {
    do {
      repeat = false
      await reload()
    } while (repeat)
    return published
  }

  return {
    snapshot: () => published,
    capture: () => {
      const capturedGraph = graph
      return Object.freeze({
        snapshot: published,
        underGrant: (grant: CapabilityGrant) => derive(capturedGraph, grant.capabilities),
        workflowRequirements: (workflow: WorkflowDefinition) => capturedGraph.closure.workflow(workflow),
      })
    },
    refresh: () => {
      if (cycle) {
        repeat = true
        return cycle
      }
      cycle = drain().finally(() => { cycle = undefined })
      return cycle
    },
    settled: () => cycle ?? Promise.resolve(published),
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** Persona roles an admitted operation can actually dispatch, derived from the
 *  available personas. Model assignment reads it: a role no available persona
 *  fills is not an assignable slot. */
export function availableAgentRoles(snapshot: DefinitionAvailabilitySnapshot): ReadonlySet<string> {
  const roles = new Set<string>()
  for (const persona of snapshot.availablePersonas.values()) {
    if (persona.kind === "persona") roles.add(persona.role)
  }
  return roles
}

/** What one definition needs, before any selection is applied. */
interface DefinitionRequirement {
  readonly requires: readonly ModuleId[]
  readonly modelInvocable: boolean
}

/** The requirement graph of one skill revision and one persona revision, plus
 *  the snapshots already resolved from it. Walking the graph is the only
 *  expensive work in this module, so it happens once per revision pair and
 *  every selection reads the result. */
interface DefinitionGraph {
  readonly identity: string
  readonly skillRevision: SkillRegistryRevision
  readonly personaRevision: PersonaRegistryRevision
  readonly definitionRevision: ProjectDefinitionRegistryRevision
  /** The requirement walk this graph was built with. It memoizes every
   *  skill and persona it expanded, so a definition outside the graph costs
   *  only its own steps. */
  readonly closure: RequirementClosure
  readonly requirements: {
    readonly skills: ReadonlyMap<string, DefinitionRequirement>
    readonly personas: ReadonlyMap<string, DefinitionRequirement>
  }
  /** One snapshot per capability selection seen. The canonical capability set
   *  is finite and small, so this cache is bounded by construction, and it is
   *  discarded whole with the graph it belongs to. */
  readonly derived: Map<string, DefinitionAvailabilitySnapshot>
}

async function loadGraph(
  inputs: DefinitionAvailabilityInputs,
  current?: DefinitionGraph,
): Promise<DefinitionGraph> {
  const definitionRevision = inputs.definitions.captureRevision()
  if (current && current.definitionRevision === definitionRevision) return current
  return buildGraph(definitionRevision, inputs.modules ?? installedModules())
}

function buildGraph(definitionRevision: ProjectDefinitionRegistryRevision, modules: readonly FirstPartyModule[]): DefinitionGraph {
  const skillRevision = definitionRevision.skills
  const personaRevision = definitionRevision.personaRevision
  const closure = createRequirementClosure(skillRevision, personaRevision.personas, modules)

  const skills = new Map<string, DefinitionRequirement>()
  for (const skill of skillRevision.skills.values()) {
    skills.set(skill.id, { requires: closure.skill(skill.id), modelInvocable: skill.modelInvocable })
  }

  const personas = new Map<string, DefinitionRequirement>()
  for (const name of personaRevision.personas.keys()) {
    personas.set(name, { requires: closure.persona(name), modelInvocable: true })
  }

  return {
    definitionRevision,
    closure,
    identity: `${skillRevision.revision}:${personaRevision.revision}`,
    skillRevision,
    personaRevision,
    requirements: { skills, personas },
    derived: new Map(),
  }
}

/** Resolve one graph against one selection, or return the resolution it already
 *  holds. Nothing here reads a source. */
function derive(graph: DefinitionGraph, selected: readonly ModuleId[]): DefinitionAvailabilitySnapshot {
  const capabilities = canonicalModuleIds(selected)
  const key = capabilities.join("+")
  const cached = graph.derived.get(key)
  if (cached) return cached

  const resolve = (requirements: ReadonlyMap<string, DefinitionRequirement>): ReadonlyMap<string, DefinitionAvailability> => {
    const resolved = new Map<string, DefinitionAvailability>()
    for (const [id, requirement] of requirements) resolved.set(id, entry(id, requirement, capabilities))
    return resolved
  }

  const personas = resolve(graph.requirements.personas)
  const availablePersonas = new Map<string, AgentDefinition>()
  for (const [name, persona] of graph.personaRevision.personas) {
    if (personas.get(name)?.available) availablePersonas.set(name, persona)
  }

  const snapshot = Object.freeze({
    identity: `${graph.identity}|${key}`,
    capabilities,
    skillRevision: graph.skillRevision,
    definitionRevision: graph.definitionRevision,
    skills: resolve(graph.requirements.skills),
    personas,
    availablePersonas,
  })
  graph.derived.set(key, snapshot)
  return snapshot
}

function entry(
  id: string,
  requirement: DefinitionRequirement,
  selected: readonly ModuleId[],
): DefinitionAvailability {
  const missing = missingModuleIds(requirement.requires, selected)
  const available = missing.length === 0
  return Object.freeze({
    id,
    requires: requirement.requires,
    missing,
    available,
    modelInvocable: available && requirement.modelInvocable,
    ...(available ? {} : { reason: moduleDisabledReason(missing) }),
  })
}

interface RequirementClosure {
  skill(id: string): readonly ModuleId[]
  persona(name: string): readonly ModuleId[]
  workflow(workflow: WorkflowDefinition): readonly ModuleId[]
}

/** What one workflow agent composes from its inline brief and persona. */
interface AgentComposition {
  readonly dependencies: readonly string[]
  readonly subagents: readonly string[]
  readonly persona: string | undefined
}

function agentCompositions(workflow: WorkflowDefinition): readonly AgentComposition[] {
  const records = agentRecords(workflow)
  return [...workflowBriefs(workflow)].map(([definitionId, brief]) => {
    const keys = records.get(definitionId)?.keys
    const persona = keys?.persona
    return { dependencies: brief.procedure.dependencies, subagents: brief.procedure.subagents, persona }
  })
}

/** One node's requirements, and whether the walk below it was whole. */
interface Resolution {
  readonly requires: readonly ModuleId[]
  /** False when a cycle was cut below this node. The value is still correct for
   *  the node that was asked for - only its own frame was removed from the walk
   *  - but it is not correct for any other entry point, so it is not memoized. */
  readonly complete: boolean
}

/** Memoized requirement closures over the skill, persona, and workflow graph.
 *  Every node is expanded once, so an acyclic projection costs O(V+E).
 *
 *  A persona folds in every persona its `subagentRoles` grant reaches, through
 *  the same resolution dispatch itself uses: an agent that may spawn another
 *  needs whatever that one needs, however deeply the grants nest. Grants are
 *  authored, so they may form a cycle: a node already on the stack contributes
 *  nothing further, which terminates the walk, and any result computed above a
 *  cut stays out of the memo so no later entry point inherits it. */
function createRequirementClosure(
  skills: SkillRegistryRevision,
  personas: ReadonlyMap<string, AgentDefinition>,
  modules: readonly FirstPartyModule[],
): RequirementClosure {
  const toolRegistry = createToolRegistry(modules)
  const definitionRequirements = definitionModuleRequirements(modules)
  const skillMemo = new Map<string, readonly ModuleId[]>()
  const personaMemo = new Map<string, readonly ModuleId[]>()
  const active = new Set<string>()

  const own = (...requires: readonly ModuleId[]): Resolution => ({ requires, complete: true })

  const frame = (
    memo: Map<string, readonly ModuleId[]>,
    id: string,
    stackKey: string,
    expand: () => readonly Resolution[],
  ): Resolution => {
    const memoized = memo.get(id)
    if (memoized) return { requires: memoized, complete: true }
    if (active.has(stackKey)) return { requires: [], complete: false }
    active.add(stackKey)
    const parts = expand()
    active.delete(stackKey)
    const requires = canonicalModuleIds(parts.flatMap((part) => part.requires))
    const complete = parts.every((part) => part.complete)
    if (complete) memo.set(id, requires)
    return { requires, complete }
  }

  const skill = (id: string): Resolution => frame(skillMemo, id, `skill:${id}`, () => {
    const definition = skills.skills.get(id)
    const parts: Resolution[] = [own(...definitionRequirements.skills)]
    if (!definition) return parts
    // A package from a module's definition bundle needs that module (ARCH-STRUCTURE-031).
    if (definition.source.kind === "filesystem" && definition.source.bundle !== undefined) parts.push(own(...moduleRequirementsForContribution("definitions", definition.source.bundle, modules)))
    if (definition.agents.length > 0) parts.push(own(...definitionRequirements.subagents))
    for (const dependency of definition.dependencies) parts.push(skill(dependency))
    for (const name of definition.agents) parts.push(persona(name))
    return parts
  })

  const persona = (name: string): Resolution => frame(personaMemo, name, `persona:${name}`, () => {
    const definition = personas.get(name)
    // A persona is reachable only through dispatch, so it is unavailable
    // whenever dispatch is.
    const parts: Resolution[] = [own(...definitionRequirements.subagents)]
    if (!definition) return parts
    if (definition.kind === "persona") {
      for (const id of definition.requiredSkills ?? []) parts.push(skill(id))
      for (const tool of definition.tools) parts.push(own(...toolModuleRequirements(tool, toolRegistry)))
    }
    // Dispatch is reachability: whatever a granted persona needs, an agent that
    // may spawn it needs too, however deeply the grants nest.
    for (const granted of grantedSubagentTypes(definition, personas)) parts.push(persona(granted))
    return parts
  })

  const agent = (composition: AgentComposition): readonly ModuleId[] => {
    const required: ModuleId[] = []
    if (composition.subagents.length > 0) required.push(...definitionRequirements.subagents)
    for (const id of composition.dependencies) required.push(...skill(id).requires)
    for (const name of [...composition.subagents, ...composition.persona === undefined ? [] : [composition.persona]]) required.push(...persona(name).requires)
    return canonicalModuleIds(required)
  }

  return {
    skill: (id) => skill(id).requires,
    persona: (name) => persona(name).requires,
    workflow: (workflow) => {
      const required: ModuleId[] = [...definitionRequirements.workflows]
      // A workflow from a module's definition bundle needs that module (ARCH-STRUCTURE-031).
      if (workflow.provenance?.bundle !== undefined) required.push(...moduleRequirementsForContribution("definitions", workflow.provenance.bundle, modules))
      for (const composition of agentCompositions(workflow)) required.push(...agent(composition))
      return canonicalModuleIds(required)
    },
  }
}
