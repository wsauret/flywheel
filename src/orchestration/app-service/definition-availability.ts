/** One orchestration-owned projection of what the installed definitions can do
 *  under the current optional-capability selection and the agent types a person
 *  turned off (ARCH-STRUCTURE-031, ARCH-STRUCTURE-044).
 *
 *  Definitions stay registered whatever the selection is: history, provenance,
 *  and identity never depend on a preference. Availability is derived here from
 *  authored metadata alone - a skill's agent slots and dependencies, a persona's
 *  required packages and every persona its role grants can reach, a workflow's
 *  phases - so no consumer copies a capability flag beside a definition. A
 *  persona's declared tools are a ceiling that dispatch narrows, never a
 *  requirement here.
 *
 *  An agent type is the general agent or a persona role. A persona needs its own
 *  type, and a skill needs the type of every agent it declares. A grant is not a
 *  need: a type that is off leaves the grant, never the persona that grants it.
 *
 *  Two things change at different rates, so they are owned separately. The
 *  requirement graph is read from the sources and walked once per skill and
 *  persona revision, inside `refresh`; the skill watcher and the capability
 *  listener drive it, and a burst of changes coalesces into one rebuild. A
 *  snapshot is that graph resolved against one capability selection and one set
 *  of turned-off types, memoized per pair.
 *
 *  Admission therefore reads no directory and walks no graph: it takes the
 *  published graph and resolves it under the grant the operation was admitted
 *  on, so a disable that lands after an operation started cannot change what it
 *  may reach. */

import type { AgentDefinition } from "../../infra/agent-definition.js"
import { errorMessage } from "../../infra/error-message.js"
import { definitionModuleRequirements, type FirstPartyModule, type ModuleId } from "../modules.js"
import { disabledAgentTypes, installedModules } from "../module-catalog.js"
import type { RuntimeConfigOwner } from "../config/runtime-config-owner.js"
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
import { moduleRequirementsForContribution } from "../module-requirements.js"
import { parentRoleId } from "../config/roles.js"

import { canonicalModuleIds, missingModuleIds, moduleDisabledReason } from "../../protocol/module-ids.js"
const log = Log.create({ service: "definition-availability" })

/** What one definition needs, what it lacks, and how it may be invoked. */
interface DefinitionAvailability {
  readonly id: string
  /** Capabilities the authored definition needs, in canonical order. */
  readonly requires: readonly ModuleId[]
  /** Agent types the authored definition needs, sorted: its own type for a persona, the type of each declared
   *  agent for a skill. */
  readonly types: readonly string[]
  /** The subset of `requires` the selection does not hold. Empty when available. */
  readonly missing: readonly ModuleId[]
  /** The entries of the turned-off list that turn off one of `types`. Empty when available. */
  readonly off: readonly string[]
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
  /** The agent types turned off, as `[subagents] disabled_types` lists them, sorted and without repeats. */
  readonly disabledTypes: readonly string[]
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
  /** The agent types turned off now, read from the live configuration (`configuredAgentTypes`). Absent: every type
   *  is on. */
  readonly agentTypes?: { disabled(): readonly string[] }
  /** The catalog requirements resolve against: the one this process installed,
   *  unless a test loaded a module's definition bundle from another. */
  readonly modules?: readonly FirstPartyModule[]
}

