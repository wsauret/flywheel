import { requireGuardedEventAppender, type AsyncEventWriter, type StoredFact } from "../../infra/event-store-types.js"
import { buildDefinitionDriftRejectedFact } from "../definition-provenance-fact-writers.js"
import { resolveWorkflowAgents, type ResolvedAgent } from "../agent-resolution.js"
import type { ProjectDefinitionRegistryRevision } from "../definition-registry.js"
import type { WorkflowDefinition } from "../workflow-schema.js"
import type { WorkflowTransitionResult } from "./commands.js"
import type { CommittedWorkflowControl } from "./committed-control.js"
import {
  buildDefinitionIdentity,
  DEFINITION_IDENTITY_CAPABILITY_MARKERS_MIGRATION_ID,
  DEFINITION_IDENTITY_DEFAULT_ADVISOR_MIGRATION_ID,
  DEFINITION_IDENTITY_EXPLORER_MODEL_CLAIM_MIGRATION_ID,
  DEFINITION_IDENTITY_FAMILY_ROLE_GRANTS_MIGRATION_ID,
  DEFINITION_IDENTITY_LEXICON_PERSONAS_MIGRATION_ID,
  DEFINITION_IDENTITY_PERSONA_BUDGET_MIGRATION_ID,
  DEFINITION_IDENTITY_PERSONA_PROMPT_SWITCHES_MIGRATION_ID,
  DEFINITION_IDENTITY_PHASE_GRAMMAR_MIGRATION_ID,
  DEFINITION_IDENTITY_RETIRED_STEP_SCOPE_MIGRATION_ID,
  DEFINITION_IDENTITY_SCENARIO_BUDGET_MIGRATION_ID,
  DEFINITION_IDENTITY_TOOL_STEERING_MIGRATION_ID,
  DEFINITION_IDENTITY_UAT_SCRATCHPAD_MIGRATION_ID,
  definitionIdentityMismatches,
  dispatchingAgents,
  isContentOnlyIdentityChange,
  WorkflowDefinitionDriftError,
  type DefinitionIdentity,
  type DefinitionIdentityOptions,
  type DefinitionIdentityMigrationId,
  type DefinitionIdentityVersionOverride,
  type StepDefinitionIdentity,
} from "./definition-identity.js"
import { adoptPhaseGrammarIdentity, retiredStepIdentity, retiredStepView, withoutRetiredStepScopes } from "./retired-step-identity.js"
import {
  acrossRetiredLexicon,
  withCapabilityMarkers,
  withDefaultAdvisor,
  withFamilyRoleGrants,
  withoutExplorerModelClaim,
  withoutRecordedTurnCaps,
  withoutRetiredLexiconText,
  withoutRetiredPromptSwitches,
  withoutRetiredScenarioBudget,
  withoutRetiredToolSteering,
  withUatScratchpadRule,
} from "./persona-identity-proofs.js"
import type { WorkflowEvent } from "./events.js"
import { recoverWorkflowControl } from "./recovery.js"
import { WorkflowDriftEvidencePersistenceError, WorkflowMalformedStateError } from "./host-types.js"
import {
  buildDefinitionIdentityAdoptedFact,
  buildDefinitionIdentityMigratedFact,
  workflowAggregateId,
  type WorkflowControlFact,
} from "./session-facts.js"
import { replayWorkflowControlFrom } from "./fact-fold.js"
import { replayDecodedWorkflow, transitionDecodedWorkflow } from "./transition.js"

export interface WorkflowReplayDeps {
  readonly sessionId: string
  /** Skills and personas the current identity is composed from. */
  readonly definitionRevision: ProjectDefinitionRegistryRevision
  /** The definition the run executes now, which admission resolved. */
  readonly workflow: WorkflowDefinition
  readonly writer: AsyncEventWriter
  readonly now?: () => number
}

