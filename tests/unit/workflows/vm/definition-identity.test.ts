import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import type { AgentDefinition } from "../../../../src/infra/agent-definition.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import {
  buildDefinitionIdentity,
  DEFINITION_IDENTITY_GRAPH_MIGRATION_ID,
  DEFINITION_IDENTITY_RETIRED_SELF_REVIEW_MIGRATION_ID,
  DEFINITION_IDENTITY_COMMAND_CITATION_MIGRATION_ID,
  DEFINITION_IDENTITY_RUNTIME_WORDING_MIGRATION_ID,
  DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_ID,
  DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_ID,
  DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_ID,
  DEFINITION_IDENTITY_GRAPH_MIGRATION_REASON,
  DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID,
  DEFINITION_IDENTITY_CONTEXT_MIGRATION_REASON,
  DEFINITION_IDENTITY_MIGRATIONS,
  DEFINITION_IDENTITY_PERSONA_BUDGET_MIGRATION_ID,
  DEFINITION_IDENTITY_RETIRED_STEP_SCOPE_MIGRATION_ID,
  DEFINITION_IDENTITY_TOOL_STEERING_MIGRATION_ID,
  DEFINITION_IDENTITY_PERSONA_PROMPT_SWITCHES_MIGRATION_ID,
  DEFINITION_IDENTITY_SCENARIO_BUDGET_MIGRATION_ID,
  DEFINITION_IDENTITY_PHASE_GRAMMAR_MIGRATION_ID,
  DEFINITION_IDENTITY_LEXICON_PERSONAS_MIGRATION_ID,
  DEFINITION_IDENTITY_DEFAULT_ADVISOR_MIGRATION_ID,
  DEFINITION_IDENTITY_UAT_SCRATCHPAD_MIGRATION_ID,
  DEFINITION_IDENTITY_FAMILY_ROLE_GRANTS_MIGRATION_ID,
  DEFINITION_IDENTITY_RENAME_MIGRATION_ID,
  DEFINITION_IDENTITY_RENAME_MIGRATION_REASON,
  DEFINITION_IDENTITY_SKILL_NAMESPACE_RENAME_MIGRATION_ID,
  DEFINITION_IDENTITY_SKILL_NAMESPACE_RENAME_MIGRATION_REASON,
  DEFINITION_IDENTITY_STEP_CONTENT_MIGRATION_ID,
  DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID,
  DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_REASON,
  DefinitionIdentityMigrationSchema,
  definitionIdentityMigrationOrder,
  definitionIdentityMigrationReason,
  definitionIdentityMismatches,
  WorkflowDefinitionDriftError,
  DefinitionIdentitySchema,
  personaIdentitySha256,
  type StepDefinitionIdentity,
} from "../../../../src/workflows/vm/definition-identity.js"
import { hashDefinition } from "../../../../src/workflows/definition-hash.js"
import {
  withDefaultAdvisor,
  withoutRecordedTurnCaps,
  withoutRetiredLexiconText,
  withoutRetiredPromptSwitches,
  withoutRetiredScenarioBudget,
  withoutRetiredToolSteering,
} from "../../../../src/workflows/vm/persona-identity-proofs.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { beforeBudgetCut, beforeLexiconCut, beforePromptSwitchCut, beforeScenarioBudgetCut, beforeToolSteeringCut, personasAtCapabilityTextBase } from "../../orchestration/migrations/_persona-budget.js"
import { retiredStepIdentity, withoutRetiredStepScopes } from "../../../../src/workflows/vm/retired-step-identity.js"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { StepGrammarWorkflowSchema, type StepGrammarWorkflow } from "../../../../src/workflows/retired-step-grammar/schema.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import type { WorkflowDefinition, WorkflowPhase } from "../../../../src/workflows/workflow-schema.js"
import { nonEmpty } from "../../../helpers/non-empty.js"

const workflow: WorkflowDefinition = {
  id: "workflow",
  name: "Workflow",
  phases: [{ phase: "zeta", brief: "Do the zeta work.", name: "zeta", writes: [] }, { phase: "alpha", brief: "Follow the alpha method.", name: "alpha", dependencies: ["alpha"], output: { summary: "Result", fields: { plan_path: { type: "string", description: "The plan." } } }, writes: [] }],
  provenance: { layer: "project", filePath: "/one/workflow.yaml", id: "workflow" },
}

