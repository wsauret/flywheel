import { Effect, Schema } from "effect"
import { isWorkflowLocalId } from "../infra/workflow-identifiers.js"
import { EffortSchema } from "../infra/workflow-types.js"
import { ArtifactContractFrontmatterItemSchema, ArtifactContractsFrontmatterSchema } from "./artifact-contracts.js"
import { DefinitionProvenanceSchema } from "./definition-provenance.js"
import { StepGrammarWorkflowSchema } from "./retired-step-grammar/schema.js"
import { OutputRefSchema, SkillIdSchema, VotesSchema } from "./workflow-schema.js"

/** Frozen history for definition.loaded v8, including catalog metadata and
 *  skill-backed agent records. Never derive these shapes from live records.
 *  Remove after 2027-04-30. */
const LocalIdSchema = Schema.NonEmptyString.check(Schema.makeFilter((id) =>
  isWorkflowLocalId(id) || `a phase or agent name must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, or underscores: ${JSON.stringify(id)}`))

const PackageRelativePathSchema = Schema.NonEmptyString.check(Schema.makeFilter((path) =>
  (!path.startsWith("/") && !path.includes("\\") && !path.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
  || `must be a normalized package-relative path: ${JSON.stringify(path)}`))

const ReadsSchema = Schema.Array(LocalIdSchema).check(Schema.makeFilter((ids) => {
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index)
  return repeated === undefined || `reads names ${JSON.stringify(repeated)} more than once`
}))

const RetrySchema = Schema.Struct({
  max: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
  stuck: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
})

const AgentRecordKeys = {
  name: Schema.optionalKey(Schema.NonEmptyString),
  runs: Schema.optionalKey(Schema.NonEmptyString),
  brief: Schema.optionalKey(Schema.String),
  persona: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.optionalKey(Schema.NonEmptyString),
  effort: Schema.optionalKey(EffortSchema),
  writes: Schema.optionalKey(ArtifactContractsFrontmatterSchema),
  reads: Schema.optionalKey(ReadsSchema),
  retry: Schema.optionalKey(RetrySchema),
  output: Schema.optionalKey(OutputRefSchema),
  dependencies: Schema.optionalKey(Schema.Array(SkillIdSchema)),
  subagents: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  arguments: Schema.optionalKey(Schema.Array(Schema.String)),
  redirect: Schema.optionalKey(Schema.Struct({ from: PackageRelativePathSchema, to: PackageRelativePathSchema })),
  child_skills: Schema.optionalKey(Schema.Array(SkillIdSchema)),
} as const

const NamedAgentSchema = Schema.Struct({ agent: LocalIdSchema, ...AgentRecordKeys })
const JoinSchema = Schema.Struct({
  reducer: Schema.NonEmptyString,
  with: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  write: Schema.optionalKey(ArtifactContractFrontmatterItemSchema),
})
const WorkflowPhaseSchema = Schema.Struct({
  phase: LocalIdSchema,
  if: Schema.optionalKey(Schema.NonEmptyString),
  over: Schema.optionalKey(Schema.NonEmptyString),
  label: Schema.optionalKey(Schema.NonEmptyString),
  votes: Schema.optionalKey(VotesSchema),
  join: Schema.optionalKey(JoinSchema),
  agents: Schema.optionalKey(Schema.Array(Schema.Union([LocalIdSchema, NamedAgentSchema])).check(Schema.makeFilter((agents) =>
    agents.length >= 2 || "agents names at least 2 agents; a phase of one agent needs no agents key"))),
  ...AgentRecordKeys,
})
const RepeatLoopSchema = Schema.Union([
  Schema.Struct({
    while: Schema.NonEmptyString,
    max: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    stuck: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
  }),
  Schema.Struct({ each: Schema.NonEmptyString, reassess: Schema.optionalKey(LocalIdSchema) }),
])
const WorkflowRepeatSchema = Schema.Struct({
  repeat: RepeatLoopSchema,
  phases: Schema.NonEmptyArray(WorkflowPhaseSchema),
})
const WorkflowGuardrailsSchema = Schema.Struct({
  max_attempts: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 }))),
  max_parallel: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 }))),
  max_mutations_per_attempt: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
  max_inserts: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 }))),
})
const WorkflowDefinitionSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  use_when: Schema.optionalKey(Schema.String),
  confirmation_template: Schema.Literals(["spec-and-implement", "debug", "qa"]).pipe(
    Schema.withDecodingDefaultTypeKey(Effect.succeed("spec-and-implement" as const)),
  ),
  requires_description: Schema.optionalKey(Schema.Boolean),
  "user-invocable": Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(true))),
  "disable-model-invocation": Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
  guardrails: Schema.optionalKey(WorkflowGuardrailsSchema),
  input: Schema.optionalKey(OutputRefSchema),
  phases: Schema.NonEmptyArray(Schema.Union([WorkflowPhaseSchema, WorkflowRepeatSchema])),
})
const AgentPolicyRecordSchema = Schema.Struct({
  definitionId: Schema.String,
  name: AgentRecordKeys.name,
  runs: AgentRecordKeys.runs,
  persona: AgentRecordKeys.persona,
  writes: AgentRecordKeys.writes,
  reads: AgentRecordKeys.reads,
  arguments: AgentRecordKeys.arguments,
  redirect: AgentRecordKeys.redirect,
  child_skills: AgentRecordKeys.child_skills,
})
const AgentRecordSchema = Schema.Struct({
  definitionId: Schema.String,
  briefId: Schema.String,
  source: Schema.Literals(["inline", "bundled", "local", "skill"]),
  policy: AgentPolicyRecordSchema,
  output: Schema.Record(Schema.String, Schema.Unknown),
})
const SkillRecordSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  trigger: Schema.String,
  version: Schema.optionalKey(Schema.String),
  dependencies: Schema.Array(Schema.String),
  agents: Schema.Array(Schema.String),
})

export const DefinitionLoadedV8PayloadSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("workflow"),
    id: Schema.String,
    definition: WorkflowDefinitionSchema,
    retiredStepGrammar: Schema.optionalKey(StepGrammarWorkflowSchema),
    provenance: Schema.optionalKey(DefinitionProvenanceSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    id: Schema.String,
    definition: AgentRecordSchema,
    provenance: Schema.optionalKey(DefinitionProvenanceSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("skill"),
    id: Schema.String,
    definition: SkillRecordSchema,
    provenance: Schema.optionalKey(DefinitionProvenanceSchema),
  }),
])