/** Strictly validate committed facts, reject definition drift, rebuild control, then apply one pure event. */
export async function replayWorkflowFromFacts(
  facts: readonly StoredFact[],
  event: WorkflowEvent,
  deps: WorkflowReplayDeps,
  identityOverride?: DefinitionIdentityVersionOverride,
): Promise<WorkflowTransitionResult> {
  const plan = recoverWorkflowControl(facts)
  if (!plan.executable) {
    const reason = plan.reasons.map(({ kind }) => kind).join(", ")
    throw new WorkflowMalformedStateError({
      sessionId: deps.sessionId,
      message: `Workflow session ${deps.sessionId} has non-executable durable state: ${reason}`,
    })
  }
  const control = plan.control
  return continueWorkflowReplay(control, event, deps, identityOverride)
}

/** Check definition identity and apply one event to control that strict replay already decoded. */
export async function continueWorkflowReplay(
  control: CommittedWorkflowControl,
  event: WorkflowEvent,
  deps: WorkflowReplayDeps,
  identityOverride?: DefinitionIdentityVersionOverride,
): Promise<WorkflowTransitionResult> {
  const revision = deps.definitionRevision
  const { workflow } = deps
  const agents = resolveWorkflowAgents(workflow)
  const options: DefinitionIdentityOptions = { skills: revision.skills, personas: revision.personas }
  const current = buildDefinitionIdentity(workflow, agents, options, identityOverride)
  const proofs = provenIdentityAdoptions(control.definitionIdentity, { workflow, agents, options, current })
  const proven = proofs.at(-1)?.after ?? control.definitionIdentity
  const changes = definitionIdentityMismatches(proven, current)
  const [firstChange, ...remainingChanges] = changes
  if (firstChange && !isContentOnlyIdentityChange(proven, current, changes)) {
    const error = new WorkflowDefinitionDriftError({
      workflowId: current.workflowDefinitionId,
      changes: [firstChange, ...remainingChanges],
      latestSeq: control.aggregateSeq,
    })
    const rejection = buildDefinitionDriftRejectedFact({
      workflowId: error.workflowId,
      changes: error.changes,
      latestSeq: error.latestSeq,
    })
    try {
      await deps.writer.append({
        aggregateId: workflowAggregateId(deps.sessionId),
        sessionId: deps.sessionId,
        timestamp: (deps.now ?? Date.now)(),
        type: rejection.type,
        version: rejection.version,
        actor: rejection.actor,
        payload: rejection.payload,
      })
    } catch (evidenceError) {
      throw new WorkflowDriftEvidencePersistenceError({
        workflowId: error.workflowId,
        message: `Definition drift was rejected, but its evidence could not be persisted: ${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}`,
      })
    }
    throw error
  }

  let committedControl = control
  for (const { migrationId, before, after } of proofs) {
    if (after !== before) committedControl = await appendIdentityFact(committedControl, buildDefinitionIdentityMigratedFact(migrationId, before, after), deps)
  }
  if (firstChange) {
    committedControl = await appendIdentityFact(committedControl, buildDefinitionIdentityAdoptedFact(proven, current), deps)
  }

  const hydrated = replayDecodedWorkflow(committedControl)
  const result = transitionDecodedWorkflow(hydrated, event)
  return event.type === "RECOVER" && result.command.kind === "none" && result.state.lifecycle === "ready"
    ? transitionDecodedWorkflow(hydrated, { type: "START" })
    : result
}

interface IdentityAdoption {
  readonly migrationId: DefinitionIdentityMigrationId
  readonly before: DefinitionIdentity
  readonly after: DefinitionIdentity
}

/** What the identity proofs of one Resume read: the current definition, its
 *  resolved agents, the composition revision, and its current identity. */
interface IdentityProofInput {
  readonly workflow: WorkflowDefinition
  readonly agents: ReadonlyMap<string, ResolvedAgent>
  readonly options: DefinitionIdentityOptions
  readonly current: StepDefinitionIdentity
}

/** The definition-identity migrations that Resume proves against the current definitions, in chain order. Each
 *  adoption starts from the identity the one before it produced, and an adoption whose `after` is its `before`
 *  proved nothing and records no fact. A proof over the records of the retired step grammar reads the retired view
 *  of the definition (refer to `retiredStepView`). */