const skills = testSkillRevision([testSkill("alpha"), testSkill("zeta")])

/** The identity of `definition` resolved against the fixture skills. */
function identityOf(definition: WorkflowDefinition = workflow): StepDefinitionIdentity {
  return buildDefinitionIdentity(definition, resolveWorkflowAgents(definition), { skills })
}

/** `workflow` with its alpha phase changed by `revise`. */
function withAlpha(revise: (phase: WorkflowPhase) => WorkflowPhase): WorkflowDefinition {
  return { ...workflow, phases: nonEmpty(workflow.phases.map((entry) => "phase" in entry && entry.phase === "alpha" ? revise(entry) : entry)) }
}

/** The step hashes of one step id. */
function stepOf(identity: StepDefinitionIdentity, stepId: string) {
  const step = identity.steps.find((entry) => entry.stepId === stepId)
  if (!step) throw new Error(`Identity names no step ${stepId}`)
  return step
}

/** A pre-cutover identity, as a build before step content recorded it. */
function legacyIdentity(current: StepDefinitionIdentity, registry: readonly { readonly [field: string]: unknown }[] = []) {
  return Schema.decodeUnknownSync(DefinitionIdentitySchema, { onExcessProperty: "error" })({
    workflowDefinitionId: current.workflowDefinitionId,
    graphSha256: current.graphSha256,
    vmVersion: current.vmVersion,
    bindings: current.steps.map(({ stepId }) => ({ bindingId: stepId, sha256: "b".repeat(64) })),
    handoffRegistry: registry,
    skills: current.skills,
    personas: current.personas,
  })
}

