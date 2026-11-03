import { Schema, SchemaTransformation } from "effect"
import type { AgentDefinition } from "../../infra/agent-definition.js"
import { reachableAgentNames, workflowAgentSubagents } from "../agents/subagent-reachability.js"
import type { ResolvedAgent } from "../agent-resolution.js"
import { workflowInputContract } from "../brief.js"
import { hashContent, hashDefinition, Sha256Schema } from "../definition-hash.js"
import { canonicalAgentPolicy, canonicalWorkflowRecord, phaseStructure } from "../definition-records.js"
import { skillClosureIds } from "../skill-closure.js"
import { renderSkillContext } from "../skill-context.js"
import type { SkillRegistryRevision } from "../skill-schema.js"
import { agentRecords, type WorkflowDefinition } from "../workflow-schema.js"
import type { WorkflowDefinitionChange, WorkflowDefinitionDrift } from "../../protocol/app-service-types.js"

const IdSchema = Schema.NonEmptyString

const WORKFLOW_VM_VERSION = "2" as const

/** Content identity of one workflow-local binding, as builds before the
 *  brief cutover recorded it: the canonical binding record, which named a
 *  skill and a handoff type. History only; the identity migration of the
 *  brief cutover converts it. Remove after 2027-04-30. */
const BindingIdentitySchema = Schema.Struct({
  bindingId: IdSchema,
  sha256: Sha256Schema,
})

const StoredContractRevisionSchema = Schema.Union([Schema.Literal(0), Schema.Null, Schema.Int.check(Schema.isGreaterThan(0))])

/** One handoff type a pre-cutover identity pinned. History only; the
 *  brief cutover deleted the registry. Remove after 2027-04-30. */
const HandoffRegistryIdentitySchema = Schema.Struct({
  name: IdSchema,
  contractRevision: Schema.optional(StoredContractRevisionSchema),
  fieldsSha256: Schema.NullOr(Sha256Schema),
  rulesSha256: Schema.optional(Schema.NullOr(Sha256Schema)),
  artifactPathFieldsSha256: Schema.optional(Schema.NullOr(Sha256Schema)),
}).pipe(Schema.decodeTo(
  Schema.Struct({
    name: IdSchema,
    contractRevision: StoredContractRevisionSchema,
    fieldsSha256: Schema.NullOr(Sha256Schema),
    rulesSha256: Schema.NullOr(Sha256Schema),
    artifactPathFieldsSha256: Schema.NullOr(Sha256Schema),
  }),
  SchemaTransformation.transform({
    decode: (identity) => ({
      ...identity,
      contractRevision: identity.contractRevision === undefined ? 0 : identity.contractRevision,
      rulesSha256: identity.rulesSha256 ?? null,
      artifactPathFieldsSha256: identity.artifactPathFieldsSha256 ?? null,
    }),
    encode: (identity) => ({
      ...identity,
      contractRevision: identity.contractRevision === 0 ? undefined : identity.contractRevision,
    }),
  }),
))

/** Content identity of one agent record: three hashes, so a resume can
 *  tell an edited brief from a changed policy or a changed payload shape.
 *  `stepId` holds the record's definition id. It is a stored key of control
 *  version 11, whose roots and adoption facts hold this identity.
 *  - `policySha256` covers what only the workflow means for this agent (refer
 *    to `canonicalAgentPolicy`). An identity of the retired step grammar
 *    covered the policy of its retired record instead (refer to
 *    `canonicalStepPolicy`).
 *  - `contentSha256` covers the brief after precedence (refer to
 *    {@link briefContentSha256}).
 *  - `outputSha256` is the output's `schemaSha256`: what a payload must look
 *    like, without descriptions. VM field reads on stored payloads depend on
 *    it, so a change to it stops the run. */
const StepIdentitySchema = Schema.Struct({
  stepId: IdSchema, // stored key of control v11
  policySha256: Sha256Schema,
  contentSha256: Sha256Schema,
  outputSha256: Sha256Schema,
})

/** Content identity of a skill package an agent composes, directly, through a
 *  dependency, or through a persona it can dispatch: the hash is taken over the
 *  canonical context the package renders into the prompt, not over its body
 *  alone, because the header carries version, source, resources, related ids, and
 *  the shadowed source. A package whose metadata, precedence, or resource list
 *  changed composes a different prompt, so a resumed attempt would run a
 *  different procedure. */
const SkillIdentitySchema = Schema.Struct({
  skillId: IdSchema,
  sha256: Schema.NullOr(Sha256Schema),
})

/** Content identity of one persona an agent can dispatch, directly or
 *  through the `subagentRoles` grants that persona chain. The hash is
 *  `personaIdentitySha256`. A name the registry does not resolve records a
 *  null hash. */
const PersonaIdentitySchema = Schema.Struct({
  personaName: IdSchema,
  sha256: Schema.NullOr(Sha256Schema),
})

const ComposedIdentityFields = {
  workflowDefinitionId: IdSchema,
  vmVersion: IdSchema,
  skills: Schema.Array(SkillIdentitySchema),
  personas: Schema.Array(PersonaIdentitySchema),
} as const

