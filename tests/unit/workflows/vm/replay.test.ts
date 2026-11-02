import { describe, expect, it } from "bun:test"
import type { AsyncGuardedEventWriter, GuardedEventStoreAppend, StoredFact } from "../../../../src/infra/event-store-types.js"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import type { AgentDefinition } from "../../../../src/infra/agent-definition.js"
import { hashDefinition } from "../../../../src/workflows/definition-hash.js"
import {
  buildDefinitionIdentity,
  DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID,
  DEFINITION_IDENTITY_DEFAULT_ADVISOR_MIGRATION_ID,
  DEFINITION_IDENTITY_PERSONA_BUDGET_MIGRATION_ID,
  DEFINITION_IDENTITY_TOOL_STEERING_MIGRATION_ID,
  DEFINITION_IDENTITY_PERSONA_PROMPT_SWITCHES_MIGRATION_ID,
  DEFINITION_IDENTITY_LEXICON_PERSONAS_MIGRATION_ID,
  WorkflowDefinitionDriftError,
  type DefinitionIdentity,
} from "../../../../src/workflows/vm/definition-identity.js"
import { replayWorkflowFromFacts } from "../../../../src/workflows/vm/replay.js"
import { foldWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { beforeLexiconCut, beforeToolSteeringCut } from "../../orchestration/migrations/_persona-budget.js"
import { recoverWorkflowControl } from "../../../../src/workflows/vm/recovery.js"
import {
  buildWorkflowControlInitializedFact,
  buildDefinitionIdentityMigratedFact,
  parseWorkflowSessionFact,
  type WorkflowSessionFact,
} from "../../../../src/workflows/vm/session-facts.js"
import { initializeWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"

/** One phase that composes the `work` package. */
const workPhase = { phase: "work", brief: "Follow the work method.", name: "Work", dependencies: ["work"], writes: [] }
const workflow: WorkflowDefinition = {
  id: "workflow",
  name: "Workflow",
  phases: [workPhase],
}
const skills = testSkillRevision([testSkill("work", { name: "Work" })])
const bindings = resolveWorkflowAgents(workflow)

/** The package as it reads today: taking a dependency changes both its own
 *  rendered hash and the identity's skill closure, which is the drift a legacy
 *  session records none of. */
const dependentSkills = testSkillRevision([testSkill("work", { name: "Work", dependencies: ["implementation"] }), testSkill("implementation")])
const dependentBindings = resolveWorkflowAgents(workflow)

function storedFact(fact: WorkflowSessionFact, seq: number): StoredFact {
  return {
    id: `event-${seq}`,
    position: seq + 1,
    seq,
    aggregateId: "session:session",
    sessionId: "session",
    timestamp: 10,
    type: fact.type,
    version: fact.version,
    actor: fact.actor,
    payload: fact.payload,
  }
}

function writer(appends: GuardedEventStoreAppend[]): AsyncGuardedEventWriter {
  return {
    append: async (event) => {
      appends.push(event)
      return { ...event, id: `diagnostic-${appends.length}`, position: appends.length, seq: appends.length - 1 }
    },
    appendBatch: async () => { throw new Error("replay must not commit batches") },
    appendGuarded: async (event) => {
      appends.push(event)
      const { expectedSeq, ...persisted } = event
      return { kind: "stored", events: [{ ...persisted, id: `diagnostic-${appends.length}`, position: appends.length, seq: expectedSeq ?? appends.length - 1 }] }
    },
    appendBatchGuarded: async () => { throw new Error("replay must not commit guarded batches") },
    pruneSupersededEvents: async () => 0,
  }
}

function deps(
  appends: GuardedEventStoreAppend[],
  selectedSkills = skills,
  personas: ReadonlyMap<string, AgentDefinition> = new Map(),
  selectedWorkflow = workflow,
) {
  const captured = repoDefinitions().captureRevision()
  return {
    sessionId: "session",
    writer: writer(appends),
    definitionRevision: Object.freeze({
      ...captured,
      skills: selectedSkills,
      personas,
    }),
    workflow: selectedWorkflow,
    now: () => 10,
  }
}

describe("workflow fact replay", () => {
  it("strictly folds committed facts into a fresh machine before the next pure transition", async () => {
    const initialized = buildWorkflowControlInitializedFact(
      compileWorkflowControl(workflow, bindings, { skills }),
    )
    const committed = initialized.payload.control
    const paused = transitionWorkflow(initializeWorkflow(committed).state, {
      type: "PAUSE", reason: "operator",
    })
    if (paused.command.kind !== "commit" || !paused.state.context.pending) throw new Error("Pause must propose a commit")

    const result = await replayWorkflowFromFacts(
      [
        storedFact(initialized, 0),
        ...paused.command.proposal.facts.map((fact, index) => storedFact(fact, index + 1)),
      ],
      { type: "RESUME", readers: {} },
      deps([]),
    )

    expect(result.state.lifecycle).toBe("awaiting_commit")
    expect(result.state.context.committed).toEqual(paused.state.context.pending.proposedCommitted)
    expect(result.state.context.pending?.previousCommitted).toEqual(paused.state.context.pending.proposedCommitted)
    expect(result.command.kind).toBe("commit")
  })

  it("rejects malformed internally owned control facts without tolerance", async () => {
    const initialized = buildWorkflowControlInitializedFact(
      compileWorkflowControl(workflow, bindings, { skills }),
    )
    const malformed = { ...storedFact(initialized, 0), payload: { ...initialized.payload, extra: true } }
    const appends: GuardedEventStoreAppend[] = []

    await expect(replayWorkflowFromFacts([malformed], { type: "START" }, deps(appends))).rejects.toThrow()
    expect(appends).toEqual([])
  })

  it("reads a stored companion by its type and position, so its unreadable body does not stop the run", async () => {
    const initialized = buildWorkflowControlInitializedFact(
      compileWorkflowControl(workflow, bindings, { skills }),
    )
    const malformedQueueFact = {
      ...storedFact(initialized, 1),
      type: "queue.state.changed",
      payload: {},
    }

    const result = await replayWorkflowFromFacts([storedFact(initialized, 0), malformedQueueFact], { type: "START" }, deps([]))
    expect(result.command.kind).toBe("commit")
    // A batch that no store positioned is a current write, so every body
    // still parses strictly.
    expect(() => foldWorkflowControl(null, [initialized, { type: "queue.state.changed", version: 1, actor: "flywheel", payload: {} }])).toThrow()
  })

  it("plans typed paused recovery without mixing malformed control", () => {
    const initialized = buildWorkflowControlInitializedFact(
      compileWorkflowControl(workflow, bindings, { skills }),
    )
    const malformed = { ...storedFact(initialized, 0), payload: { broken: true } }

    expect(recoverWorkflowControl([malformed])).toMatchObject({
      kind: "recovery",
      executable: false,
      status: "paused",
      reasons: [{ kind: "malformed_fact", seq: 0 }],
    })
    expect(recoverWorkflowControl([])).toMatchObject({
      kind: "recovery",
      executable: false,
      reasons: [{ kind: "missing_root" }],
    })
  })

  it("records definition drift and throws before calculating a transition", async () => {
    const initialized = buildWorkflowControlInitializedFact(
      compileWorkflowControl(workflow, bindings, { skills }),
    )
    const appends: GuardedEventStoreAppend[] = []
    const trailing = parseWorkflowSessionFact({
      type: "queue.deleted", version: 1, actor: "flywheel", payload: {},
    })

    await expect(replayWorkflowFromFacts(
      [storedFact(initialized, 0), storedFact(trailing, 1)],
      { type: "START" },
      deps(appends),
      { vmVersion: "3" },
    )).rejects.toBeInstanceOf(WorkflowDefinitionDriftError)

    expect(appends).toHaveLength(1)
    expect(appends[0]).toMatchObject({
      aggregateId: "workflow:session",
      sessionId: "session",
      timestamp: 10,
      type: "definition.drift_rejected",
      version: 1,
      actor: "flywheel",
      payload: {
        workflowId: "workflow",
        latestSeq: 2,
        changes: [{ component: "version", recorded: "2", current: "3" }],
      },
    })
  })

  it("adopts a legacy no-skills identity recorded by a migration fact", async () => {
    const { adopted, facts } = legacyAdoption()
    const appends: GuardedEventStoreAppend[] = []

    const result = await replayWorkflowFromFacts(
      facts,
      { type: "START" },
      deps(appends, dependentSkills),
    )

    expect(appends).toEqual([])
    expect(result.state.context.committed.definitionIdentity).toEqual(adopted)
  })

  it("reports later ordinary drift against the adopted identity", async () => {
    const { facts } = legacyAdoption()
    const appends: GuardedEventStoreAppend[] = []

    await expect(replayWorkflowFromFacts(
      facts,
      { type: "START" },
      deps(appends, dependentSkills),
      { vmVersion: "3" },
    )).rejects.toBeInstanceOf(WorkflowDefinitionDriftError)

    expect(appends).toHaveLength(1)
    expect(appends[0]).toMatchObject({
      type: "definition.drift_rejected",
      payload: {
        workflowId: "workflow",
        latestSeq: 2,
        changes: [{ component: "version", recorded: "2", current: "3" }],
      },
    })
  })

  it("adopts persona hashes recorded over a turn cap once, for a project persona and the general agent, then the advisor default once", async () => {
    const { facts, personas, current } = pausedOverTurnCaps()
    const appends: GuardedEventStoreAppend[] = []

    const result = await replayWorkflowFromFacts(facts, { type: "RESUME", readers: {} }, deps(appends, skills, personas, agentWorkflow))

    expect(appends).toHaveLength(2)
    expect(appends).toMatchObject([
      { type: "workflow.definition_identity.migrated", payload: { migrationId: DEFINITION_IDENTITY_PERSONA_BUDGET_MIGRATION_ID } },
      { type: "workflow.definition_identity.migrated", payload: { migrationId: DEFINITION_IDENTITY_DEFAULT_ADVISOR_MIGRATION_ID } },
    ])
    expect(result.state.context.committed.definitionIdentity).toEqual(current)
    const adoptions = appends.map(({ expectedSeq: _expectedSeq, ...persisted }, index) => ({ ...persisted, id: `adoption-${index}`, position: facts.length + index + 1, seq: facts.length + index }))
    const resumedAgain: GuardedEventStoreAppend[] = []
    await replayWorkflowFromFacts([...facts, ...adoptions], { type: "RESUME", readers: {} }, deps(resumedAgain, skills, personas, agentWorkflow))
    expect(resumedAgain).toEqual([])
  })

  it("adopts the advisor default and the skills it requires for a run recorded before it, and still reports a later advisor edit as drift", async () => {
    const bundled = repoDefinitions().captureRevision().personas.get("advisor")
    if (bundled?.kind !== "persona") throw new Error("Expected the bundled advisor")
    // A project advisor override that requires a skill, which a run recorded before the default pinned neither of.
    const advisor = { ...bundled, requiredSkills: ["implementation"] }
    const personas = new Map<string, AgentDefinition>([["advisor", advisor]])
    const advisorSkills = testSkillRevision([testSkill("work", { name: "Work" }), testSkill("implementation")])
    const compiled = compileWorkflowControl(workflow, bindings, { skills: advisorSkills, personas })
    expect(compiled.definitionIdentity.skills.map(({ skillId }) => skillId)).toEqual(["implementation", "work"])
    const recorded = { ...compiled.definitionIdentity, personas: [], skills: compiled.definitionIdentity.skills.filter(({ skillId }) => skillId === "work") }
    const initialized = buildWorkflowControlInitializedFact({ ...compiled, definitionIdentity: recorded })
    const paused = transitionWorkflow(initializeWorkflow(initialized.payload.control).state, { type: "PAUSE", reason: "operator" })
    if (paused.command.kind !== "commit") throw new Error("Pause must propose a commit")
    const facts = [storedFact(initialized, 0), ...paused.command.proposal.facts.map((fact, index) => storedFact(fact, index + 1))]

    const appends: GuardedEventStoreAppend[] = []
    const result = await replayWorkflowFromFacts(facts, { type: "RESUME", readers: {} }, deps(appends, advisorSkills, personas))
    expect(appends).toHaveLength(1)
    expect(appends[0]).toMatchObject({ type: "workflow.definition_identity.migrated", payload: { migrationId: DEFINITION_IDENTITY_DEFAULT_ADVISOR_MIGRATION_ID } })
    expect(result.state.context.committed.definitionIdentity).toEqual(compiled.definitionIdentity)

    const [adoption] = appends
    if (!adoption) throw new Error("Expected the advisor adoption")
    const { expectedSeq: _expectedSeq, ...persisted } = adoption
    const adopted = [...facts, { ...persisted, id: "adoption", position: facts.length + 1, seq: facts.length }]
    const rejected: GuardedEventStoreAppend[] = []
    const edited = new Map(personas).set("advisor", { ...advisor, description: `${advisor.description} Edited.` })
    await expect(replayWorkflowFromFacts(adopted, { type: "RESUME", readers: {} }, deps(rejected, advisorSkills, edited))).rejects.toBeInstanceOf(WorkflowDefinitionDriftError)
    expect(rejected.map(({ type }) => type)).toEqual(["definition.drift_rejected"])
    expect(rejected[0]).toMatchObject({ payload: { changes: [{ component: "persona", personaName: "advisor" }] } })
  })

  it("keeps a persona whose procedure changed as drift and records no turn cap adoption", async () => {
    const { facts, personas } = pausedOverTurnCaps()
    const helper = personas.get("helper")
    if (!helper) throw new Error("Expected the project persona")
    const appends: GuardedEventStoreAppend[] = []

    const edited = new Map(personas).set("helper", { ...helper, description: `${helper.description} Edited.` })
    await expect(replayWorkflowFromFacts(facts, { type: "RESUME", readers: {} }, deps(appends, skills, edited, agentWorkflow))).rejects.toBeInstanceOf(WorkflowDefinitionDriftError)

    expect(appends.map(({ type }) => type)).toEqual(["definition.drift_rejected"])
    expect(appends[0]).toMatchObject({ payload: { changes: [{ component: "persona", personaName: "helper" }] } })
  })

  it("adopts the explorer hash recorded before the workflow lexicon, and keeps any other change as drift", async () => {
    const explorer = repoDefinitions().captureRevision().personas.get("explorer")
    if (!explorer) throw new Error("Expected the bundled explorer")
    const workflowWithExplorer: WorkflowDefinition = { ...workflow, phases: [{ ...workPhase, subagents: ["explorer"] }] }
    const personas = new Map<string, AgentDefinition>([["explorer", explorer]])
    const compiled = compileWorkflowControl(workflowWithExplorer, resolveWorkflowAgents(workflowWithExplorer), { skills, personas })
    const { maxTurns: _budget, ...historical } = beforeLexiconCut(explorer)
    const recorded = withRecordedExplorer(compiled.definitionIdentity, hashDefinition(historical).sha256)
    const initialized = buildWorkflowControlInitializedFact({ ...compiled, definitionIdentity: recorded })
    const paused = transitionWorkflow(initializeWorkflow(initialized.payload.control).state, { type: "PAUSE", reason: "operator" })
    if (paused.command.kind !== "commit") throw new Error("Pause must propose a commit")
    const facts = [storedFact(initialized, 0), ...paused.command.proposal.facts.map((fact, index) => storedFact(fact, index + 1))]

    const appends: GuardedEventStoreAppend[] = []
    const result = await replayWorkflowFromFacts(facts, { type: "RESUME", readers: {} }, deps(appends, skills, personas, workflowWithExplorer))
    expect(appends).toHaveLength(1)
    expect(appends[0]).toMatchObject({ type: "workflow.definition_identity.migrated", payload: { migrationId: DEFINITION_IDENTITY_LEXICON_PERSONAS_MIGRATION_ID } })
    expect(result.state.context.committed.definitionIdentity).toEqual(compiled.definitionIdentity)

    const rejected: GuardedEventStoreAppend[] = []
    const edited = new Map(personas).set("explorer", { ...explorer, description: `${explorer.description} Edited.` })
    await expect(replayWorkflowFromFacts(facts, { type: "RESUME", readers: {} }, deps(rejected, skills, edited, workflowWithExplorer))).rejects.toBeInstanceOf(WorkflowDefinitionDriftError)
    expect(rejected.map(({ type }) => type)).toEqual(["definition.drift_rejected"])
  })

  it("adopts the explorer hash recorded over its retired tool-steering clauses, and keeps any other change as drift", async () => {
    const explorer = repoDefinitions().captureRevision().personas.get("explorer")
    if (!explorer) throw new Error("Expected the bundled explorer")
    const workflowWithExplorer: WorkflowDefinition = { ...workflow, phases: [{ ...workPhase, subagents: ["explorer"] }] }
    const personas = new Map<string, AgentDefinition>([["explorer", explorer]])
    const compiled = compileWorkflowControl(workflowWithExplorer, resolveWorkflowAgents(workflowWithExplorer), { skills, personas })
    const recorded = withRecordedExplorer(compiled.definitionIdentity, hashDefinition(beforeToolSteeringCut(beforeLexiconCut(explorer))).sha256)
    const initialized = buildWorkflowControlInitializedFact({ ...compiled, definitionIdentity: recorded })
    const paused = transitionWorkflow(initializeWorkflow(initialized.payload.control).state, { type: "PAUSE", reason: "operator" })
    if (paused.command.kind !== "commit") throw new Error("Pause must propose a commit")
    const facts = [storedFact(initialized, 0), ...paused.command.proposal.facts.map((fact, index) => storedFact(fact, index + 1))]

    const appends: GuardedEventStoreAppend[] = []
    const result = await replayWorkflowFromFacts(facts, { type: "RESUME", readers: {} }, deps(appends, skills, personas, workflowWithExplorer))
    expect(appends).toHaveLength(1)
    expect(appends[0]).toMatchObject({ type: "workflow.definition_identity.migrated", payload: { migrationId: DEFINITION_IDENTITY_TOOL_STEERING_MIGRATION_ID } })
    expect(result.state.context.committed.definitionIdentity).toEqual(compiled.definitionIdentity)

    const rejected: GuardedEventStoreAppend[] = []
    const edited = new Map(personas).set("explorer", { ...explorer, description: `${explorer.description} Edited.` })
    await expect(replayWorkflowFromFacts(facts, { type: "RESUME", readers: {} }, deps(rejected, skills, edited, workflowWithExplorer))).rejects.toBeInstanceOf(WorkflowDefinitionDriftError)
    expect(rejected.map(({ type }) => type)).toEqual(["definition.drift_rejected"])
  })

  it("adopts the explorer hash recorded before 2026-10-14 over its retired prompt switches and tool-steering clauses, and keeps any other change as drift", async () => {
    const explorer = repoDefinitions().captureRevision().personas.get("explorer")
    if (!explorer) throw new Error("Expected the bundled explorer")
    const workflowWithExplorer: WorkflowDefinition = { ...workflow, phases: [{ ...workPhase, subagents: ["explorer"] }] }
    const personas = new Map<string, AgentDefinition>([["explorer", explorer]])
    const compiled = compileWorkflowControl(workflowWithExplorer, resolveWorkflowAgents(workflowWithExplorer), { skills, personas })
    // The explorer as its file read before both cuts: it opted out of project context and the doctrine.
    const historical = { ...beforeToolSteeringCut(beforeLexiconCut(explorer)), projectContext: false, engineeringDoctrine: false }
    const recorded = withRecordedExplorer(compiled.definitionIdentity, hashDefinition(historical).sha256)
    const initialized = buildWorkflowControlInitializedFact({ ...compiled, definitionIdentity: recorded })
    const paused = transitionWorkflow(initializeWorkflow(initialized.payload.control).state, { type: "PAUSE", reason: "operator" })
    if (paused.command.kind !== "commit") throw new Error("Pause must propose a commit")
    const facts = [storedFact(initialized, 0), ...paused.command.proposal.facts.map((fact, index) => storedFact(fact, index + 1))]

    const appends: GuardedEventStoreAppend[] = []
    const result = await replayWorkflowFromFacts(facts, { type: "RESUME", readers: {} }, deps(appends, skills, personas, workflowWithExplorer))
    expect(appends).toHaveLength(1)
    expect(appends[0]).toMatchObject({ type: "workflow.definition_identity.migrated", payload: { migrationId: DEFINITION_IDENTITY_PERSONA_PROMPT_SWITCHES_MIGRATION_ID } })
    expect(result.state.context.committed.definitionIdentity).toEqual(compiled.definitionIdentity)

    const rejected: GuardedEventStoreAppend[] = []
    const edited = new Map(personas).set("explorer", { ...explorer, description: `${explorer.description} Edited.` })
    await expect(replayWorkflowFromFacts(facts, { type: "RESUME", readers: {} }, deps(rejected, skills, edited, workflowWithExplorer))).rejects.toBeInstanceOf(WorkflowDefinitionDriftError)
    expect(rejected.map(({ type }) => type)).toEqual(["definition.drift_rejected"])
  })
})

/** `identity` with the explorer hash a paused build recorded. The other entries stay: the advisor default is
 *  unresolved in these fixtures, so its entry equals an absent one. */
function withRecordedExplorer(identity: DefinitionIdentity, sha256: string): DefinitionIdentity {
  return { ...identity, personas: identity.personas.map((entry) => entry.personaName === "explorer" ? { ...entry, sha256 } : entry) }
}

/** The work phase, able to dispatch the general agent and one project persona. */
const agentWorkflow: WorkflowDefinition = { ...workflow, phases: [{ ...workPhase, subagents: ["general", "helper"] }] }

/** A paused session whose identity hashed each persona with its turn cap, as
 *  builds before persona identity left the cap out recorded it: the general
 *  agent at its former cap of 100, and an unchanged project persona at its
 *  own cap. Those builds also predate the advisor default, so the identity
 *  names no advisor. */
function pausedOverTurnCaps() {
  const repo = repoDefinitions().captureRevision().personas
  const general = repo.get("general")
  const explorer = repo.get("explorer")
  const advisor = repo.get("advisor")
  if (!general || !explorer || !advisor) throw new Error("Expected the bundled agents")
  const personas = new Map<string, AgentDefinition>([["advisor", advisor], ["general", general], ["helper", { ...explorer, name: "helper", maxTurns: 30 }]])
  const recordedCaps = new Map([["general", 100], ["helper", 30]])
  const steps = resolveWorkflowAgents(agentWorkflow)
  const compiled = compileWorkflowControl(agentWorkflow, steps, { skills, personas })
  const current = compiled.definitionIdentity
  expect(current.personas.map(({ personaName }) => personaName)).toEqual(["advisor", "general", "helper"])
  const recorded = {
    ...current,
    personas: [...recordedCaps].map(([personaName, maxTurns]) => {
      const persona = personas.get(personaName)
      if (!persona) throw new Error(`Expected ${personaName}`)
      return { personaName, sha256: hashDefinition({ ...persona, maxTurns }).sha256 }
    }),
  }
  const initialized = buildWorkflowControlInitializedFact({ ...compiled, definitionIdentity: recorded })
  const paused = transitionWorkflow(initializeWorkflow(initialized.payload.control).state, { type: "PAUSE", reason: "operator" })
  if (paused.command.kind !== "commit") throw new Error("Pause must propose a commit")
  const facts = [storedFact(initialized, 0), ...paused.command.proposal.facts.map((fact, index) => storedFact(fact, index + 1))]
  return { facts, personas, current }
}

/** A session initialized before skill identity, whose control the workspace
 *  migration normalized and whose tail records the adoption of the identity
 *  the same definitions produce today. */
function legacyAdoption() {
  const initialized = buildWorkflowControlInitializedFact(
    compileWorkflowControl(workflow, bindings, { skills }),
  )
  const adopted = buildDefinitionIdentity(workflow, dependentBindings, { skills: dependentSkills })
  const migration = buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID, initialized.payload.control.definitionIdentity, adopted)
  return { adopted, facts: [storedFact(initialized, 0), storedFact(migration, 1)] }
}