describe("workflow definition identity", () => {
  it("is canonical, sorted, and path-independent", () => {
    const first = identityOf()
    const moved = identityOf({ ...workflow, provenance: { layer: "project", filePath: "/two/workflow.yaml", id: "workflow" } })

    expect(first).toEqual(moved)
    expect(first.steps.map(({ stepId }) => stepId)).toEqual(["alpha", "zeta"])
    expect(first.graphSha256).toHaveLength(64)
    expect(first.steps.every(({ policySha256, contentSha256, outputSha256 }) =>
      [policySha256, contentSha256, outputSha256].every((hash) => hash.length === 64))).toBe(true)
    expect(first.skills.map(({ skillId }) => skillId)).toEqual(["alpha"])
  })

  it("hashes only the phases as graph identity", () => {
    const identity = identityOf()

    for (const changed of [
      { ...workflow, name: "Renamed" },
      { ...workflow, description: "New description" },
      { ...workflow, guardrails: { max_attempts: 12 } },
    ]) {
      expect(identityOf(changed).graphSha256).toBe(identity.graphSha256)
    }
    expect(identityOf({ ...workflow, phases: nonEmpty(workflow.phases.toReversed()) }).graphSha256).not.toBe(identity.graphSha256)
  })

  it("hashes the policy, content, and output of each agent record apart", () => {
    const recorded = stepOf(identityOf(), "alpha")
    const changed = (revise: Parameters<typeof withAlpha>[0]) => {
      const step = stepOf(identityOf(withAlpha(revise)), "alpha")
      return (["policySha256", "contentSha256", "outputSha256"] as const).filter((member) => step[member] !== recorded[member])
    }

    expect(changed((step) => ({ ...step, writes: [{ id: "plan", lifetime: "transient" }] }))).toEqual(["policySha256"])
    expect(changed((step) => ({ ...step, brief: "Follow the alpha method twice." }))).toEqual(["contentSha256"])
    expect(changed((step) => ({ ...step, name: "Alpha" }))).toEqual(["policySha256", "contentSha256"])
    expect(changed((step) => ({ ...step, output: { summary: "Result", fields: { plan_path: { type: "string", description: "Where the plan is." } } } }))).toEqual(["contentSha256"])
    expect(changed((step) => ({ ...step, output: { summary: "Result", fields: { plan_path: { type: "path", description: "The plan." } } } }))).toEqual(["contentSha256", "outputSha256"])
    expect(changed((step) => ({ ...step, persona: "explorer" }))).toEqual(["policySha256"])
  })

  it("reports deterministic graph, agent, and version mismatches", () => {
    const recorded = identityOf()
    const current = {
      ...recorded,
      graphSha256: "1".repeat(64),
      steps: recorded.steps.map((step) => step.stepId === "alpha"
        ? { ...step, policySha256: "2".repeat(64), outputSha256: "3".repeat(64) }
        : { ...step, contentSha256: "4".repeat(64) }),
      vmVersion: "3",
    }

    const changes = definitionIdentityMismatches(recorded, current)
    expect(changes.map((change) => change.component === "agent" ? `${change.definitionId}:${change.aspect}` : change.component))
      .toEqual(["graph", "alpha:policy", "alpha:output", "zeta:content", "version"])
    expect(changes).toContainEqual({ component: "version", recorded: "2", current: "3" })
    const versionChange = { component: "version", recorded: "2", current: "3" } as const
    const error = new WorkflowDefinitionDriftError({
      workflowId: "workflow",
      latestSeq: 7,
      changes: [versionChange],
    })
    expect(error).toBeInstanceOf(WorkflowDefinitionDriftError)
    expect(error).toMatchObject({
      _tag: "WorkflowDefinitionDriftError",
      workflowId: "workflow",
      latestSeq: 7,
      changes: [versionChange],
    })
  })

  it("reports every step of a pre-cutover identity as policy drift against a step identity", () => {
    const current = identityOf()

    expect(definitionIdentityMismatches(legacyIdentity(current), current)).toEqual([
      { component: "agent", definitionId: "alpha", aspect: "policy", recorded: "b".repeat(64), current: stepOf(current, "alpha").policySha256 },
      { component: "agent", definitionId: "zeta", aspect: "policy", recorded: "b".repeat(64), current: stepOf(current, "zeta").policySha256 },
    ])
  })

  it("reads an adoption that a build before the agent lexicon recorded with step evidence as agent evidence, so replay still proves it", () => {
    const prior = identityOf()
    const adopted = identityOf(withAlpha((phase) => ({ ...phase, brief: "Follow the alpha method twice." })))
    const recorded = stepOf(prior, "alpha").contentSha256
    const current = stepOf(adopted, "alpha").contentSha256
    const fact = parseWorkflowSessionFact({
      type: "workflow.definition_identity.adopted", version: 1, actor: "flywheel",
      payload: { prior, adopted, evidence: [{ component: "step", stepId: "alpha", aspect: "content", recorded, current }] },
    })
    if (fact.type !== "workflow.definition_identity.adopted") throw new Error("Expected an adoption fact")
    expect(fact.payload.evidence).toEqual([{ component: "agent", definitionId: "alpha", aspect: "content", recorded, current }])
    expect(definitionIdentityMismatches(prior, adopted)).toEqual(fact.payload.evidence)
  })

  it("rejects drift errors without mismatches", () => {
    expect(() => Schema.decodeUnknownSync(WorkflowDefinitionDriftError)({
      _tag: "WorkflowDefinitionDriftError",
      workflowId: "workflow",
      changes: [],
      latestSeq: 7,
    })).toThrow()
  })

  it("decodes a pre-cutover missing contract revision to a sentinel that causes ordinary drift", () => {
    const entry = { name: "work", contractRevision: 1, fieldsSha256: "3".repeat(64), rulesSha256: "4".repeat(64), artifactPathFieldsSha256: "5".repeat(64) }
    const recorded = legacyIdentity(identityOf(), [entry])
    const { contractRevision: _, ...missing } = entry
    const legacy = legacyIdentity(identityOf(), [missing])

    expect("handoffRegistry" in legacy && legacy.handoffRegistry[0]?.contractRevision).toBe(0)
    expect(definitionIdentityMismatches(legacy, recorded)).toContainEqual({
      component: "registry",
      handoffType: "work",
      recorded: expect.stringContaining("0:"),
      current: expect.stringContaining("1:"),
    })
  })

  it("rejects malformed identities before comparison", () => {
    const identity = identityOf()
    const excessIdentity = { ...identity, excess: true }
    expect(() => definitionIdentityMismatches(identity, excessIdentity)).toThrow()
    expect(() => definitionIdentityMismatches(identity, { ...identity, graphSha256: "short" })).toThrow()
  })
})

