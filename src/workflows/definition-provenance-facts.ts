import { Schema } from "effect"
import { createFactParser, defineFact } from "../infra/event-registry.js"
import { Sha256Schema } from "./definition-hash.js"
import { AgentPolicyRecordSchema } from "./definition-records.js"
import { DefinitionLoadedV8PayloadSchema } from "./definition-loaded-v8.js"
import { USER_REQUEST_ARTIFACT_ID } from "./definition-validation.js"
import { DefinitionProvenanceSchema } from "./definition-provenance.js"
import { AttemptRowSchema } from "./view/schemas.js"
import { WorkflowDefinitionSchema } from "./workflow-schema.js"
import { StepGrammarWorkflowSchema } from "./retired-step-grammar/schema.js"
import { DefinitionIdentityMismatchSchema } from "./vm/definition-identity.js"
import type { WorkflowVerificationResult } from "./vm/verify-types.js"

/** What one v1 hash names. The stored kind `step` is history from before
 *  the unification of the retired step definitions and skills, whose hashes
 *  a pre-unification workspace recorded. The stored kind `binding` is
 *  history from before the retired step-content cutover. A reader interprets
 *  a kind by the fact version. */
const DefinitionKindV1Schema = Schema.Literals(["workflow", "binding", "skill", "step"])

/** What one v2 hash names: the workflow, one record of its retired step
 *  grammar (the hash of that stored record), or one composed skill package.
 *  History from before the phase grammar; remove after 2027-04-30. */
const DefinitionKindV2Schema = Schema.Literals(["workflow", "step", "skill"])

/** What one current hash names: the workflow, one of its agent records (the
 *  hash of the recorded agent record), or one composed skill package. */
const DefinitionKindSchema = Schema.Literals(["workflow", "agent", "skill"])

/** A recorded definition from an earlier build, kept readable as history.
 *  The definition is typed loose on purpose: it is the byte shape of a
 *  workflow, retired step definition, or binding as the build that wrote it
 *  defined them, and no reader may hold today's schemas over yesterday's rows. */
const HistoricalDefinitionLoadedPayloadSchema = <const Kinds extends readonly [string, ...string[]]>(kinds: Kinds) => Schema.Struct({
  kind: Schema.Literals(kinds),
  id: Schema.String,
  definition: Schema.Record(Schema.String, Schema.Unknown),
  provenance: Schema.optionalKey(DefinitionProvenanceSchema),
})

/** Pre-unification `definition.loaded`: workflows and retired step definitions. */
const DefinitionLoadedV3PayloadSchema = HistoricalDefinitionLoadedPayloadSchema(["workflow", "step"]) // stored kinds

/** `definition.loaded` from before the retired step-content cutover:
 *  workflows with bindings, bindings, and skills. Remove after 2027-04-30 together with the binding history. */
const DefinitionLoadedV6PayloadSchema = HistoricalDefinitionLoadedPayloadSchema(["workflow", "binding", "skill"])

/** Pre-phase `definition.loaded`: workflows and records of the retired step
 *  grammar, and skills. Every lineage reads it loose; only `runDefinition`
 *  decodes a workflow record of it strictly, with the frozen retired step
 *  grammar, and converts it. Remove after 2027-04-30. */
const DefinitionLoadedV7PayloadSchema = HistoricalDefinitionLoadedPayloadSchema(["workflow", "step", "skill"]) // stored kinds

/** What a compilation records about one composed skill package. The
 *  package's own content identity is the recorded hash; this names the
 *  routing metadata a reader of the store needs to see which procedure ran,
 *  without the body. */
const SkillRecordSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  trigger: Schema.String,
  version: Schema.optionalKey(Schema.String),
  dependencies: Schema.Array(Schema.String),
  agents: Schema.Array(Schema.String),
})

/** What a compilation records about one agent record: which brief it ran
 *  and where the brief resolved, the policy the workflow imposed, and the
 *  canonical output contract with its descriptions. The brief's body is not
 *  recorded; the agent's content hash in the definition identity covers it.
 *  Historical source metadata remains in the frozen v8 decoder. */
const AgentRecordSchema = Schema.Struct({
  definitionId: Schema.String,
  briefId: Schema.String,
  policy: AgentPolicyRecordSchema,
  output: Schema.Record(Schema.String, Schema.Unknown),
})

const DefinitionLoadedPayloadSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("workflow"),
    id: Schema.String,
    definition: WorkflowDefinitionSchema,
    /** The retired step-grammar record of a file that the loader converted to
     *  phases, which a Resume converts again (refer to `recordedWorkflow`).
     *  Remove after 2027-04-30. */
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

const hashRecordedPayload = <S extends Schema.Top>(kind: S) => Schema.Struct({
  kind,
  id: Schema.String,
  sha256: Sha256Schema,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  format: Schema.Literal("canonical-json-v1"),
})

const DefinitionHashRecordedV1PayloadSchema = hashRecordedPayload(DefinitionKindV1Schema)
const DefinitionHashRecordedV2PayloadSchema = hashRecordedPayload(DefinitionKindV2Schema)
const DefinitionHashRecordedPayloadSchema = hashRecordedPayload(DefinitionKindSchema)

/** The members every `workflow.compiled` version shares. A row before
 *  version 11 embedded the stored attempt rows of its build, so a historical
 *  version keeps them loose. */
const CompiledHistoryFields = {
  workflowDefinitionId: Schema.String,
  workflowName: Schema.String,
  userRequestArtifactId: Schema.Literal(USER_REQUEST_ARTIFACT_ID),
  userRequestSha256: Sha256Schema,
  steps: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)), // stored key before workflow.compiled v11
} as const

/** The members of a `workflow.compiled` row from version 8 to 10, which
 *  stored the record ids of its agents as `stepIds`. Remove after 2027-04-30. */
const CompiledStepFields = {
  ...CompiledHistoryFields,
  stepIds: Schema.Array(Schema.String), // stored key of workflow.compiled v8 to v10
  skillIds: Schema.Array(Schema.String),
} as const

/** The verifier result of a launch of a workflow file. A launch warns about
 *  what the verifier did not prove and still runs the file, so a run can
 *  record any result. */
const LaunchVerificationSchema = Schema.Literals(["proved", "partially_proved", "invalid"] satisfies readonly WorkflowVerificationResult[])

const WorkflowCompiledPayloadSchema = Schema.Struct({
  workflowDefinitionId: Schema.String,
  workflowName: Schema.String,
  userRequestArtifactId: Schema.Literal(USER_REQUEST_ARTIFACT_ID),
  userRequestSha256: Sha256Schema,
  /** The agent records of the launch, in run order. */
  definitionIds: Schema.Array(Schema.String),
  skillIds: Schema.Array(Schema.String),
  /** The attempt rows that the launch queued. */
  attempts: Schema.Array(AttemptRowSchema),
  /** The most attempts the launched control can queue: every attempt it
   *  holds, plus each list that has not read its items at its declared
   *  width. */
  worstCaseAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The verifier result of the launch, or null for a launch that ran no
   *  verifier, as for a recorded launch of a named workflow. */
  verification: Schema.NullOr(LaunchVerificationSchema),
  /** What the launch warned about, one short located line each, in the
   *  order the launch found them. Empty for a launch without a warning and
   *  for a recorded launch of a named workflow. */
  warnings: Schema.Array(Schema.NonEmptyString),
})

/** A `workflow.compiled` row that stored `stepIds`, with the warnings of its
 *  launch. Remove after 2027-04-30. */
const WorkflowCompiledV10PayloadSchema = Schema.Struct({
  ...CompiledStepFields,
  worstCaseAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  verification: Schema.NullOr(LaunchVerificationSchema),
  warnings: Schema.Array(Schema.NonEmptyString),
})

/** A `workflow.compiled` row from before a launch could warn. Its launch
 *  refused every file that a warning now names, so it reads as a launch
 *  without a warning, and its verifier result was never `invalid`. Remove
 *  after 2027-04-30. */
const WorkflowCompiledV9PayloadSchema = Schema.Struct({
  ...CompiledStepFields,
  worstCaseAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  verification: Schema.NullOr(Schema.Literals(["proved", "partially_proved"])),
})

/** A `workflow.compiled` row from before a launch recorded its worst case
 *  and its verifier result. Its run reads as a launch that recorded
 *  neither, because neither value can be derived again from the row.
 *  Remove after 2027-04-30. */
const WorkflowCompiledV8PayloadSchema = Schema.Struct(CompiledStepFields)

/** Pre-unification `workflow.compiled`: it stored retired step definition ids. */
const WorkflowCompiledV2PayloadSchema = Schema.Struct({
  ...CompiledHistoryFields,
  stepDefinitionIds: Schema.Array(Schema.String),
})