const LegacyIdentityFields = {
  ...ComposedIdentityFields,
  bindings: Schema.Array(BindingIdentitySchema),
  handoffRegistry: Schema.Array(HandoffRegistryIdentitySchema),
} as const

/** The identity of every build before structural graph identity. History. */
const WholeWorkflowDefinitionIdentitySchema = Schema.Struct({
  ...LegacyIdentityFields,
  workflowSha256: Sha256Schema,
})

/** The identity of every build before the brief cutover. History; the
 *  identity migration of the brief cutover converts it. Remove after
 *  2027-04-30. */
const BindingDefinitionIdentitySchema = Schema.Struct({
  ...LegacyIdentityFields,
  graphSha256: Sha256Schema,
})

/** The structure of one phase container of a retired step-grammar flow: its
 *  declared limits and its own flow. `phaseId` is the path of phase ids from
 *  the top-level flow, joined with "/". Only an identity that a build before
 *  the phase grammar recorded has them (refer to `retired-step-identity.ts`).
 *  Remove after 2027-04-30. */
const PhaseIdentitySchema = Schema.Struct({
  phaseId: IdSchema,
  sha256: Sha256Schema,
})

/** The current identity: the graph, one entry for each agent record, keyed
 *  by its definition id in the stored key `stepId`, and the skills and
 *  personas the agents compose. `phases` is present only in an identity of a
 *  retired step-grammar flow that declared a phase container. */
const StepDefinitionIdentitySchema = Schema.Struct({
  ...ComposedIdentityFields,
  graphSha256: Sha256Schema,
  phases: Schema.optionalKey(Schema.NonEmptyArray(PhaseIdentitySchema)),
  steps: Schema.Array(StepIdentitySchema), // stored key of control v11
})

export const DefinitionIdentitySchema = Schema.Union([
  StepDefinitionIdentitySchema,
  WholeWorkflowDefinitionIdentitySchema,
  BindingDefinitionIdentitySchema,
])

const AgentAspectSchema = Schema.Literals(["policy", "content", "output"])

/** A changed agent record: its policy, its brief content, or its output. */
const AgentMismatchSchema = Schema.Struct({
  component: Schema.Literal("agent"),
  definitionId: IdSchema,
  aspect: AgentAspectSchema,
  recorded: Schema.String,
  current: Schema.String,
})