// Remove with withoutRetiredStepScopes after 2027-04-13.
describe("a recorded step policy that held the retired toolScoping and kind keys", () => {
  const scope = { read: true, bash: true, search: true, list: true, write: false, edit: false, subagent: false }
  /** The step-grammar record that `workflow` stood for before phases. */
  const encodedView = {
    id: "workflow",
    name: "Workflow",
    steps: {
      zeta: { instructions: "Do the zeta work.", name: "zeta", writes: [] },
      alpha: { instructions: "Follow the alpha method.", name: "alpha", dependencies: ["alpha"], output: { summary: "Result", fields: { plan_path: { type: "string", description: "The plan." } } }, writes: [] },
    },
    flow: [{ step: "zeta" }, { step: "alpha" }],
  }
  const viewWith = (alpha: { readonly [key: string]: unknown }): StepGrammarWorkflow =>
    Schema.decodeUnknownSync(StepGrammarWorkflowSchema)({ ...encodedView, steps: { ...encodedView.steps, alpha: { ...encodedView.steps.alpha, ...alpha } } })
  const view = viewWith({})
  const retiredIdentityOf = (recordedView: StepGrammarWorkflow) =>
    retiredStepIdentity(recordedView, workflow, resolveWorkflowAgents(workflow), { skills })

  it("adopts the current policy hash, because the retired keys are the only difference", () => {
    const recorded = retiredIdentityOf(viewWith({ toolScoping: scope, kind: "check" }))
    const current = retiredIdentityOf(view)
    expect(stepOf(recorded, "alpha").policySha256).not.toBe(stepOf(current, "alpha").policySha256)

    const proven = withoutRetiredStepScopes(recorded, view)
    expect(proven).toEqual(current)
    expect(definitionIdentityMismatches(proven, current)).toEqual([])
  })

  it("keeps a recorded hash whose step policy also changed in another key, so the change still reports as drift", () => {
    const recorded = retiredIdentityOf(viewWith({ toolScoping: scope, writes: [{ id: "other", lifetime: "transient" }] }))

    const proven = withoutRetiredStepScopes(recorded, view)
    expect(proven).toBe(recorded)
    expect(definitionIdentityMismatches(proven, retiredIdentityOf(view))).toContainEqual(expect.objectContaining({ component: "agent", definitionId: "alpha", aspect: "policy" }))
  })
})

describe("workflow persona identity", () => {
  const personaWorkflow: WorkflowDefinition = {
    id: "workflow",
    name: "Workflow",
    phases: [{ phase: "alpha", brief: "Follow the alpha method.", name: "alpha", dependencies: ["alpha"], subagents: ["lead"], writes: [] }],
    provenance: { layer: "project", filePath: "/one/workflow.yaml", id: "workflow" },
  }
  const personaSkills = testSkillRevision([testSkill("alpha"), testSkill("implementation")])

  function persona(overrides: Partial<Extract<AgentDefinition, { kind: "persona" }>> & { name: string }): Extract<AgentDefinition, { kind: "persona" }> {
    return {
      kind: "persona",
      description: `${overrides.name} persona`,
      systemPrompt: `Act as ${overrides.name}.`,
      tools: ["read"],
      role: overrides.name,
      maxTurns: 20,
      ...overrides,
    }
  }

  function registry(...agents: readonly AgentDefinition[]): ReadonlyMap<string, AgentDefinition> {
    return new Map(agents.map((agent) => [agent.name, agent]))
  }

  const lead = persona({ name: "lead", role: "lead", subagentRoles: ["helper"] })
  const helper = persona({ name: "helper", role: "helper", requiredSkills: ["implementation"] })
  const advisor = persona({ name: "advisor", role: "advisor" })
  const personas = registry(lead, helper, advisor)

  function identity(map: ReadonlyMap<string, AgentDefinition>) {
    return buildDefinitionIdentity(personaWorkflow, resolveWorkflowAgents(personaWorkflow), { skills: personaSkills, personas: map })
  }

  it("pins every persona a step can reach through subagent grants and the advisor default, and their packages", () => {
    const pinned = identity(personas)

    expect(pinned.personas.map(({ personaName }) => personaName)).toEqual(["advisor", "helper", "lead"])
    expect(pinned.personas.every(({ sha256 }) => sha256?.length === 64)).toBe(true)
    expect(pinned.skills.map(({ skillId }) => skillId)).toEqual(["alpha", "implementation"])
  })

  it("reports drift for a changed body, tool list, or grant on a directly selected persona", () => {
    const recorded = identity(personas)

    const changedDefinitions: AgentDefinition[] = [
      { ...lead, systemPrompt: "Act differently." },
      { ...lead, tools: ["read", "bash"] },
      { ...lead, subagentRoles: [] },
    ]
    for (const changed of changedDefinitions) {
      const changes = definitionIdentityMismatches(recorded, identity(registry(changed, helper, advisor)))
      expect(changes.some((change) => change.component === "persona" && change.personaName === "lead")).toBe(true)
    }
  })

  it("reports no drift when only a persona's turn cap changes", () => {
    expect(definitionIdentityMismatches(identity(personas), identity(registry({ ...lead, maxTurns: lead.maxTurns + 1 }, helper, advisor)))).toEqual([])
  })

  it("reports drift for a nested persona no step names directly", () => {
    const recorded = identity(personas)
    const changed = identity(registry(lead, { ...helper, systemPrompt: "Assist differently." }, advisor))

    expect(definitionIdentityMismatches(recorded, changed)).toEqual([{
      component: "persona",
      personaName: "helper",
      recorded: expect.any(String),
      current: expect.any(String),
    }])
  })

  it("terminates on mutually granting personas and excludes a persona's own role", () => {
    const first = persona({ name: "first", role: "first", subagentRoles: ["second", "first"] })
    const second = persona({ name: "second", role: "second", subagentRoles: ["first"] })

    expect(identity(registry({ ...lead, subagentRoles: ["first"] }, first, second)).personas
      .map(({ personaName }) => personaName)).toEqual(["advisor", "first", "lead", "second"])
  })

  it("records an unresolvable persona name instead of reading a live registry", () => {
    expect(identity(new Map()).personas).toEqual([{ personaName: "advisor", sha256: null }, { personaName: "lead", sha256: null }])
  })
})