/** `workflow.compiled` from before the retired step-content cutover: it
 *  named binding ids. Remove after 2027-04-30 together with the binding
 *  history. */
const WorkflowCompiledV5PayloadSchema = Schema.Struct({
  ...CompiledHistoryFields,
  bindingIds: Schema.Array(Schema.String),
  skillIds: Schema.Array(Schema.String),
})

const DefinitionLoadedV3FactSchema = defineFact({
  type: "definition.loaded",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: DefinitionLoadedV3PayloadSchema,
})

/** v6 dropped the retired `ask_user` tool scope from binding snapshots. The
 *  retired-self-review and retired-child-ask-user passes rewrite every v4 and
 *  v5 row to v6 before a reader opens the store, so both stay unregistered. */
const DefinitionLoadedV6FactSchema = defineFact({
  type: "definition.loaded",
  version: 6,
  actor: Schema.Literal("flywheel"),
  payload: DefinitionLoadedV6PayloadSchema,
})

/** v7 recorded retired step records in place of bindings. */
const DefinitionLoadedV7FactSchema = defineFact({
  type: "definition.loaded",
  version: 7,
  actor: Schema.Literal("flywheel"),
  payload: DefinitionLoadedV7PayloadSchema,
})

/** Frozen phase-grammar history with catalog metadata. Remove after 2027-04-30. */
const DefinitionLoadedV8FactSchema = defineFact({
  type: "definition.loaded",
  version: 8,
  actor: Schema.Literal("flywheel"),
  payload: DefinitionLoadedV8PayloadSchema,
})

/** v9 records workflows without retired catalog metadata. */
const DefinitionLoadedFactSchema = defineFact({
  type: "definition.loaded",
  version: 9,
  actor: Schema.Literal("flywheel"),
  payload: DefinitionLoadedPayloadSchema,
})

const DefinitionHashRecordedV1FactSchema = defineFact({
  type: "definition.hash_recorded",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: DefinitionHashRecordedV1PayloadSchema,
})

const DefinitionHashRecordedV2FactSchema = defineFact({
  type: "definition.hash_recorded",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: DefinitionHashRecordedV2PayloadSchema,
})

/** v3 names agent records in place of the retired step records. */
const DefinitionHashRecordedFactSchema = defineFact({
  type: "definition.hash_recorded",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: DefinitionHashRecordedPayloadSchema,
})

const WorkflowCompiledV2FactSchema = defineFact({
  type: "workflow.compiled",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: WorkflowCompiledV2PayloadSchema,
})

/** v5 dropped the retired `ask_user` tool scope from the compiled rows; the
 *  retired-self-review and retired-child-ask-user passes rewrite every v3 and
 *  v4 row to v5 before a reader opens the store. */
const WorkflowCompiledV5FactSchema = defineFact({
  type: "workflow.compiled",
  version: 5,
  actor: Schema.Literal("flywheel"),
  payload: WorkflowCompiledV5PayloadSchema,
})

/** v6 stored retired step ids in place of binding ids. v7 stored the seat of
 *  each compiled row by `contentId` in place of `skillId`, a retired key. v8
 *  stores the body of each compiled while row as one ordered list of its
 *  retired step records. The stored `step-row-content-id` and `loop-body-rows`
 *  passes rewrite every v6 and v7 row to v8 before a reader opens the store,
 *  so both stay unregistered. Remove v8 after 2027-04-30. */
const WorkflowCompiledV8FactSchema = defineFact({
  type: "workflow.compiled",
  version: 8,
  actor: Schema.Literal("flywheel"),
  payload: WorkflowCompiledV8PayloadSchema,
})

/** v9 records the launch's worst-case attempt count and the verifier result
 *  that the launch accepted. Remove after 2027-04-30. */
const WorkflowCompiledV9FactSchema = defineFact({
  type: "workflow.compiled",
  version: 9,
  actor: Schema.Literal("flywheel"),
  payload: WorkflowCompiledV9PayloadSchema,
})

/** v10 records the warnings of the launch, and a verifier result that did
 *  not prove the file. Remove after 2027-04-30. */
const WorkflowCompiledV10FactSchema = defineFact({
  type: "workflow.compiled",
  version: 10,
  actor: Schema.Literal("flywheel"),
  payload: WorkflowCompiledV10PayloadSchema,
})