function provenIdentityAdoptions(recorded: DefinitionIdentity, input: IdentityProofInput): readonly IdentityAdoption[] {
  const { workflow, agents, options, current } = input
  const personas = options.personas ?? new Map()
  const view = retiredStepView(workflow)
  const migrations: readonly (readonly [DefinitionIdentityMigrationId, (identity: DefinitionIdentity) => DefinitionIdentity])[] = [
    [DEFINITION_IDENTITY_PERSONA_BUDGET_MIGRATION_ID, (identity) => withoutRecordedTurnCaps(identity, personas)],
    [DEFINITION_IDENTITY_RETIRED_STEP_SCOPE_MIGRATION_ID, (identity) => withoutRetiredStepScopes(identity, view)],
    [DEFINITION_IDENTITY_TOOL_STEERING_MIGRATION_ID, (identity) => withoutRetiredToolSteering(identity, personas)],
    [DEFINITION_IDENTITY_PERSONA_PROMPT_SWITCHES_MIGRATION_ID, (identity) => withoutRetiredPromptSwitches(identity, personas)],
    [DEFINITION_IDENTITY_SCENARIO_BUDGET_MIGRATION_ID, (identity) => withoutRetiredScenarioBudget(identity, personas)],
    // The frozen identity of the retired grammar hashes the personas as that grammar read them, so the proof reads
    // the recorded personas through the lexicon proof that follows it, and leaves the lexicon change to that proof.
    [DEFINITION_IDENTITY_PHASE_GRAMMAR_MIGRATION_ID, (identity) => acrossRetiredLexicon(identity, personas, (lexical, retiredPersonas) =>
      adoptPhaseGrammarIdentity(lexical, view === undefined ? undefined : retiredStepIdentity(view, workflow, agents, { ...options, personas: retiredPersonas }), current))],
    [DEFINITION_IDENTITY_LEXICON_PERSONAS_MIGRATION_ID, (identity) => withoutRetiredLexiconText(identity, personas)],
    [DEFINITION_IDENTITY_DEFAULT_ADVISOR_MIGRATION_ID, (identity) => withDefaultAdvisor(identity, workflow.id, options)],
    [DEFINITION_IDENTITY_UAT_SCRATCHPAD_MIGRATION_ID, (identity) => withUatScratchpadRule(identity, personas)],
    [DEFINITION_IDENTITY_FAMILY_ROLE_GRANTS_MIGRATION_ID, (identity) => withFamilyRoleGrants(identity, workflow.id, dispatchingAgents(agents), options)],
    [DEFINITION_IDENTITY_CAPABILITY_MARKERS_MIGRATION_ID, (identity) => withCapabilityMarkers(identity, personas)],
    [DEFINITION_IDENTITY_EXPLORER_MODEL_CLAIM_MIGRATION_ID, (identity) => withoutExplorerModelClaim(identity, personas)],
  ]
  const adoptions: IdentityAdoption[] = []
  let identity = recorded
  for (const [migrationId, adopt] of migrations) {
    const after = adopt(identity)
    adoptions.push({ migrationId, before: identity, after })
    identity = after
  }
  return adoptions
}

/** Append one identity fact at the aggregate tail and fold it into control. */
async function appendIdentityFact(
  control: CommittedWorkflowControl,
  fact: WorkflowControlFact,
  deps: WorkflowReplayDeps,
): Promise<CommittedWorkflowControl> {
  const result = await requireGuardedEventAppender(deps.writer, "Workflow replay requires guarded append authority").appendGuarded({
    aggregateId: workflowAggregateId(deps.sessionId),
    sessionId: deps.sessionId,
    timestamp: (deps.now ?? Date.now)(),
    type: fact.type,
    version: fact.version,
    actor: fact.actor,
    payload: fact.payload,
    expectedSeq: control.aggregateSeq,
  })
  if (result.kind === "conflict") {
    throw new Error(`Workflow ${deps.sessionId} changed during definition identity adoption`, { cause: result.conflict })
  }
  const stored = result.events[0]
  if (!stored) throw new Error("Workflow definition identity adoption returned no fact")
  return replayWorkflowControlFrom(control, [stored])
}