// Remove with withDefaultAdvisor after 2027-05-01.
describe("a persona identity that a build before the advisor default recorded", () => {
  const bundled = repoDefinitions().captureRevision().personas
  const explorer = bundled.get("explorer")
  const advisor = bundled.get("advisor")
  if (!explorer || !advisor) throw new Error("Expected the bundled explorer and advisor")
  const recordedWith = (personas: readonly (readonly [string, string])[]): StepDefinitionIdentity =>
    ({ ...identityOf(), personas: personas.map(([personaName, sha256]) => ({ personaName, sha256 })) })
  const explorerEntry = ["explorer", personaIdentitySha256(explorer)] as const

  const options = { skills, personas: bundled }

  it("adds the current advisor, because a build before the default pinned only the authored lists", () => {
    expect(withDefaultAdvisor(recordedWith([explorerEntry]), "workflow", options)).toEqual(recordedWith([["advisor", personaIdentitySha256(advisor)], explorerEntry]))
  })

  it("adds the skills an advisor override requires and keeps every skill hash the identity recorded", () => {
    const required = { ...advisor, requiredSkills: ["alpha", "implementation"] }
    const withImplementation = testSkillRevision([...skills.skills.values(), testSkill("implementation")])
    const recorded = { ...recordedWith([explorerEntry]), skills: [{ skillId: "alpha", sha256: "a".repeat(64) }] }

    const realm = { skills: withImplementation, personas: new Map(bundled).set("advisor", required) }
    const adopted = withDefaultAdvisor(recorded, "workflow", realm)

    // Against the current identity only the recorded hashes differ: the advisor and its implementation skill joined
    // at their current hashes, and the recorded alpha hash and explorer entry stayed.
    expect(definitionIdentityMismatches(adopted, buildDefinitionIdentity(workflow, resolveWorkflowAgents(workflow), realm))).toEqual([
      { component: "skill", skillId: "alpha", recorded: "a".repeat(64), current: expect.any(String) },
      { component: "persona", personaName: "explorer", recorded: explorerEntry[1], current: "<missing>" },
    ])
  })

  it("keeps an identity that names the advisor, so an edited advisor or another missing persona still reports as drift", () => {
    const edited = recordedWith([["advisor", "e".repeat(64)], explorerEntry])
    expect(withDefaultAdvisor(edited, "workflow", options)).toBe(edited)

    const current = recordedWith([["advisor", personaIdentitySha256(advisor)], explorerEntry])
    expect(definitionIdentityMismatches(withDefaultAdvisor(recordedWith([]), "workflow", options), current)).toEqual([
      { component: "persona", personaName: "explorer", recorded: "<missing>", current: explorerEntry[1] },
    ])
  })
})