/** v11 names the agent records of the launch and the attempt rows that it
 *  queued. */
export const WORKFLOW_COMPILED_VERSION = 11

const WorkflowCompiledFactSchema = defineFact({
  type: "workflow.compiled",
  version: WORKFLOW_COMPILED_VERSION,
  actor: Schema.Literal("flywheel"),
  payload: WorkflowCompiledPayloadSchema,
})

const DefinitionDriftRejectedPayloadSchema = Schema.Struct({
  workflowId: Schema.NonEmptyString,
  changes: Schema.NonEmptyArray(DefinitionIdentityMismatchSchema),
  latestSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

const DefinitionDriftRejectedFactSchema = defineFact({
  type: "definition.drift_rejected",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: DefinitionDriftRejectedPayloadSchema,
})

export const DefinitionProvenanceFactSchemas = [
  DefinitionLoadedV3FactSchema,
  DefinitionLoadedV6FactSchema,
  DefinitionLoadedV7FactSchema,
  DefinitionLoadedV8FactSchema,
  DefinitionLoadedFactSchema,
  DefinitionHashRecordedV1FactSchema,
  DefinitionHashRecordedV2FactSchema,
  DefinitionHashRecordedFactSchema,
  WorkflowCompiledV2FactSchema,
  WorkflowCompiledV5FactSchema,
  WorkflowCompiledV8FactSchema,
  WorkflowCompiledV9FactSchema,
  WorkflowCompiledV10FactSchema,
  WorkflowCompiledFactSchema,
  DefinitionDriftRejectedFactSchema,
] as const

const DefinitionProvenanceFactSchema = Schema.Union(DefinitionProvenanceFactSchemas)
const parseDefinitionProvenanceFactFromRegistry = createFactParser(DefinitionProvenanceFactSchemas)

export type DefinitionKind = typeof DefinitionKindSchema.Type
export type DefinitionLoadedPayload =
  | typeof DefinitionLoadedPayloadSchema.Type
  | typeof DefinitionLoadedV8PayloadSchema.Type
  | typeof DefinitionLoadedV7PayloadSchema.Type
  | typeof DefinitionLoadedV6PayloadSchema.Type
  | typeof DefinitionLoadedV3PayloadSchema.Type
export type DefinitionHashRecordedPayload =
  | typeof DefinitionHashRecordedPayloadSchema.Type
  | typeof DefinitionHashRecordedV2PayloadSchema.Type
  | typeof DefinitionHashRecordedV1PayloadSchema.Type
export type CurrentWorkflowCompiledPayload = typeof WorkflowCompiledPayloadSchema.Type
export type WorkflowCompiledPayload =
  | CurrentWorkflowCompiledPayload
  | typeof WorkflowCompiledV10PayloadSchema.Type
  | typeof WorkflowCompiledV9PayloadSchema.Type
  | typeof WorkflowCompiledV8PayloadSchema.Type
  | typeof WorkflowCompiledV5PayloadSchema.Type
  | typeof WorkflowCompiledV2PayloadSchema.Type
export type SkillRecord = typeof SkillRecordSchema.Type
export type AgentRecord = typeof AgentRecordSchema.Type
export type DefinitionDriftRejectedPayload = typeof DefinitionDriftRejectedPayloadSchema.Type
export type DefinitionProvenanceFact = typeof DefinitionProvenanceFactSchema.Type
export type DefinitionDriftRejectedFact = typeof DefinitionDriftRejectedFactSchema.Type

export function parseDefinitionProvenanceFact(value: unknown): DefinitionProvenanceFact {
  return parseDefinitionProvenanceFactFromRegistry<DefinitionProvenanceFact>(value)
}

/** What the launch of a run recorded about its own admission: the
 *  worst-case attempt count, the verifier result, null when the launch ran
 *  no verifier, and the warnings. A v9 row warned about nothing. Undefined
 *  for a row from before a launch recorded them. */
export function recordedLaunchAdmission(payload: WorkflowCompiledPayload): Pick<CurrentWorkflowCompiledPayload, "worstCaseAttempts" | "verification" | "warnings"> | undefined {
  if (!("worstCaseAttempts" in payload)) return undefined
  return { worstCaseAttempts: payload.worstCaseAttempts, verification: payload.verification, warnings: "warnings" in payload ? payload.warnings : [] }
}