export const DefinitionIdentityMismatchSchema = Schema.Union([
  Schema.Struct({
    component: Schema.Literal("workflow"),
    definitionId: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  Schema.Struct({
    component: Schema.Literal("graph"),
    definitionId: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  Schema.Struct({
    component: Schema.Literal("phase"),
    phaseId: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  AgentMismatchSchema,
  // A changed record, as builds before the agent lexicon recorded it in
  // adoption and drift facts. It reads as the `agent` change it is, so a
  // replay compares it with the evidence that a current build computes.
  // Remove after 2027-04-30.
  Schema.Struct({
    component: Schema.Literal("step"), // stored kind of adoption and drift evidence
    stepId: IdSchema, // stored key of adoption and drift evidence
    aspect: AgentAspectSchema,
    recorded: Schema.String,
    current: Schema.String,
  }).pipe(Schema.decodeTo(AgentMismatchSchema, SchemaTransformation.transform({
    decode: ({ stepId, component: _retired, ...change }) => ({ component: "agent" as const, definitionId: stepId, ...change }), // stored key
    encode: ({ definitionId, component: _current, ...change }) => ({ component: "step" as const, stepId: definitionId, ...change }), // stored kind and key
  }))),
  Schema.Struct({
    component: Schema.Literal("version"),
    recorded: Schema.String,
    current: Schema.String,
  }),
  Schema.Struct({
    component: Schema.Literal("skill"),
    skillId: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  Schema.Struct({
    component: Schema.Literal("persona"),
    personaName: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  // Evidence that builds before the brief cutover recorded, in
  // adoption and drift facts. Readable, never produced for a current
  // identity. Remove after 2027-04-30.
  Schema.Struct({
    component: Schema.Literal("binding"),
    bindingId: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  Schema.Struct({
    component: Schema.Literal("registry"),
    handoffType: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
])
export type DefinitionIdentity = typeof DefinitionIdentitySchema.Type
export type StepDefinitionIdentity = typeof StepDefinitionIdentitySchema.Type
/** An identity that names bindings and handoff types. */
export type LegacyDefinitionIdentity = Exclude<DefinitionIdentity, StepDefinitionIdentity>
export type DefinitionIdentityMismatch = typeof DefinitionIdentityMismatchSchema.Type

export function isLegacyDefinitionIdentity(identity: DefinitionIdentity): identity is LegacyDefinitionIdentity {
  return "bindings" in identity
}

/** The graph positions an identity pins: its definition ids, or the
 *  binding ids of an identity from before the brief cutover. */
export function identityDefinitionIds(identity: DefinitionIdentity): readonly string[] {
  return isLegacyDefinitionIdentity(identity) ? identity.bindings.map(({ bindingId }) => bindingId) : identity.steps.map(({ stepId }) => stepId) // stored key of control v11
}

/** Whether a resume may adopt `adopted` on its own: every difference is an
 *  edited method. That is a skill whose content hash changed, or an agent
 *  record whose content hash changed while its policy and output hashes
 *  stayed equal. A
 *  policy or output change shows as its own evidence entry, so it fails the
 *  test. A field description edit is therefore an ordinary method edit
 *  (PI-AGENT-015), and a field, type, or requiredness change stops the run.
 *  For two identities from before the brief cutover, only the skill
 *  arm can hold, which is the rule those builds applied. */
export function isContentOnlyIdentityChange(
  prior: DefinitionIdentity,
  adopted: DefinitionIdentity,
  evidence: readonly DefinitionIdentityMismatch[] = definitionIdentityMismatches(prior, adopted),
): boolean {
  if (evidence.length === 0) return false
  const present = (hash: string): boolean => hash !== MISSING
  return evidence.every((change) =>
    (change.component === "skill" || (change.component === "agent" && change.aspect === "content"))
    && present(change.recorded) && present(change.current) && change.recorded !== change.current)
}

/** A session committed before definition identity covered composed context can
 *  omit `skills` or `personas`. The workspace migration normalizes only those
 *  absent members to empty arrays in place. Later migrations remain responsible
 *  for their own legacy members, so the ordered chain reaches one strict shape
 *  without a runtime fallback. */
export const DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID = "workflow-definition-identity-context-v1"
export const DEFINITION_IDENTITY_CONTEXT_MIGRATION_REASON =
  "Control was staged before definition identity covered composed skills and reachable personas; the normalized session adopts the selected definition when it still exists."

/** The unification cutover replaced the retired step definitions that a
 *  workflow identity recorded with its bindings and bound skill packages. A
 *  session staged before the cutover adopts the new identity only when the
 *  selected skill and its workflow binding exactly reconstruct each recorded
 *  snapshot of a retired step definition. */
export const DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID = "workflow-definition-identity-unified-catalog-v1"
export const DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_REASON =
  "Control was staged while a workflow identity recorded step definitions; the session adopts the binding-and-skill identity because the selected skills and bindings reconstruct every recorded step snapshot exactly." // stored reason text

/** The implementation-first rename replaced the durable workflow, binding, and
 * skill ids of the unified catalog with the vocabulary the product speaks:
 * `flywheel-core` became `implement`, the `flywheel.`/`get-stuff-done.`/
 * `compound-eng.` skill families became `fly.`/`gsd.`/`ce.`, and the
 * spec-writing pair lost the word plan. */
export const DEFINITION_IDENTITY_RENAME_MIGRATION_ID = "workflow-definition-identity-implementation-first-rename-v1"
export const DEFINITION_IDENTITY_RENAME_MIGRATION_REASON =
  "Control was staged before the implementation-first rename; the session adopts the renamed identity because the recorded ids map onto the workflow, bindings, skills, handoff types, and personas the current definition names."

/** The dependency-only implementation specification joined the `fly.` family
 * after its other workflow-owned consumers. The pass also recognizes `planning`
 * so a store can upgrade directly from any earlier release. */
export const DEFINITION_IDENTITY_SKILL_NAMESPACE_RENAME_MIGRATION_ID =
  "workflow-definition-identity-skill-namespace-rename-v2"
export const DEFINITION_IDENTITY_SKILL_NAMESPACE_RENAME_MIGRATION_REASON =
  "Control was staged before the implementation specification skill joined the fly namespace; the session adopts the renamed identity because every recorded id maps onto the current definition."

export const DEFINITION_IDENTITY_GRAPH_MIGRATION_ID = "workflow-definition-identity-graph-v1"
export const DEFINITION_IDENTITY_GRAPH_MIGRATION_REASON =
  "Control recorded whole-workflow provenance before structural graph compatibility became distinct; the session adopts the graph identity derived from its recorded workflow snapshot."

export const DEFINITION_IDENTITY_RETIRED_SELF_REVIEW_MIGRATION_ID = "workflow-definition-identity-retired-self-review-v1"
const DEFINITION_IDENTITY_RETIRED_SELF_REVIEW_MIGRATION_REASON =
  "Control recorded binding hashes over the retired self-review policy; the session adopts the hash of each binding without it because the recorded hash equals the recorded binding with only a self-review value added."

export const DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_ID = "workflow-definition-identity-retired-child-ask-user-v1"
const DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_REASON =
  "Control recorded binding hashes over the retired ask_user tool scope and the spec handoff revision that told a step to ask the person; the session adopts the hash of each binding without the scope and the spec handoff revision that tells a step to message its parent, because those are the only differences."

export const DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_ID = "workflow-definition-identity-retired-blocked-v1"
const DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_REASON =
  "Control recorded the work and spec handoff revisions that let a step stop blocked and the implementer and ship personas that reported blockers; the session adopts the revisions and persona bodies that tell a step to message its parent, because those are the only differences." // stored reason text

export const DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_ID = "workflow-definition-identity-persona-shell-v1"
const DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_REASON =
  "Control recorded personas whose tool list lost bash to the exec shell variant that shares its identity; the session adopts the same personas with bash restored, because the tool list is the only difference."

export const DEFINITION_IDENTITY_COMMAND_CITATION_MIGRATION_ID = "workflow-definition-identity-command-citation-v1"
const DEFINITION_IDENTITY_COMMAND_CITATION_MIGRATION_REASON =
  "Control recorded the handoff revisions that asked a step to copy each cited command; the session adopts the revisions that record the command from the cited call, because that text and its check are the only differences." // stored reason text

export const DEFINITION_IDENTITY_RUNTIME_WORDING_MIGRATION_ID = "workflow-definition-identity-runtime-wording-v1"
const DEFINITION_IDENTITY_RUNTIME_WORDING_MIGRATION_REASON =
  "Control recorded the handoff revisions whose text named the product; the session adopts the revisions that say \"the runtime\" instead, because that wording is the only difference."

/** The brief cutover replaced the bindings and the handoff registry of an
 *  identity with one entry for each agent record. Remove after 2027-04-30. */
export const DEFINITION_IDENTITY_STEP_CONTENT_MIGRATION_ID = "workflow-definition-identity-step-content-v1" // stored migration id
const DEFINITION_IDENTITY_STEP_CONTENT_MIGRATION_REASON =
  "Control recorded the binding and handoff registry identity of the build before step content; the session adopts the step identity because the graph, every binding, every handoff contract, and every skill the steps still compose equal what that build recorded." // stored reason text

/** Persona identity stopped covering the turn cap. Resume records this
 *  adoption through `withoutRecordedTurnCaps`. Remove after 2027-04-13. */
export const DEFINITION_IDENTITY_PERSONA_BUDGET_MIGRATION_ID = "workflow-definition-identity-persona-budget-v1"
const DEFINITION_IDENTITY_PERSONA_BUDGET_MIGRATION_REASON =
  "Control recorded persona hashes that covered the turn cap; the session adopts the hashes of the same personas without it, because the current definitions prove the turn cap is the only difference."

/** Agent records stopped reading `toolScoping` and `kind`. Resume records this
 *  adoption through `withoutRetiredStepScopes`. Remove after 2027-04-13. */
export const DEFINITION_IDENTITY_RETIRED_STEP_SCOPE_MIGRATION_ID = "workflow-definition-identity-retired-step-scope-v1"
const DEFINITION_IDENTITY_RETIRED_STEP_SCOPE_MIGRATION_REASON =
  "Control recorded step policy hashes that covered the retired toolScoping and kind keys; the session adopts the hashes of the same steps without them, because every step now gets the same tools and system prompt and the current definition proves those keys are the only difference."

/** Explorer and Advisor stopped steering agents to the file tools over the shell. Resume records this adoption
 *  through `withoutRetiredToolSteering`. Remove after 2027-04-13. */
export const DEFINITION_IDENTITY_TOOL_STEERING_MIGRATION_ID = "workflow-definition-identity-tool-steering-v1"
const DEFINITION_IDENTITY_TOOL_STEERING_MIGRATION_REASON =
  "Control recorded explorer and advisor personas that steered agents to the file tools over the shell; the session adopts the same personas without those clauses, because the current definitions prove the clauses are the only difference."

/** Personas stopped setting a child's stable system prompt apart with the projectContext and engineeringDoctrine
 *  keys. Resume records this adoption through `withoutRetiredPromptSwitches`. Remove after 2027-04-13. */
export const DEFINITION_IDENTITY_PERSONA_PROMPT_SWITCHES_MIGRATION_ID = "workflow-definition-identity-persona-prompt-switches-v1"
const DEFINITION_IDENTITY_PERSONA_PROMPT_SWITCHES_MIGRATION_REASON =
  "Control recorded personas that set the retired projectContext or engineeringDoctrine keys; the session adopts the same personas without them, because every subagent now shares a workflow step's system prompt and the current definitions prove those keys are the only difference."

/** The reviewer-uat persona stopped capping a live scenario at ten minutes of wall-clock time. Resume records this
 *  adoption through `withoutRetiredScenarioBudget`. Remove after 2027-04-15. */
export const DEFINITION_IDENTITY_SCENARIO_BUDGET_MIGRATION_ID = "workflow-definition-identity-scenario-budget-v1"
const DEFINITION_IDENTITY_SCENARIO_BUDGET_MIGRATION_REASON =
  "Control recorded a reviewer-uat persona that capped a live scenario at ten minutes of wall-clock time; the session adopts the same persona without that cap, because the current definitions prove the budget clauses are the only difference."

/** Workflows moved from the retired step grammar to the phase grammar. Resume
 *  records this adoption through `adoptPhaseGrammarIdentity`. Remove after
 *  2027-04-30. */
export const DEFINITION_IDENTITY_PHASE_GRAMMAR_MIGRATION_ID = "workflow-definition-identity-phase-grammar-v1"
const DEFINITION_IDENTITY_PHASE_GRAMMAR_MIGRATION_REASON =
  "Control recorded the identity of a step-grammar definition; the session adopts the identity of the same definition in the phase grammar, because the identity that the last step-grammar build computes for the definition before conversion equals the recorded identity, apart from edited briefs and skills and the renamed implementation plan contract." // stored reason text

/** Explorer, reviewer-uat, and reviewer-plan-elegance moved to the workflow lexicon. Resume records this adoption
 *  through `withoutRetiredLexiconText`. Remove after 2027-04-30. */
export const DEFINITION_IDENTITY_LEXICON_PERSONAS_MIGRATION_ID = "workflow-definition-identity-lexicon-personas-v1"
const DEFINITION_IDENTITY_LEXICON_PERSONAS_MIGRATION_REASON =
  "Control recorded explorer, reviewer-uat, and reviewer-plan-elegance personas whose text used the retired workflow words; the session adopts the same personas in the workflow lexicon, because the current definitions prove those words are the only difference."

/** Every agent of a workflow can dispatch the advisor without a grant, on trial (PI-AGENT-044), so identity pins
 *  the advisor for every run. Resume records this adoption through `withDefaultAdvisor`. Remove after
 *  2027-05-01. */
export const DEFINITION_IDENTITY_DEFAULT_ADVISOR_MIGRATION_ID = "workflow-definition-identity-default-advisor-v1"
const DEFINITION_IDENTITY_DEFAULT_ADVISOR_MIGRATION_REASON =
  "Control recorded the personas that the agents could dispatch before every agent could dispatch the advisor; the session adopts the same identity with the current advisor persona added, because the advisor is the only difference."

/** The strict ordered chain of definition-identity adoptions. Replay accepts
 * recorded adoptions only in increasing order and only once each, so a session
 * that already adopted an earlier migration can still receive a later one.
 * Append a new migration at the end and never reorder or remove one: a recorded
 * fact names its position in the chain by id alone. */
export const DEFINITION_IDENTITY_MIGRATIONS = [
  { id: DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID, reason: DEFINITION_IDENTITY_CONTEXT_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID, reason: DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_RENAME_MIGRATION_ID, reason: DEFINITION_IDENTITY_RENAME_MIGRATION_REASON },
  {
    id: DEFINITION_IDENTITY_SKILL_NAMESPACE_RENAME_MIGRATION_ID,
    reason: DEFINITION_IDENTITY_SKILL_NAMESPACE_RENAME_MIGRATION_REASON,
  },
  { id: DEFINITION_IDENTITY_GRAPH_MIGRATION_ID, reason: DEFINITION_IDENTITY_GRAPH_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_RETIRED_SELF_REVIEW_MIGRATION_ID, reason: DEFINITION_IDENTITY_RETIRED_SELF_REVIEW_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_ID, reason: DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_ID, reason: DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_ID, reason: DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_COMMAND_CITATION_MIGRATION_ID, reason: DEFINITION_IDENTITY_COMMAND_CITATION_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_RUNTIME_WORDING_MIGRATION_ID, reason: DEFINITION_IDENTITY_RUNTIME_WORDING_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_STEP_CONTENT_MIGRATION_ID, reason: DEFINITION_IDENTITY_STEP_CONTENT_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_PERSONA_BUDGET_MIGRATION_ID, reason: DEFINITION_IDENTITY_PERSONA_BUDGET_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_RETIRED_STEP_SCOPE_MIGRATION_ID, reason: DEFINITION_IDENTITY_RETIRED_STEP_SCOPE_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_TOOL_STEERING_MIGRATION_ID, reason: DEFINITION_IDENTITY_TOOL_STEERING_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_PERSONA_PROMPT_SWITCHES_MIGRATION_ID, reason: DEFINITION_IDENTITY_PERSONA_PROMPT_SWITCHES_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_SCENARIO_BUDGET_MIGRATION_ID, reason: DEFINITION_IDENTITY_SCENARIO_BUDGET_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_PHASE_GRAMMAR_MIGRATION_ID, reason: DEFINITION_IDENTITY_PHASE_GRAMMAR_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_LEXICON_PERSONAS_MIGRATION_ID, reason: DEFINITION_IDENTITY_LEXICON_PERSONAS_MIGRATION_REASON },
  { id: DEFINITION_IDENTITY_DEFAULT_ADVISOR_MIGRATION_ID, reason: DEFINITION_IDENTITY_DEFAULT_ADVISOR_MIGRATION_REASON },
] as const

export type DefinitionIdentityMigrationId = typeof DEFINITION_IDENTITY_MIGRATIONS[number]["id"]

const MIGRATION_REASONS: ReadonlyMap<string, string> = new Map(
  DEFINITION_IDENTITY_MIGRATIONS.map(({ id, reason }) => [id, reason]),
)

/** Position of one registered migration in the chain. Replay compares positions
 *  to reject a repeated or out-of-order adoption; the id is decoded against the
 *  registry before its order is read, so an unregistered id cannot reach here. */
export function definitionIdentityMigrationOrder(migrationId: DefinitionIdentityMigrationId): number {
  return DEFINITION_IDENTITY_MIGRATIONS.findIndex(({ id }) => id === migrationId)
}

/** The reason one registered migration states. The recorded fact carries it, so
 *  a reader of the store learns what was adopted without a build of Flywheel. */
export function definitionIdentityMigrationReason(migrationId: DefinitionIdentityMigrationId): string {
  const reason = MIGRATION_REASONS.get(migrationId)
  if (reason === undefined) throw new Error(`Unregistered definition identity migration "${migrationId}"`)
  return reason
}

export const DefinitionIdentityMigrationSchema = Schema.Struct({
  migrationId: Schema.Literals(DEFINITION_IDENTITY_MIGRATIONS.map(({ id }) => id)),
  reason: Schema.NonEmptyString,
  prior: DefinitionIdentitySchema,
  adopted: DefinitionIdentitySchema,
  evidence: Schema.Array(DefinitionIdentityMismatchSchema),
}).check(Schema.makeFilter((payload) =>
  payload.reason === MIGRATION_REASONS.get(payload.migrationId)
  || `reason must be the registered reason of migration "${payload.migrationId}"`))
export type DefinitionIdentityMigration = typeof DefinitionIdentityMigrationSchema.Type

export class WorkflowDefinitionDriftError extends Schema.TaggedError<WorkflowDefinitionDriftError>()(
  "WorkflowDefinitionDriftError",
  {
    workflowId: IdSchema,
    changes: Schema.NonEmptyArray(DefinitionIdentityMismatchSchema),
    latestSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  },
) {}

/** A drift rejection as the published contract states it: which parts
 *  changed, by kind and id, without the content hashes that prove it. */
export function publishedDefinitionDrift(workflowId: string, changes: readonly DefinitionIdentityMismatch[]): WorkflowDefinitionDrift {
  return { workflowDefinitionId: workflowId, changes: changes.map(publishedDefinitionChange) }
}

function publishedDefinitionChange(change: DefinitionIdentityMismatch): WorkflowDefinitionChange {
  switch (change.component) {
    case "workflow":
    case "graph":
    case "version": return { component: change.component }
    // A changed phase is part of the graph; the published contract names
    // it as a graph change with the phase path as its id.
    case "phase": return { component: "graph", id: change.phaseId }
    case "agent": return { component: "agent", id: change.definitionId, aspect: change.aspect }
    case "skill": return { component: change.component, id: change.skillId }
    case "persona": return { component: change.component, id: change.personaName }
    // A pre-cutover binding was the policy of one position. A handoff type
    // was the output of every position that named it, so the published
    // change names no single agent. Remove both arms after 2027-04-30.
    case "binding": return { component: "agent", id: change.bindingId, aspect: "policy" }
    case "registry": return { component: "agent", aspect: "output" }
  }
}

export interface DefinitionIdentityOptions {
  /** Revision the composed skill context is hashed from. The caller's registry
   *  owns it; identity is never derived from a live registry read. */
  readonly skills: SkillRegistryRevision
  /** Personas an agent can dispatch, resolved from the same registry
   *  the dispatch uses. An absent map records every selected persona as
   *  unresolved; no consumer may fall back to a live registry read, because a
   *  read taken from the process working directory would pin a different
   *  project's personas. */
  readonly personas?: ReadonlyMap<string, AgentDefinition>
}

export interface DefinitionIdentityVersionOverride {
  readonly vmVersion: string
}

/** The graph hash of one workflow: the hash of its phase structure (refer
 *  to `phaseStructure`). A workflow with an input contract hashes the
 *  structure together with the contract's schema hash, because the contract
 *  decides which launches it admits and which lists a phase over the launch
 *  input reads. A change to the contract is a graph drift; a change to its
 *  descriptions or examples is not. */
function graphSha256(workflow: WorkflowDefinition): string {
  const contract = workflowInputContract(workflow)
  const phases = phaseStructure(workflow.phases)
  return hashDefinition(contract === null ? { phases } : { phases, input: contract.schemaSha256 }).sha256
}

/** The content hash of one agent's brief (refer to the `contentSha256` of
 *  {@link StepIdentitySchema}): the brief id, the effective name, the
 *  description, the dependencies, the personas it may dispatch, the body
 *  with every reference expanded, and the canonical `output`. The keys are
 *  the ones that the retired step grammar hashed, so a brief that a paused run of
 *  that grammar ran hashes the same. */
export function briefContentSha256(agent: Pick<ResolvedAgent, "briefId" | "name" | "description" | "dependencies" | "subagents" | "body">, output: ResolvedAgent["output"]): string {
  return hashDefinition({
    contentId: agent.briefId, // stored hash key: a new key would change every brief hash
    name: agent.name,
    description: agent.description,
    dependencies: agent.dependencies,
    agents: agent.subagents,
    body: agent.body,
    output: output.canonical,
  }).sha256
}

/** The skills and personas that a set of agents composes, each with its
 *  hash. Dispatch reachability decides the personas, not the agents' own
 *  lists: a persona that an agent can dispatch, or that runs an agent,
 *  composes its grantees' prompts too, so every persona the run can reach
 *  participates in identity and contributes its required packages. */
export function composedIdentity(
  workflowId: string,
  agents: readonly Pick<ResolvedAgent, "subagents" | "persona" | "dependencies">[],
  options: DefinitionIdentityOptions,
): Pick<StepDefinitionIdentity, "skills" | "personas"> {
  const personas: ReadonlyMap<string, AgentDefinition> = options.personas ?? new Map()
  const personaNames = reachableAgentNames(agents.flatMap(({ subagents, persona }) => persona === undefined ? subagents : [persona, ...subagents]), personas)
  const personaSkillIds = personaNames.flatMap((name) => {
    const persona = personas.get(name)
    return persona?.kind === "persona" ? persona.requiredSkills ?? [] : []
  })
  const { skills } = options
  // One closure resolver serves prompt assembly and identity alike, so the
  // packages a worker reads are exactly the packages this contract pins.
  const skillIds = [...new Set(skillClosureIds(
    [...agents.flatMap(({ dependencies }) => dependencies), ...personaSkillIds],
    skills,
    `Workflow "${workflowId}"`,
  ))].sort()
  return {
    skills: skillIds.map((skillId) => {
      const skill = skills.skills.get(skillId)
      return { skillId, sha256: skill ? hashContent(renderSkillContext(skill)).sha256 : null }
    }),
    personas: personaNames.map((personaName) => {
      const persona = personas.get(personaName)
      return { personaName, sha256: persona ? personaIdentitySha256(persona) : null }
    }),
  }
}

/** The identity of one phase grammar definition: its graph, one entry for
 *  each agent record keyed by its definition id, and the skills and
 *  personas its agents compose. */
export function buildDefinitionIdentity(
  workflow: WorkflowDefinition,
  agents: ReadonlyMap<string, ResolvedAgent>,
  options: DefinitionIdentityOptions,
  versionOverride?: DefinitionIdentityVersionOverride,
): StepDefinitionIdentity {
  const canonicalWorkflow = canonicalWorkflowRecord(workflow)
  const records = agentRecords(canonicalWorkflow)
  const entries = [...agents.values()]
    .sort((left, right) => left.definitionId.localeCompare(right.definitionId))
    .map((agent) => {
      const record = records.get(agent.definitionId)
      if (!record) throw new Error(`Workflow "${workflow.id}" identity references unknown agent: ${agent.definitionId}`)
      return {
        stepId: agent.definitionId, // stored key of control v11
        policySha256: hashDefinition(canonicalAgentPolicy(record)).sha256,
        contentSha256: briefContentSha256(agent, agent.output),
        outputSha256: agent.output.schemaSha256,
      }
    })
  return Schema.decodeUnknownSync(StepDefinitionIdentitySchema, { onExcessProperty: "error" })({
    workflowDefinitionId: canonicalWorkflow.id,
    graphSha256: graphSha256(workflow),
    vmVersion: versionOverride?.vmVersion ?? WORKFLOW_VM_VERSION,
    steps: entries, // stored key of control v11
    // Identity pins every persona that dispatch can reach, so each agent composes what it may dispatch, not only
    // its authored list. The frozen step-grammar identity composes the authored lists, as that build did.
    ...composedIdentity(workflow.id, [...agents.values()].map((agent) => ({ ...agent, subagents: workflowAgentSubagents(agent) })), options),
  })
}

/** The identity hash of one persona. It covers every field that shapes what
 *  the dispatch does - kind, name, description, system prompt, tools, role,
 *  grants, and required packages - so an edited
 *  persona body, a widened tool list, or a new grant reports as definition
 *  drift instead of running as a silently different procedure. The turn cap
 *  is left out: it is an execution budget, so a paused run resumes under a
 *  changed budget with the same procedure. */
export function personaIdentitySha256(persona: AgentDefinition): string {
  const { maxTurns: _budget, ...procedure } = persona
  return hashDefinition(procedure).sha256
}

const MISSING = "<missing>"

export function definitionIdentityMismatches(
  recorded: DefinitionIdentity,
  current: DefinitionIdentity,
): readonly DefinitionIdentityMismatch[] {
  const previous = parseDefinitionIdentity(recorded)
  const next = parseDefinitionIdentity(current)
  const changes: DefinitionIdentityMismatch[] = []
  if ("workflowSha256" in previous && "workflowSha256" in next
    && (previous.workflowDefinitionId !== next.workflowDefinitionId || previous.workflowSha256 !== next.workflowSha256)) {
    changes.push({
      component: "workflow",
      definitionId: next.workflowDefinitionId,
      recorded: previous.workflowSha256,
      current: next.workflowSha256,
    })
  } else if ("graphSha256" in previous && "graphSha256" in next
    && (previous.workflowDefinitionId !== next.workflowDefinitionId || previous.graphSha256 !== next.graphSha256)) {
    changes.push({
      component: "graph",
      definitionId: next.workflowDefinitionId,
      recorded: previous.graphSha256,
      current: next.graphSha256,
    })
  } else if ("workflowSha256" in previous && "graphSha256" in next) {
    changes.push({
      component: "graph",
      definitionId: next.workflowDefinitionId,
      recorded: previous.workflowSha256,
      current: next.graphSha256,
    })
  } else if ("graphSha256" in previous && "workflowSha256" in next) {
    changes.push({
      component: "workflow",
      definitionId: next.workflowDefinitionId,
      recorded: previous.graphSha256,
      current: next.workflowSha256,
    })
  }
  if (!isLegacyDefinitionIdentity(previous) && !isLegacyDefinitionIdentity(next) && (previous.phases || next.phases)) {
    compareRecords(previous.phases ?? [], next.phases ?? [], ({ phaseId }) => phaseId, (phaseId, oldHash, newHash) => {
      changes.push({ component: "phase", phaseId, recorded: oldHash, current: newHash })
    }, ({ sha256 }) => sha256)
  }
  changes.push(...positionMismatches(previous, next))
  if (previous.vmVersion !== next.vmVersion) {
    changes.push({ component: "version", recorded: previous.vmVersion, current: next.vmVersion })
  }
  if (isLegacyDefinitionIdentity(previous)) {
    // A handoff type the current identity does not name. Remove after 2027-04-30.
    const nextRegistry = isLegacyDefinitionIdentity(next) ? next.handoffRegistry : []
    compareRecords(previous.handoffRegistry, nextRegistry, ({ name }) => name, (handoffType, oldHash, newHash) => {
      changes.push({ component: "registry", handoffType, recorded: oldHash, current: newHash })
    }, registryValue)
  }
  compareRecords(previous.skills, next.skills, ({ skillId }) => skillId, (skillId, oldHash, newHash) => {
    changes.push({ component: "skill", skillId, recorded: oldHash, current: newHash })
  }, ({ sha256 }) => sha256 ?? MISSING)
  compareRecords(previous.personas, next.personas, ({ personaName }) => personaName, (personaName, oldHash, newHash) => {
    changes.push({ component: "persona", personaName, recorded: oldHash, current: newHash })
  }, ({ sha256 }) => sha256 ?? MISSING)
  return changes
}

function registryValue(entry: LegacyDefinitionIdentity["handoffRegistry"][number]): string {
  const { contractRevision, fieldsSha256, rulesSha256, artifactPathFieldsSha256 } = entry
  return `${contractRevision ?? MISSING}:${fieldsSha256 ?? MISSING}:${rulesSha256 ?? MISSING}:${artifactPathFieldsSha256 ?? MISSING}`
}

/** The per-position evidence. Two legacy identities compare bindings and two
 *  current identities compare each aspect of an agent record. A legacy
 *  identity against a current one compares each recorded binding hash with
 *  the policy hash of the agent record, which never match, so every position
 *  reports a policy change. */
function positionMismatches(previous: DefinitionIdentity, next: DefinitionIdentity): readonly DefinitionIdentityMismatch[] {
  const changes: DefinitionIdentityMismatch[] = []
  if (isLegacyDefinitionIdentity(previous) && isLegacyDefinitionIdentity(next)) {
    compareRecords(previous.bindings, next.bindings, ({ bindingId }) => bindingId, (bindingId, oldHash, newHash) => {
      changes.push({ component: "binding", bindingId, recorded: oldHash, current: newHash })
    }, ({ sha256 }) => sha256)
    return changes
  }
  const policies = (identity: DefinitionIdentity) => isLegacyDefinitionIdentity(identity)
    ? identity.bindings.map(({ bindingId, sha256 }) => ({ definitionId: bindingId, policySha256: sha256 }))
    : recordsOf(identity)
  if (isLegacyDefinitionIdentity(previous) || isLegacyDefinitionIdentity(next)) {
    compareRecords(policies(previous), policies(next), ({ definitionId }) => definitionId, (definitionId, oldHash, newHash) => {
      changes.push({ component: "agent", definitionId, aspect: "policy", recorded: oldHash, current: newHash })
    }, ({ policySha256 }) => policySha256)
    return changes
  }
  for (const aspect of ["policy", "content", "output"] as const) {
    const member = `${aspect}Sha256` as const
    compareRecords(recordsOf(previous), recordsOf(next), ({ definitionId }) => definitionId, (definitionId, oldHash, newHash) => {
      changes.push({ component: "agent", definitionId, aspect, recorded: oldHash, current: newHash })
    }, (record) => record[member])
  }
  return changes.sort((left, right) => left.component === "agent" && right.component === "agent" ? left.definitionId.localeCompare(right.definitionId) : 0)
}

/** The record hashes of an identity, each named by its definition id. */
function recordsOf(identity: StepDefinitionIdentity) {
  return identity.steps.map(({ stepId, ...hashes }) => ({ definitionId: stepId, ...hashes })) // stored keys of control v11
}

function parseDefinitionIdentity(value: unknown): DefinitionIdentity {
  return Schema.decodeUnknownSync(DefinitionIdentitySchema, { onExcessProperty: "error" })(value)
}



function compareRecords<T>(
  recorded: readonly T[],
  current: readonly T[],
  key: (record: T) => string,
  mismatch: (id: string, recorded: string, current: string) => void,
  value: (record: T) => string,
): void {
  const previous = new Map(recorded.map((record) => [key(record), value(record)]))
  const next = new Map(current.map((record) => [key(record), value(record)]))
  for (const id of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const oldValue = previous.get(id) ?? MISSING
    const newValue = next.get(id) ?? MISSING
    if (oldValue !== newValue) mismatch(id, oldValue, newValue)
  }
}