describe("a persona hash that a build before the workflow lexicon recorded", () => {
  // The personas as they read before the capability-text edit, which no proof covers.
  const bundled = personasAtCapabilityTextBase(repoDefinitions().captureRevision().personas)
  const named = (name: string): AgentDefinition => {
    const persona = bundled.get(name)
    if (!persona) throw new Error(`Expected the bundled ${name}`)
    return persona
  }
  const rewritten = ["explorer", "reviewer-plan-elegance", "reviewer-uat"] as const
  const recordedWith = (hashes: readonly (readonly [string, string])[]): StepDefinitionIdentity =>
    ({ ...identityOf(), personas: hashes.map(([personaName, sha256]) => ({ personaName, sha256 })) })
  const current = (name: string) => [name, personaIdentitySha256(named(name))] as const

  it("adopts the current hash of explorer, reviewer-plan-elegance, and reviewer-uat, because the lexicon clauses are the only difference", () => {
    const recorded = recordedWith(rewritten.map((name) => [name, personaIdentitySha256(beforeLexiconCut(named(name)))]))
    expect(recorded.personas.some(({ personaName, sha256 }) => sha256 === personaIdentitySha256(named(personaName)))).toBe(false)

    expect(withoutRetiredLexiconText(recorded, bundled)).toEqual(recordedWith(rewritten.map(current)))
  })

  it("still adopts a hash recorded before the scenario-budget, prompt-switch, tool-steering, or turn-cap edit, which also predates the lexicon", () => {
    const uat = recordedWith([["reviewer-uat", personaIdentitySha256(beforeScenarioBudgetCut(beforeLexiconCut(named("reviewer-uat"))))]])
    expect(withoutRetiredScenarioBudget(uat, bundled)).toEqual(recordedWith([current("reviewer-uat")]))

    const steering = recordedWith([["explorer", hashDefinition(beforeToolSteeringCut(beforeLexiconCut(named("explorer")))).sha256]])
    expect(withoutRetiredToolSteering(steering, bundled)).toEqual(recordedWith([current("explorer")]))

    const switches = recordedWith([["explorer", hashDefinition(beforePromptSwitchCut(beforeToolSteeringCut(beforeLexiconCut(named("explorer"))))).sha256]])
    expect(withoutRetiredPromptSwitches(switches, bundled)).toEqual(recordedWith([current("explorer")]))

    const capped = recordedWith([["reviewer-plan-elegance", hashDefinition(beforeBudgetCut(beforeLexiconCut(named("reviewer-plan-elegance")))).sha256]])
    expect(withoutRecordedTurnCaps(capped, bundled)).toEqual(recordedWith([current("reviewer-plan-elegance")]))
  })

  it("keeps a recorded hash whose persona also changed in another clause, so the change still reports as drift", () => {
    const edited = (name: string): AgentDefinition => {
      const persona = beforeLexiconCut(named(name))
      return persona.kind === "persona" ? { ...persona, systemPrompt: `${persona.systemPrompt}\nEdited.` } : persona
    }
    const recorded = recordedWith(rewritten.map((name) => [name, personaIdentitySha256(edited(name))]))
    expect(withoutRetiredLexiconText(recorded, bundled)).toBe(recorded)

    const uat = recordedWith([["reviewer-uat", personaIdentitySha256(beforeScenarioBudgetCut(edited("reviewer-uat")))]])
    expect(withoutRetiredScenarioBudget(uat, bundled)).toBe(uat)
  })
})