/** One admission's stable graph and the snapshots that graph derives under a grant. */
interface DefinitionAvailabilityCapture {
  readonly snapshot: DefinitionAvailabilitySnapshot
  /** The captured graph under `grant` and the agent types turned off at capture. */
  underGrant(grant: CapabilityGrant): DefinitionAvailabilitySnapshot
  /** The capabilities one workflow file needs, resolved against this captured graph. */
  workflowRequirements(workflow: WorkflowDefinition): readonly ModuleId[]
  /** Why the agent types turned off at capture keep `workflow` from running, or undefined when none does: an agent
   *  runs as, dispatches, or composes a skill that declares a type that is off. */
  workflowTypeRefusal(workflow: WorkflowDefinition): string | undefined
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
  const disabledTypes = (): readonly string[] => inputs.agentTypes?.disabled() ?? []
  // The unmatched entries of the turned-off list that were last recorded, so an unchanged set records once.
  let recordedUnmatched = ""
  const publish = (snapshot: DefinitionAvailabilitySnapshot): DefinitionAvailabilitySnapshot => {
    const unmatched = unmatchedAgentTypes(snapshot)
    const key = JSON.stringify(unmatched)
    if (key !== recordedUnmatched) {
      recordedUnmatched = key
      // The installed personas differ per project, so an entry that names none of them is harmless and decode
      // accepts it; this warning tells the person that it turns nothing off, such as a misspelled type.
      if (unmatched.length > 0) log.warn("subagents.disabled_types names no installed agent type", { ids: unmatched })
    }
    return snapshot
  }
  let graph = await loadGraph(inputs)
  let published = publish(derive(graph, inputs.capabilities.state().capabilities, disabledTypes()))
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
    const derived = derive(graph, inputs.capabilities.state().capabilities, disabledTypes())
    if (derived === published) return
    published = publish(derived)
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
      const capturedTypes = disabledTypes()
      return Object.freeze({
        snapshot: published,
        underGrant: (grant: CapabilityGrant) => derive(capturedGraph, grant.capabilities, capturedTypes),
        workflowRequirements: (workflow: WorkflowDefinition) => capturedGraph.closure.workflow(workflow).requires,
        workflowTypeRefusal: (workflow: WorkflowDefinition) => {
          const off = turnedOffTypes(capturedGraph.closure.workflow(workflow).types, capturedTypes)
          return off.length === 0 ? undefined : agentTypeDisabledReason(off)
        },
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

/** The agent types that the live configuration turns off, as the owner's input: `disabled` reads the published
 *  configuration, and `follow` refreshes `availability` after each configuration publication, so a changed
 *  `[subagents] disabled_types` republishes without a restart. A publication that leaves the types unchanged resolves
 *  to the snapshot already published and notifies nobody. `follow` returns the removal of its subscription. */
export function configuredAgentTypes(config: Pick<RuntimeConfigOwner, "snapshot" | "subscribeAll">) {
  return {
    disabled: (): readonly string[] => disabledAgentTypes(config.snapshot().config),
    follow: (availability: Pick<DefinitionAvailabilityOwner, "refresh">) => config.subscribeAll(() => { void availability.refresh() }),
  }
}

/** The entries of `snapshot.disabledTypes` that name no type of an installed persona and no parent role of one. */
function unmatchedAgentTypes(snapshot: DefinitionAvailabilitySnapshot): readonly string[] {
  if (snapshot.disabledTypes.length === 0) return []
  const installed = new Set([...snapshot.definitionRevision.personas.values()].flatMap(coveringTypes))
  return snapshot.disabledTypes.filter((type) => !installed.has(type))
}

const offeredTypes = new WeakMap<DefinitionAvailabilitySnapshot, ReadonlySet<string>>()

/** The agent types that `snapshot` offers: the type of each available persona, and the parent role that covers it.
 *  The `type:<id>` capability term holds exactly for these (ARCH-CONTEXT-033). */
export function availableAgentTypes(snapshot: DefinitionAvailabilitySnapshot): ReadonlySet<string> {
  let types = offeredTypes.get(snapshot)
  if (!types) {
    types = new Set([...snapshot.availablePersonas.values()].flatMap(coveringTypes))
    offeredTypes.set(snapshot, types)
  }
  return types
}

/** Why `snapshot` does not offer the agent type `type`, or undefined while it does: the reasons of the installed
 *  personas that `type` covers, which name the type and how to turn it on (PI-CAP-022). */
export function agentTypeRefusal(snapshot: DefinitionAvailabilitySnapshot, type: string): string | undefined {
  if (availableAgentTypes(snapshot).has(type)) return undefined
  const reasons = [...snapshot.definitionRevision.personas].flatMap(([name, persona]) => {
    const reason = coveringTypes(persona).includes(type) ? snapshot.personas.get(name)?.reason : undefined
    return reason === undefined ? [] : [reason]
  })
  return reasons.length > 0 ? sortedUnique(reasons).join(". ") : `no installed agent has the agent type ${type}`
}

/** The agent types that a persona belongs to: its own type, and the parent role that covers it. */
function coveringTypes(persona: AgentDefinition): readonly string[] {
  const type = agentTypeOf(persona)
  const parent = parentRoleId(type)
  return parent === undefined ? [type] : [type, parent]
}

/** The entries of `live.disabledTypes` that turn off an agent type that `tree` still offers: what an agent of a chat
 *  tree lost since the tree's capture, which the tree's shared text still describes (ARCH-CONTEXT-034). */
export function agentTypesTurnedOffSince(tree: DefinitionAvailabilitySnapshot, live: DefinitionAvailabilitySnapshot): readonly string[] {
  return sortedUnique([...tree.availablePersonas.values()].flatMap((persona) => turnedOffTypes([agentTypeOf(persona)], live.disabledTypes)))
}

/** What one definition needs, before any selection is applied. */
interface DefinitionRequirement extends Need {
  readonly modelInvocable: boolean
}

/** The modules and the agent types one definition needs. */
interface Need {
  readonly requires: readonly ModuleId[]
  /** Agent types: `general`, or a persona role, sorted and without repeats. */
  readonly types: readonly string[]
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
  /** One snapshot per capability selection and turned-off type set seen. Both
   *  come from a person's settings, which change rarely, so this cache stays
   *  small, and it is discarded whole with the graph it belongs to. */
  readonly derived: Map<string, DefinitionAvailabilitySnapshot>
}

async function loadGraph(
  inputs: DefinitionAvailabilityInputs,
  current?: DefinitionGraph,
): Promise<DefinitionGraph> {
  const definitionRevision = inputs.definitions.captureRevision()
  if (current && current.definitionRevision === definitionRevision) return current
  return inputs.modules ? buildGraph(definitionRevision, inputs.modules) : installedGraph(definitionRevision)
}

/** The requirement graph of each definition revision under the installed catalog, walked once per revision. */
const installedGraphs = new WeakMap<ProjectDefinitionRegistryRevision, DefinitionGraph>()

function installedGraph(definitionRevision: ProjectDefinitionRegistryRevision): DefinitionGraph {
  let graph = installedGraphs.get(definitionRevision)
  if (!graph) {
    graph = buildGraph(definitionRevision, installedModules())
    installedGraphs.set(definitionRevision, graph)
  }
  return graph
}

/** The availability of one definition revision under one module selection and one set of turned-off agent types,
 *  resolved against the installed catalog. A request derives its capability checks here: the tree check from its
 *  tree's capture, the agent check from its own selection and configuration (ARCH-CONTEXT-033). The graph and each
 *  pair's snapshot are memoized, so equal inputs return the same snapshot as the published owner for that revision. */
export function definitionAvailabilityOf(definitionRevision: ProjectDefinitionRegistryRevision, capabilities: Iterable<string>, disabledTypes: Iterable<string>): DefinitionAvailabilitySnapshot {
  return derive(installedGraph(definitionRevision), capabilities, disabledTypes)
}

function buildGraph(definitionRevision: ProjectDefinitionRegistryRevision, modules: readonly FirstPartyModule[]): DefinitionGraph {
  const skillRevision = definitionRevision.skills
  const personaRevision = definitionRevision.personaRevision
  const closure = createRequirementClosure(skillRevision, personaRevision.personas, modules)

  const skills = new Map<string, DefinitionRequirement>()
  for (const skill of skillRevision.skills.values()) {
    skills.set(skill.id, { ...closure.skill(skill.id), modelInvocable: skill.modelInvocable })
  }

  const personas = new Map<string, DefinitionRequirement>()
  for (const name of personaRevision.personas.keys()) {
    personas.set(name, { ...closure.persona(name), modelInvocable: true })
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
function derive(graph: DefinitionGraph, selected: Iterable<string>, turnedOff: Iterable<string>): DefinitionAvailabilitySnapshot {
  const capabilities = canonicalModuleIds(selected)
  const disabledTypes = sortedUnique(turnedOff)
  // A type is any string that a person lists, so only a lossless encoding keeps two lists apart.
  const key = JSON.stringify([capabilities, disabledTypes])
  const cached = graph.derived.get(key)
  if (cached) return cached

  const resolve = (requirements: ReadonlyMap<string, DefinitionRequirement>): ReadonlyMap<string, DefinitionAvailability> => {
    const resolved = new Map<string, DefinitionAvailability>()
    for (const [id, requirement] of requirements) resolved.set(id, entry(id, requirement, capabilities, disabledTypes))
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
    disabledTypes,
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
  disabledTypes: readonly string[],
): DefinitionAvailability {
  const missing = missingModuleIds(requirement.requires, selected)
  const off = turnedOffTypes(requirement.types, disabledTypes)
  const available = missing.length === 0 && off.length === 0
  const reasons = [...missing.length === 0 ? [] : [moduleDisabledReason(missing)], ...off.length === 0 ? [] : [agentTypeDisabledReason(off)]]
  return Object.freeze({
    id,
    requires: requirement.requires,
    types: requirement.types,
    missing,
    off,
    available,
    modelInvocable: available && requirement.modelInvocable,
    ...(available ? {} : { reason: reasons.join(". ") }),
  })
}

/** The entries of `disabledTypes` that turn off one of `types`: the type itself, or the parent role that covers it. */
function turnedOffTypes(types: readonly string[], disabledTypes: readonly string[]): readonly string[] {
  if (disabledTypes.length === 0) return []
  const disabled = new Set(disabledTypes)
  return sortedUnique(types.flatMap((type) => [type, parentRoleId(type)].filter((listed): listed is string => listed !== undefined && disabled.has(listed))))
}

function agentTypeDisabledReason(off: readonly string[]): string {
  const [noun, verb, pronoun] = off.length === 1 ? ["agent type", "is", "it"] : ["agent types", "are", "them"]
  return `${noun} ${off.join(", ")} ${verb} turned off. Remove ${pronoun} from subagents.disabled_types in flywheel.toml to turn ${pronoun} on`
}

function sortedUnique(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].toSorted()
}

/** The agent type of a persona: its role, or `general` for the general agent. */
export function agentTypeOf(definition: AgentDefinition): string {
  return definition.kind === "persona" ? definition.role : "general"
}

interface RequirementClosure {
  skill(id: string): Need
  persona(name: string): Need
  workflow(workflow: WorkflowDefinition): Need
}

/** What one workflow agent composes from its inline brief and persona. */
interface AgentComposition {
  readonly briefId: string
  readonly dependencies: readonly string[]
  readonly subagents: readonly string[]
  readonly persona: string | undefined
}

/** What each inline brief of `workflow` composes, in brief order. */
export function agentCompositions(workflow: WorkflowDefinition): readonly AgentComposition[] {
  const records = agentRecords(workflow)
  return [...workflowBriefs(workflow)].map(([briefId, brief]) => {
    const keys = records.get(briefId)?.keys
    const persona = keys?.persona
    return { briefId, dependencies: brief.procedure.dependencies, subagents: brief.procedure.subagents, persona }
  })
}

/** One node's requirements, and whether the walk below it was whole. */
interface Resolution extends Need {
  /** False when a cycle was cut below this node. The value is still correct for
   *  the node that was asked for - only its own frame was removed from the walk
   *  - but it is not correct for any other entry point, so it is not memoized. */
  readonly complete: boolean
}

/** Memoized requirement closures over the skill, persona, and workflow graph.
 *  Every node is expanded once, so an acyclic projection costs O(V+E).
 *
 *  A persona folds in the modules of every persona its `subagentRoles` grant
 *  reaches, through the same resolution dispatch itself uses: an agent that may
 *  spawn another needs whatever module that one needs, however deeply the grants
 *  nest. Agent types do not fold through grants: a granted type that is off
 *  leaves the grant, and the granting persona stays available. Grants are
 *  authored, so they may form a cycle: a node already on the stack contributes
 *  nothing further, which terminates the walk, and any result computed above a
 *  cut stays out of the memo so no later entry point inherits it. */
function createRequirementClosure(
  skills: SkillRegistryRevision,
  personas: ReadonlyMap<string, AgentDefinition>,
  modules: readonly FirstPartyModule[],
): RequirementClosure {
  const definitionRequirements = definitionModuleRequirements(modules)
  const skillMemo = new Map<string, Need>()
  const personaMemo = new Map<string, Need>()
  const active = new Set<string>()

  const own = (...requires: readonly ModuleId[]): Resolution => ({ requires, types: [], complete: true })
  const ownType = (type: string): Resolution => ({ requires: [], types: [type], complete: true })
  const modulesOnly = (resolution: Resolution): Resolution => ({ ...resolution, types: [] })
  const needOf = ({ requires, types }: Resolution): Need => ({ requires, types })

  const frame = (
    memo: Map<string, Need>,
    id: string,
    stackKey: string,
    expand: () => readonly Resolution[],
  ): Resolution => {
    const memoized = memo.get(id)
    if (memoized) return { ...memoized, complete: true }
    if (active.has(stackKey)) return { requires: [], types: [], complete: false }
    active.add(stackKey)
    const parts = expand()
    active.delete(stackKey)
    const need = { requires: canonicalModuleIds(parts.flatMap((part) => part.requires)), types: sortedUnique(parts.flatMap((part) => part.types)) }
    const complete = parts.every((part) => part.complete)
    if (complete) memo.set(id, need)
    return { ...need, complete }
  }

  const skill = (id: string): Resolution => frame(skillMemo, id, `skill:${id}`, () => {
    const definition = skills.skills.get(id)
    const parts: Resolution[] = [own(...definitionRequirements.skills)]
    if (!definition) return parts
    // A package from a module's definition bundle needs that module (ARCH-STRUCTURE-031).
    const bundle = definition.source.bundle
    if (bundle !== undefined) parts.push(own(...moduleRequirementsForContribution("definitions", bundle, modules)))
    if (definition.agents.length > 0) parts.push(own(...definitionRequirements.subagents))
    for (const dependency of definition.dependencies) parts.push(skill(dependency))
    // A skill needs the type of every agent it declares (ARCH-STRUCTURE-044).
    for (const name of definition.agents) parts.push(persona(name))
    // A delegated package states its method as its delegate's own, so it needs that agent's type.
    const delegate = definition.delegate === undefined ? undefined : personas.get(definition.delegate)
    if (delegate) parts.push(ownType(agentTypeOf(delegate)))
    return parts
  })

  const persona = (name: string): Resolution => frame(personaMemo, name, `persona:${name}`, () => {
    const definition = personas.get(name)
    // A persona is reachable only through dispatch, so it is unavailable
    // whenever dispatch is. Its declared tools are a ceiling, not a
    // requirement: a module that is off removes its tools from the persona,
    // which stays available with the rest (ARCH-STRUCTURE-031).
    const parts: Resolution[] = [own(...definitionRequirements.subagents)]
    if (!definition) return parts
    parts.push(ownType(agentTypeOf(definition)))
    if (definition.kind === "persona") {
      for (const id of definition.requiredSkills ?? []) parts.push(skill(id))
    }
    // Dispatch is reachability: whatever module a granted persona needs, an
    // agent that may spawn it needs too, however deeply the grants nest.
    for (const granted of grantedSubagentTypes(definition, personas)) parts.push(modulesOnly(persona(granted)))
    return parts
  })

  // An agent of a workflow needs what each persona it runs as or dispatches needs, and what each skill it composes
  // needs, agent types included: such a persona or skill cannot run while its type is off.
  const agent = (composition: AgentComposition): readonly Resolution[] => [
    ...composition.subagents.length > 0 ? [own(...definitionRequirements.subagents)] : [],
    ...composition.dependencies.map(skill),
    ...[...composition.subagents, ...composition.persona === undefined ? [] : [composition.persona]].map(persona),
  ]

  return {
    skill: (id) => needOf(skill(id)),
    persona: (name) => needOf(persona(name)),
    workflow: (workflow) => {
      const parts: Resolution[] = [own(...definitionRequirements.workflows)]
      // A workflow from a module's definition bundle needs that module (ARCH-STRUCTURE-031).
      if (workflow.provenance?.bundle !== undefined) parts.push(own(...moduleRequirementsForContribution("definitions", workflow.provenance.bundle, modules)))
      for (const composition of agentCompositions(workflow)) parts.push(...agent(composition))
      return { requires: canonicalModuleIds(parts.flatMap((part) => part.requires)), types: sortedUnique(parts.flatMap((part) => part.types)) }
    },
  }
}