describe("workflow definition identity migration", () => {
  const prior = identityOf()
  const adopted = { ...prior, skills: [...prior.skills, { skillId: "implementation", sha256: "c".repeat(64) }] }
  const migration: typeof DefinitionIdentityMigrationSchema.Type = {
    migrationId: DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID,
    reason: DEFINITION_IDENTITY_CONTEXT_MIGRATION_REASON,
    prior,
    adopted,
    evidence: definitionIdentityMismatches(prior, adopted),
  }

  it("carries the recorded prior beside the adopted identity and its evidence", () => {
    expect(prior.skills.map(({ skillId }) => skillId)).toEqual(["alpha"])
    expect(migration.evidence).toEqual([{
      component: "skill", skillId: "implementation", recorded: "<missing>", current: "c".repeat(64),
    }])
    expect(parseMigration(migration)).toEqual(migration)
  })

  it("carries the canonical empty evidence when the two identities imply no difference", () => {
    const unchanged = { ...migration, adopted: prior, evidence: [] }
    expect(definitionIdentityMismatches(prior, prior)).toEqual([])
    expect(parseMigration(unchanged)).toEqual(unchanged)
  })

  it("rejects a foreign migration id, a foreign reason, or an excess member", () => {
    expect(() => parseMigration({ ...migration, migrationId: "other-migration" })).toThrow()
    expect(() => parseMigration({ ...migration, reason: "because" })).toThrow()
    expect(() => parseMigration({ ...migration, excess: true })).toThrow()
  })

  it("admits every registered chain migration only with its own registered reason", () => {
    expect(DEFINITION_IDENTITY_MIGRATIONS.map(({ id }) => id)).toEqual([
      DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID,
      DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID,
      DEFINITION_IDENTITY_RENAME_MIGRATION_ID,
      DEFINITION_IDENTITY_SKILL_NAMESPACE_RENAME_MIGRATION_ID,
      DEFINITION_IDENTITY_GRAPH_MIGRATION_ID,
      DEFINITION_IDENTITY_RETIRED_SELF_REVIEW_MIGRATION_ID,
      DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_ID,
      DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_ID,
      DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_ID,
      DEFINITION_IDENTITY_COMMAND_CITATION_MIGRATION_ID,
      DEFINITION_IDENTITY_RUNTIME_WORDING_MIGRATION_ID,
      DEFINITION_IDENTITY_STEP_CONTENT_MIGRATION_ID,
      DEFINITION_IDENTITY_PERSONA_BUDGET_MIGRATION_ID,
      DEFINITION_IDENTITY_RETIRED_STEP_SCOPE_MIGRATION_ID,
      DEFINITION_IDENTITY_TOOL_STEERING_MIGRATION_ID,
      DEFINITION_IDENTITY_PERSONA_PROMPT_SWITCHES_MIGRATION_ID,
      DEFINITION_IDENTITY_SCENARIO_BUDGET_MIGRATION_ID,
      DEFINITION_IDENTITY_PHASE_GRAMMAR_MIGRATION_ID,
      DEFINITION_IDENTITY_LEXICON_PERSONAS_MIGRATION_ID,
      DEFINITION_IDENTITY_DEFAULT_ADVISOR_MIGRATION_ID,
      DEFINITION_IDENTITY_UAT_SCRATCHPAD_MIGRATION_ID,
      DEFINITION_IDENTITY_FAMILY_ROLE_GRANTS_MIGRATION_ID,
    ])
    for (const { id, reason } of DEFINITION_IDENTITY_MIGRATIONS) {
      expect(definitionIdentityMigrationReason(id)).toBe(reason)
      expect(parseMigration({ ...migration, migrationId: id, reason })).toEqual({ ...migration, migrationId: id, reason })
    }
    expect(() => parseMigration({
      ...migration,
      migrationId: DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID,
      reason: DEFINITION_IDENTITY_CONTEXT_MIGRATION_REASON,
    })).toThrow()
  })

  it("orders the chain by registration so a later migration never precedes an earlier one", () => {
    expect(definitionIdentityMigrationOrder(DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID)).toBe(0)
    expect(definitionIdentityMigrationOrder(DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID)).toBe(1)
    expect(definitionIdentityMigrationOrder(DEFINITION_IDENTITY_RENAME_MIGRATION_ID)).toBe(2)
    expect(definitionIdentityMigrationOrder(DEFINITION_IDENTITY_SKILL_NAMESPACE_RENAME_MIGRATION_ID)).toBe(3)
    expect(definitionIdentityMigrationOrder(DEFINITION_IDENTITY_GRAPH_MIGRATION_ID)).toBe(4)
    expect(new Set([
      DEFINITION_IDENTITY_CONTEXT_MIGRATION_REASON,
      DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_REASON,
      DEFINITION_IDENTITY_RENAME_MIGRATION_REASON,
      DEFINITION_IDENTITY_SKILL_NAMESPACE_RENAME_MIGRATION_REASON,
      DEFINITION_IDENTITY_GRAPH_MIGRATION_REASON,
    ]).size).toBe(5)
  })
})

function parseMigration(value: unknown): typeof DefinitionIdentityMigrationSchema.Type {
  return Schema.decodeUnknownSync(DefinitionIdentityMigrationSchema, { onExcessProperty: "error" })(value)
}
