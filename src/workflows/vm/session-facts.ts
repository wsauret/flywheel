import { Schema } from "effect";
import { createFactParser, defineFact, factDescriptors, factTypes } from "../../infra/event-registry.js";
import { DefinitionProvenanceFactSchemas } from "../definition-provenance-facts.js";
import { HandoffFactSchemas } from "../output-contract/facts.js";
import { MemoryFactSchemas } from "../memory/memory-facts.js";
import { WorkflowContextFactSchemas } from "../context-bundle/context-facts.js";
import { WorkflowQueueFactSchemas } from "../view/view-facts.js";
import { WorkflowRunFactSchemas } from "../run-facts.js";
import { SessionRuntimeFactSchemas } from "../../infra/runtime-fact-parser.js";
import { SESSION_RUNTIME_FACT_DEFINITIONS } from "../../infra/runtime-fact-types.js";
import { ImprovementFactSchemas } from "../improvements/improvement-facts.js";
import {
  CommittedWorkflowControlSchema,
  WorkflowControlV11Schema,
  FollowUpTransferPayloadSchema,
  IdentifiedFollowUpIdentitySchema,
  type CommittedWorkflowControl,
} from "./committed-control.js";
import { DurableFollowUpInputSchema } from "../../infra/chat-input-schema.js";
import {
  encodeHistoricalWorkflowEvent,
  HistoricalFollowUpRequestV1Schema,
  HistoricalWorkflowControlV2Schema,
  HistoricalWorkflowProposalEventV2Schema,
  normalizeHistoricalWorkflowEvent,
  ExpansionChangeV8Schema,
  GraphChangeV5Schema,
  ReassessmentChangeV3Schema,
  RecoveredWorkflowControlV1Schema,
  WorkflowControlV3Schema,
  WorkflowControlV4Schema,
  WorkflowControlV5Schema,
  WorkflowControlV6Schema,
  WorkflowControlV7Schema,
  WorkflowControlV8Schema,
  WorkflowControlV9Schema,
  WorkflowControlV10Schema,
  WorkflowProposalEventV4Schema,
  WorkflowProposalEventV5Schema,
} from "./historical-codecs.js";
import {
  normalizeExpansionChangeV8,
  normalizeHistoricalWorkflowControl,
  normalizeWorkflowControlV10,
  normalizeWorkflowControlV3,
  normalizeWorkflowControlV4,
  normalizeWorkflowControlV5,
  normalizeWorkflowControlV6,
  normalizeWorkflowControlV7,
  normalizeWorkflowControlV8,
  normalizeWorkflowControlV9,
} from "./historical-normalization.js";
import { AttemptFailedV2PayloadSchema, AttemptRetryInsertedV1PayloadSchema, AttemptSucceededV2PayloadSchema, WorkflowProposalEventV6Schema, WorkflowProposalEventV9Schema } from "./historical-attempt-codecs.js";
import {
  DefinitionIdentityMismatchSchema,
  DefinitionIdentitySchema,
  DefinitionIdentityMigrationSchema,
  definitionIdentityMigrationReason,
  definitionIdentityMismatches,
  type DefinitionIdentity,
  type DefinitionIdentityMigrationId,
} from "./definition-identity.js";
import { ExpansionChangeSchema, ReducerSummarySchema, type ExpansionChange } from "./graph-types.js";
import {
  CURRENT_PROPOSAL_ENCODING,
  holdsCurrentEvent,
  ReassessmentChangeSchema,
  WorkflowProposalEventSchema,
  WorkflowProposalEventV13Schema,
  type DecodedWorkflowProposalEvent,
  type WorkflowProposalEncoding,
} from "./events.js";

const IdSchema = Schema.NonEmptyString;
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ActorSchema = Schema.Literal("flywheel");
const RecoveryIdentitySchema = Schema.Struct({
  source: Schema.Union([Schema.Literal("recovered"), Schema.Literal("synthesized")]),
  value: IdSchema,
});
const WorkflowRecoveryDegradationReasonSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("malformed_fact"), seq: NonNegativeIntSchema }),
  Schema.Struct({ kind: Schema.Literal("recognized_legacy_version"), seq: NonNegativeIntSchema, type: IdSchema, version: NonNegativeIntSchema }),
  Schema.Struct({ kind: Schema.Literal("recognized_newer_version"), seq: NonNegativeIntSchema, type: IdSchema, version: NonNegativeIntSchema }),
  Schema.Struct({ kind: Schema.Literal("unknown_version"), seq: NonNegativeIntSchema, type: IdSchema, version: NonNegativeIntSchema }),
  Schema.Struct({ kind: Schema.Literal("missing_root") }),
  Schema.Struct({ kind: Schema.Literal("missing_companion"), family: Schema.Literals(["queue.created", "context.input.seeded"]) }),
  Schema.Struct({ kind: Schema.Literal("invalid_suffix"), seq: NonNegativeIntSchema }),
]);
export type WorkflowRecoveryDegradationReason = typeof WorkflowRecoveryDegradationReasonSchema.Type;


/** The `initialized` root fact at `version`, whose control `control` decodes. */
function initializedFact<const V extends number, C extends Schema.Top & Schema.Decoder<unknown, never>>(version: V, control: () => C) {
  return defineFact({ type: "workflow.control.initialized", version, actor: ActorSchema, payload: Schema.Struct({ control: Schema.suspend(control) }) });
}
const WorkflowControlInitializedV2FactSchema = initializedFact(2, () => HistoricalWorkflowControlV2Schema);
const WorkflowControlInitializedV3FactSchema = initializedFact(3, () => WorkflowControlV3Schema);
const WorkflowControlInitializedV4FactSchema = initializedFact(4, () => WorkflowControlV4Schema);
// Version 5 holds the phase graph: phase nodes, phase ownership at any depth,
// and declared phase limits.
const WorkflowControlInitializedV5FactSchema = initializedFact(5, () => WorkflowControlV5Schema);
// Version 6 holds the graph of the retired map: the stored `group` and
// `branch` nodes and owners, their attempt provenance, and the `collect_all` join.
const WorkflowControlInitializedV6FactSchema = initializedFact(6, () => WorkflowControlV6Schema);
// Version 7 pins each group's output contract on its reducer.
const WorkflowControlInitializedV7FactSchema = initializedFact(7, () => WorkflowControlV7Schema);
// Version 8 holds the loop over a list: its rounds node and the ownership of
// the group of each round.
const WorkflowControlInitializedV8FactSchema = initializedFact(8, () => WorkflowControlV8Schema);
// Version 9 holds the author's `max_parallel` in the guardrails.
const WorkflowControlInitializedV9FactSchema = initializedFact(9, () => WorkflowControlV9Schema);
// Version 10 holds the votes of a list's join and the vote of each of its
// agents.
const WorkflowControlInitializedV10FactSchema = initializedFact(10, () => WorkflowControlV10Schema);
// Version 11 holds the control of phases: agent, phase, list, item, and
// repeat nodes, the `if` of a node and its skipped state, and the history
// arms that execute control from before phases.
const WorkflowControlInitializedV11FactSchema = initializedFact(11, () => WorkflowControlV11Schema);
const WORKFLOW_CONTROL_INITIALIZED_VERSION = 12;
const WorkflowControlInitializedFactSchema = initializedFact(WORKFLOW_CONTROL_INITIALIZED_VERSION, () => CommittedWorkflowControlSchema);
const WorkflowControlRecoveredV1FactSchema = defineFact({
  type: "workflow.control.recovered", version: 1, actor: ActorSchema,
  payload: Schema.Struct({
    supersededThroughSeq: NonNegativeIntSchema,
    degradationReasons: Schema.NonEmptyArray(WorkflowRecoveryDegradationReasonSchema),
    runtimeIdentity: Schema.Struct({ version: IdSchema, buildId: IdSchema }),
    identities: Schema.Struct({
      workflow: RecoveryIdentitySchema,
      step: Schema.NullOr(RecoveryIdentitySchema), // stored key of recovery identities
      attempt: Schema.NullOr(RecoveryIdentitySchema),
      conversation: Schema.NullOr(RecoveryIdentitySchema),
    }),
    control: Schema.suspend(() => RecoveredWorkflowControlV1Schema),
  }),
});
/** The `recovered` root fact at `version`: the recovery record of version 1
 *  with the control that `control` decodes, which is the control of the
 *  `initialized` root of the same version. */
function recoveredFact<const V extends number, C extends Schema.Top & Schema.Decoder<unknown, never>>(version: V, control: () => C) {
  const { control: _v1, ...recovery } = WorkflowControlRecoveredV1FactSchema.fields.payload.fields;
  return defineFact({ type: "workflow.control.recovered", version, actor: ActorSchema, payload: Schema.Struct({ ...recovery, control: Schema.suspend(control) }) });
}
const WorkflowControlRecoveredV2FactSchema = recoveredFact(2, () => HistoricalWorkflowControlV2Schema);
const WorkflowControlRecoveredV3FactSchema = recoveredFact(3, () => WorkflowControlV3Schema);
const WorkflowControlRecoveredV4FactSchema = recoveredFact(4, () => WorkflowControlV4Schema);
const WorkflowControlRecoveredV5FactSchema = recoveredFact(5, () => WorkflowControlV5Schema);
const WorkflowControlRecoveredV6FactSchema = recoveredFact(6, () => WorkflowControlV6Schema);
const WorkflowControlRecoveredV7FactSchema = recoveredFact(7, () => WorkflowControlV7Schema);
const WorkflowControlRecoveredV8FactSchema = recoveredFact(8, () => WorkflowControlV8Schema);
const WorkflowControlRecoveredV9FactSchema = recoveredFact(9, () => WorkflowControlV9Schema);
const WorkflowControlRecoveredV10FactSchema = recoveredFact(10, () => WorkflowControlV10Schema);
const WorkflowControlRecoveredV11FactSchema = recoveredFact(11, () => WorkflowControlV11Schema);
const WORKFLOW_CONTROL_RECOVERED_VERSION = 12;
const WorkflowControlRecoveredFactSchema = recoveredFact(WORKFLOW_CONTROL_RECOVERED_VERSION, () => CommittedWorkflowControlSchema);
const ForExpansionRejectedFactSchema = defineFact({
  type: "for.expansion_rejected", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ nodeId: IdSchema, reason: Schema.NonEmptyString }),
});
const ForExpandedFactSchema = defineFact({
  type: "for.expanded", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ nodeId: IdSchema, itemCount: NonNegativeIntSchema }),
});
// A list expansion: the item nodes, agent nodes, edges, and join it added,
// the count of the items that it admitted, and the context entries every
// item of the list shares. Version 1 records its changes in graph version 5
// shapes and version 2 in graph version 8 shapes, where an agent of a list
// with votes carries its vote; a proposal of encoding 9 or earlier writes them
// (refer to `buildGroupExpandedFact`). Version 3 records the changes of
// control version 11.
const GroupExpandedV1FactSchema = defineFact({
  type: "group.expanded", version: 1, actor: ActorSchema,
  payload: Schema.Struct({
    groupNodeId: IdSchema,
    itemCount: NonNegativeIntSchema,
    changes: Schema.Array(GraphChangeV5Schema),
    admittedContext: Schema.Array(IdSchema),
  }),
});
const GroupExpandedV2FactSchema = defineFact({
  type: "group.expanded", version: 2, actor: ActorSchema,
  payload: Schema.Struct({ ...GroupExpandedV1FactSchema.fields.payload.fields, changes: Schema.Array(ExpansionChangeV8Schema) }),
});
const GroupExpandedFactSchema = defineFact({
  type: "group.expanded", version: 3, actor: ActorSchema,
  payload: Schema.Struct({ ...GroupExpandedV1FactSchema.fields.payload.fields, changes: Schema.Array(ExpansionChangeSchema) }),
});
// A refused list expansion. The proposal fails the workflow and changes no
// graph.
const GroupExpansionRejectedFactSchema = defineFact({
  type: "group.expansion_rejected", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ groupNodeId: IdSchema, reason: Schema.NonEmptyString }),
});
const ReducerSlotSchema = Schema.Struct({
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  key: IdSchema,
  branchNodeId: IdSchema,
  disposition: Schema.Literals(["completed", "failed"]),
  handoff: Schema.NullOr(Schema.Struct({ stepId: IdSchema, sha256: Schema.NonEmptyString })), // stored key of handoff evidence
});
// A folded join: the exact ordered reducer input, which is one slot per
// manifest item with a reference to its handoff, the sha256 of that input,
// the reducer output, and the counts control keeps.
const GroupSettledFactSchema = defineFact({
  type: "group.settled", version: 1, actor: ActorSchema,
  payload: Schema.Struct({
    groupNodeId: IdSchema,
    reducer: Schema.Struct({ id: IdSchema, version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
    input: Schema.Array(ReducerSlotSchema),
    inputSha256: Schema.NonEmptyString,
    output: Schema.Record(Schema.String, Schema.Json),
    summary: ReducerSummarySchema,
  }),
});
// Version 1: an attempt of a stream agent whose handoff failed after its
// retries, which proposals of encoding 7 and earlier record. Its item fails,
// and the other items continue. Strict replay of those runs re-derives version 1, so
// the schema stays while such runs are replayed; remove it after 2027-04-10,
// when no supported build replays a run of encoding 7 or earlier.
const AUTHORED_HANDOFF_FAILURES = ["handoff", "missing_handoff", "invalid_handoff"] as const;
const AttemptFailedV1FactSchema = defineFact({
  type: "attempt.failed", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ attemptId: IdSchema, kind: Schema.Literals(AUTHORED_HANDOFF_FAILURES), reason: Schema.NonEmptyString }),
});
// Version 2: any attempt that failed for good, after its retries, for any
// failure kind. It fails only its agent: every agent that does not depend on
// that agent still runs (encoding 8).
const AttemptFailedV2FactSchema = defineFact({
  type: "attempt.failed", version: 2, actor: ActorSchema, payload: AttemptFailedV2PayloadSchema,
});
// Version 3 adds the optional measured count. An absent count stays unknown.
const AttemptFailedFactSchema = defineFact({
  type: "attempt.failed", version: 3, actor: ActorSchema,
  payload: Schema.Struct({ attemptId: IdSchema, kind: Schema.Literals([...AUTHORED_HANDOFF_FAILURES, "transient", "context_overflow", "fatal"]), reason: Schema.NonEmptyString, toolUses: Schema.optionalKey(NonNegativeIntSchema) }),
});
const AttemptStartedFactSchema = defineFact({
  type: "attempt.started", version: 1, actor: ActorSchema, payload: Schema.Struct({ attemptId: IdSchema }),
});
// Version 1 carried an inert evidence list that every producer wrote empty.
const AttemptSucceededV1FactSchema = defineFact({
  type: "attempt.succeeded", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ attemptId: IdSchema, evidence: Schema.Array(Schema.String) }),
});
const AttemptSucceededV2FactSchema = defineFact({
  type: "attempt.succeeded", version: 2, actor: ActorSchema, payload: AttemptSucceededV2PayloadSchema,
});
const AttemptSucceededFactSchema = defineFact({
  type: "attempt.succeeded", version: 3, actor: ActorSchema,
  payload: Schema.Struct({ attemptId: IdSchema, toolUses: Schema.optionalKey(NonNegativeIntSchema) }),
});
const AttemptBlockedFactSchema = defineFact({
  type: "attempt.blocked", version: 1, actor: ActorSchema,
  payload: Schema.Struct({
    attemptId: IdSchema,
    reason: Schema.NonEmptyString,
    evidence: Schema.NonEmptyString,
  }),
});
const AttemptRetryInsertedV1FactSchema = defineFact({
  type: "attempt.retry_inserted", version: 1, actor: ActorSchema, payload: AttemptRetryInsertedV1PayloadSchema,
});
const AttemptRetryInsertedFactSchema = defineFact({
  type: "attempt.retry_inserted", version: 2, actor: ActorSchema,
  payload: Schema.Struct({ attemptId: IdSchema, retryAttemptId: IdSchema, feedback: Schema.String, toolUses: Schema.optionalKey(NonNegativeIntSchema) }),
});
const AttemptInsertionRejectedFactSchema = defineFact({
  type: "attempt.insertion_rejected", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ attemptId: IdSchema, reason: Schema.NonEmptyString }),
});
const AttemptRevertedFactSchema = defineFact({
  type: "attempt.reverted", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ attemptId: IdSchema, reason: Schema.NonEmptyString, conversationCleared: Schema.Boolean }),
});
const AttemptResumeCapExceededFactSchema = defineFact({
  type: "attempt.resume_cap_exceeded", version: 1, actor: ActorSchema, payload: Schema.Struct({}),
});
const AttemptResumeRecoveredFactSchema = defineFact({
  type: "attempt.resume_recovered", version: 1, actor: ActorSchema, payload: Schema.Struct({}),
});
const AttemptRecoveredFactSchema = defineFact({
  type: "attempt.recovered", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ attemptId: IdSchema, conversationId: Schema.NullOr(IdSchema) }),
});
const WorkflowReassessedV2FactSchema = defineFact({
  type: "workflow.reassessed", version: 2, actor: ActorSchema,
  payload: Schema.Struct({ proposalId: IdSchema, changes: Schema.Array(ReassessmentChangeV3Schema) }),
});
// Version 3 adds the item changes of a repeat over items.
const WorkflowReassessedFactSchema = defineFact({
  type: "workflow.reassessed", version: 3, actor: ActorSchema,
  payload: Schema.Struct({ proposalId: IdSchema, changes: Schema.Array(ReassessmentChangeSchema) }),
});
const WorkflowPausedFactSchema = defineFact({
  type: "workflow.paused", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ reason: Schema.NonEmptyString }),
});
const WorkflowResumedFactSchema = defineFact({
  type: "workflow.resumed", version: 1, actor: ActorSchema, payload: Schema.Struct({}),
});
const WorkflowAbortedFactSchema = defineFact({
  type: "workflow.aborted", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ reason: Schema.NonEmptyString }),
});
const WorkflowCompletedFactSchema = defineFact({
  type: "workflow.completed", version: 1, actor: ActorSchema, payload: Schema.Struct({}),
});
const WorkflowFailedFactSchema = defineFact({
  type: "workflow.failed", version: 1, actor: ActorSchema, payload: Schema.Struct({}),
});
const FollowUpRequestedV1FactSchema = defineFact({
  type: "follow_up.requested", version: 1, actor: ActorSchema,
  payload: HistoricalFollowUpRequestV1Schema,
});
export const FollowUpRequestedFactSchema = defineFact({
  type: "follow_up.requested", version: 2, actor: ActorSchema,
  payload: Schema.Struct({
    input: DurableFollowUpInputSchema,
    identity: IdentifiedFollowUpIdentitySchema,
    conversationId: IdSchema,
    requestSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
});
const FollowUpSucceededFactSchema = defineFact({
  type: "follow_up.succeeded", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ conversationId: IdSchema, requestSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
});
const FollowUpFailedFactSchema = defineFact({
  type: "follow_up.failed", version: 1, actor: ActorSchema,
  payload: Schema.Struct({ reason: Schema.NonEmptyString, conversationId: IdSchema, requestSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
});
export const FollowUpTransferredFactSchema = defineFact({
  type: "follow_up.transferred", version: 1, actor: ActorSchema,
  payload: FollowUpTransferPayloadSchema,
});
/** The terminal fact of a proposal at `version`, whose event `event` decodes. */
function committedFact<const V extends number, E extends Schema.Top & Schema.Decoder<unknown, never>>(version: V, event: E) {
  return defineFact({ type: "workflow.control.committed", version, actor: ActorSchema, payload: Schema.Struct({ proposalId: IdSchema, event }) });
}
const WorkflowControlCommittedV2FactSchema = committedFact(2, HistoricalWorkflowProposalEventV2Schema);
const WorkflowControlCommittedV3FactSchema = committedFact(3, WorkflowProposalEventV4Schema);
const WorkflowControlCommittedV4FactSchema = committedFact(4, WorkflowProposalEventV4Schema);
const WorkflowControlCommittedV5FactSchema = committedFact(5, WorkflowProposalEventV5Schema);
// Version 6 holds the event before measured operations. Its proposals freeze a list's shared
// context from every completed workflow-scope attempt.
const WorkflowControlCommittedV6FactSchema = committedFact(6, WorkflowProposalEventV6Schema);
// Version 7 holds the same event. Its proposals freeze a list's shared
// context from the attempts that complete before the list can start, so the
// context does not depend on the order in which parallel attempts finish.
const WorkflowControlCommittedV7FactSchema = committedFact(7, WorkflowProposalEventV6Schema);
// Version 8 holds the same event. Its proposals settle a failed agent as
// failed and let every agent that does not depend on it run. Versions 6 and 7 paused the run on such a failure, and strict replay
// re-derives them at their version.
const WorkflowControlCommittedV8FactSchema = committedFact(8, WorkflowProposalEventV6Schema);
// Version 9 adds optional tool-use counts to attempt outcomes and failures.
const WorkflowControlCommittedV9FactSchema = committedFact(9, WorkflowProposalEventV9Schema);
// Version 10 holds the item changes of a repeat's reassessment, and its
// proposals name the new nodes of a list `item` and `phase`.
const WorkflowControlCommittedV10FactSchema = committedFact(10, WorkflowProposalEventV13Schema);
// Version 11 holds the same event. Its proposals end a `while` repeat on its
// check: a live check in the last round skips the phases after it. Version
// 10 ran them, and strict replay re-derives it at its version.
const WorkflowControlCommittedV11FactSchema = committedFact(11, WorkflowProposalEventV13Schema);
// Version 12 keeps a named phase failed when a child failed, also with a
// join. Earlier proposals completed such phases. Strict replay keeps that
// rule until this reader is removed after 2027-04-30.
// Remove after 2027-10-17. Version 12 re-pends failed attempts on Resume.
const WorkflowControlCommittedV12FactSchema = committedFact(12, WorkflowProposalEventV13Schema);
// Version 13 retains the failed attempt of a Resume as evidence beside its
// continuation. Version 14 names the progressed attempts of a RECOVER, so
// versions 10 to 13 hold its frozen arm (`WorkflowProposalEventV13Schema`).
const WorkflowControlCommittedV13FactSchema = committedFact(13, WorkflowProposalEventV13Schema);
const WorkflowControlCommittedFactSchema = committedFact(CURRENT_PROPOSAL_ENCODING, WorkflowProposalEventSchema);
const DefinitionIdentityMigratedFactSchema = defineFact({
  type: "workflow.definition_identity.migrated", version: 1, actor: ActorSchema,
  payload: DefinitionIdentityMigrationSchema,
});
const DefinitionIdentityAdoptedFactSchema = defineFact({
  type: "workflow.definition_identity.adopted", version: 1, actor: ActorSchema,
  payload: Schema.Struct({
    prior: DefinitionIdentitySchema,
    adopted: DefinitionIdentitySchema,
    evidence: Schema.Array(DefinitionIdentityMismatchSchema),
  }),
});

const WorkflowControlFactSchemas = [
  WorkflowControlInitializedV2FactSchema,
  WorkflowControlInitializedV3FactSchema,
  WorkflowControlInitializedV4FactSchema,
  WorkflowControlInitializedV5FactSchema,
  WorkflowControlInitializedV6FactSchema,
  WorkflowControlInitializedV7FactSchema,
  WorkflowControlInitializedV8FactSchema,
  WorkflowControlInitializedV9FactSchema,
  WorkflowControlInitializedV10FactSchema,
  WorkflowControlInitializedV11FactSchema,
  WorkflowControlInitializedFactSchema,
  WorkflowControlRecoveredV1FactSchema,
  WorkflowControlRecoveredV2FactSchema,
  WorkflowControlRecoveredV3FactSchema,
  WorkflowControlRecoveredV4FactSchema,
  WorkflowControlRecoveredV5FactSchema,
  WorkflowControlRecoveredV6FactSchema,
  WorkflowControlRecoveredV7FactSchema,
  WorkflowControlRecoveredV8FactSchema,
  WorkflowControlRecoveredV9FactSchema,
  WorkflowControlRecoveredV10FactSchema,
  WorkflowControlRecoveredV11FactSchema,
  WorkflowControlRecoveredFactSchema,
  ForExpansionRejectedFactSchema,
  ForExpandedFactSchema,
  GroupExpandedV1FactSchema,
  GroupExpandedV2FactSchema,
  GroupExpandedFactSchema,
  GroupExpansionRejectedFactSchema,
  GroupSettledFactSchema,
  AttemptFailedV1FactSchema,
  AttemptFailedV2FactSchema,
  AttemptFailedFactSchema,
  AttemptStartedFactSchema,
  AttemptSucceededFactSchema,
  AttemptSucceededV1FactSchema,
  AttemptSucceededV2FactSchema,
  AttemptBlockedFactSchema,
  AttemptRetryInsertedFactSchema,
  AttemptRetryInsertedV1FactSchema,
  AttemptInsertionRejectedFactSchema,
  AttemptRevertedFactSchema,
  AttemptResumeCapExceededFactSchema,
  AttemptResumeRecoveredFactSchema,
  AttemptRecoveredFactSchema,
  WorkflowReassessedV2FactSchema,
  WorkflowReassessedFactSchema,
  WorkflowPausedFactSchema,
  WorkflowResumedFactSchema,
  WorkflowAbortedFactSchema,
  WorkflowCompletedFactSchema,
  WorkflowFailedFactSchema,
  FollowUpRequestedFactSchema,
  FollowUpRequestedV1FactSchema,
  FollowUpSucceededFactSchema,
  FollowUpFailedFactSchema,
  FollowUpTransferredFactSchema,
  WorkflowControlCommittedFactSchema,
  WorkflowControlCommittedV13FactSchema,
  WorkflowControlCommittedV12FactSchema,
  WorkflowControlCommittedV11FactSchema,
  WorkflowControlCommittedV10FactSchema,
  WorkflowControlCommittedV9FactSchema,
  WorkflowControlCommittedV8FactSchema,
  WorkflowControlCommittedV7FactSchema,
  WorkflowControlCommittedV6FactSchema,
  WorkflowControlCommittedV5FactSchema,
  WorkflowControlCommittedV4FactSchema,
  WorkflowControlCommittedV3FactSchema,
  WorkflowControlCommittedV2FactSchema,
  DefinitionIdentityMigratedFactSchema,
  DefinitionIdentityAdoptedFactSchema,
] as const;

const WorkflowControlFactSchema = Schema.Union(WorkflowControlFactSchemas);
export type WorkflowControlFact = typeof WorkflowControlFactSchema.Type;
const parseWorkflowControlFactFromRegistry = createFactParser(WorkflowControlFactSchemas);
export const WORKFLOW_CONTROL_FACT_TYPES = factTypes(WorkflowControlFactSchemas);
const WorkflowSessionFactSchemas = [
  ...SessionRuntimeFactSchemas.filter((_schema, index) => {
    const type = SESSION_RUNTIME_FACT_DEFINITIONS[index]?.type
    return type?.startsWith("budget.") || type === "model.usage.measured"
  }),
  ...WorkflowRunFactSchemas,
  ...ImprovementFactSchemas,
  ...WorkflowControlFactSchemas,
  ...DefinitionProvenanceFactSchemas,
  ...WorkflowQueueFactSchemas,
  ...WorkflowContextFactSchemas,
  ...HandoffFactSchemas,
  ...MemoryFactSchemas,
] as const;
export const WorkflowSessionFactSchema = Schema.Union(WorkflowSessionFactSchemas);
export const WORKFLOW_SESSION_FACT_DESCRIPTORS = factDescriptors(WorkflowSessionFactSchemas);
const parseWorkflowSessionFactFromRegistry = createFactParser(WorkflowSessionFactSchemas);
export type WorkflowSessionFact = typeof WorkflowSessionFactSchema.Type;
export type WorkflowControlFactDraft = Exclude<WorkflowControlFact, {
  type: "workflow.control.initialized" | "workflow.control.recovered" | "workflow.control.committed" | "workflow.definition_identity.migrated" | "workflow.definition_identity.adopted";
}>;

export function parseWorkflowSessionFact(value: unknown): WorkflowSessionFact {
  return parseWorkflowSessionFactFromRegistry<WorkflowSessionFact>(value);
}

export function parseWorkflowControlFact(value: unknown): WorkflowControlFact {
  return parseWorkflowControlFactFromRegistry<WorkflowControlFact>(value);
}

export function workflowAggregateId(sessionId: string): string {
  return `workflow:${sessionId}`;
}

export function buildWorkflowControlInitializedFact(control: CommittedWorkflowControl): typeof WorkflowControlInitializedFactSchema.Type {
  const committed = { ...control, aggregateSeq: control.aggregateSeq + 1 };
  return Schema.decodeUnknownSync(WorkflowControlInitializedFactSchema, { onExcessProperty: "error" })({
    type: "workflow.control.initialized", version: WORKFLOW_CONTROL_INITIALIZED_VERSION, actor: "flywheel", payload: { control: committed },
  });
}

export type WorkflowControlRecoveryInput = typeof WorkflowControlRecoveredFactSchema.Type["payload"];

export function buildWorkflowControlRecoveredFact(input: WorkflowControlRecoveryInput): typeof WorkflowControlRecoveredFactSchema.Type {
  return Schema.decodeUnknownSync(WorkflowControlRecoveredFactSchema, { onExcessProperty: "error" })({
    type: "workflow.control.recovered",
    version: WORKFLOW_CONTROL_RECOVERED_VERSION,
    actor: "flywheel",
    payload: input,
  });
}

/** Build the terminal fact of a proposal. A current writer commits at
 *  `CURRENT_PROPOSAL_ENCODING`. Strict replay re-derives a stored proposal at its recorded version, so
 *  the event is encoded in that version's frozen shape. */
export function buildWorkflowControlCommittedFact(
  proposalId: string,
  event: DecodedWorkflowProposalEvent,
  version: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING,
): WorkflowControlFact {
  const encoded = holdsCurrentEvent(version) ? event : encodeHistoricalWorkflowEvent(event, version);
  return parseWorkflowControlFact({
    type: "workflow.control.committed", version, actor: "flywheel", payload: { proposalId, event: encoded },
  });
}

type WorkflowRootFact = Extract<WorkflowControlFact, { type: "workflow.control.initialized" | "workflow.control.recovered" }>;
type WorkflowCommittedFact = Extract<WorkflowControlFact, { type: "workflow.control.committed" }>;

/** Return canonical control from a root whose historical or current payload was strictly decoded. */
export function workflowRootControl(fact: WorkflowRootFact): CommittedWorkflowControl {
  switch (fact.version) {
    case 12:
    case 11: return fact.payload.control;
    case 10: return normalizeWorkflowControlV10(fact.payload.control);
    case 9: return normalizeWorkflowControlV9(fact.payload.control);
    case 8: return normalizeWorkflowControlV8(fact.payload.control);
    case 7: return normalizeWorkflowControlV7(fact.payload.control);
    case 6: return normalizeWorkflowControlV6(fact.payload.control);
    case 5: return normalizeWorkflowControlV5(fact.payload.control);
    case 4: return normalizeWorkflowControlV4(fact.payload.control);
    case 3: return normalizeWorkflowControlV3(fact.payload.control);
    case 1:
    case 2: return normalizeHistoricalWorkflowControl(fact.payload.control);
  }
}

/** Return the canonical event of a strictly decoded terminal fact of any version. */
export function committedWorkflowEvent(fact: WorkflowCommittedFact): DecodedWorkflowProposalEvent {
  if (fact.version === CURRENT_PROPOSAL_ENCODING) return fact.payload.event;
  if (fact.version === 2 || fact.version === 3 || fact.version === 4 || fact.version === 5) return normalizeHistoricalWorkflowEvent(fact.payload.event);
  const { event } = fact.payload;
  return event.type === "RESUME" || event.type === "RECOVER" ? normalizeHistoricalWorkflowEvent(event) : event;
}

/** The one shape strict replay compares. Every fact keeps its exact type and
 *  version, and a current fact compares exactly. A fact of a historical version
 *  and its re-derivation at that version map to equal values when they record
 *  the same act: the inert evidence of a version 1 success drops out, and a
 *  historical terminal fact compares its canonical event. */
type ReplayComparableFact =
  | { readonly type: "attempt.succeeded"; readonly version: 1; readonly actor: string; readonly attemptId: string }
  | {
    readonly type: "workflow.control.committed";
    readonly version: number;
    readonly actor: string;
    readonly proposalId: string;
    readonly event: DecodedWorkflowProposalEvent;
  }
  | WorkflowSessionFact;

export function replayComparableFact(fact: WorkflowSessionFact): ReplayComparableFact {
  switch (fact.type) {
    case "attempt.succeeded": return fact.version === 1
      ? { type: fact.type, version: fact.version, actor: fact.actor, attemptId: fact.payload.attemptId }
      : fact;
    case "workflow.control.committed": return holdsCurrentEvent(fact.version) ? fact : {
      type: fact.type,
      version: fact.version,
      actor: fact.actor,
      proposalId: fact.payload.proposalId,
      event: committedWorkflowEvent(fact),
    };
    default: return fact;
  }
}

/** Record the append-only adoption of one registered chain migration. `prior` is
 *  the identity the session currently holds and `adopted` the identity the
 *  migration selects; the reason comes from the registry, so a fact can never
 *  state a reason the chain does not define. Replay verifies the prior and the
 *  derived evidence before it adopts. */
export function buildDefinitionIdentityMigratedFact(
  migrationId: DefinitionIdentityMigrationId,
  prior: DefinitionIdentity,
  adopted: DefinitionIdentity,
): WorkflowControlFact {
  return parseWorkflowControlFact({
    type: "workflow.definition_identity.migrated",
    version: 1,
    actor: "flywheel",
    payload: {
      migrationId,
      reason: definitionIdentityMigrationReason(migrationId),
      prior,
      adopted,
      evidence: definitionIdentityMismatches(prior, adopted),
    },
  });
}

export function buildDefinitionIdentityAdoptedFact(
  prior: DefinitionIdentity,
  adopted: DefinitionIdentity,
): WorkflowControlFact {
  return parseWorkflowControlFact({
    type: "workflow.definition_identity.adopted",
    version: 1,
    actor: "flywheel",
    payload: { prior, adopted, evidence: definitionIdentityMismatches(prior, adopted) },
  });
}

/** The changes of a stored expansion fact of any version, in the shapes of
 *  control version 11. */
export function groupExpandedChanges(fact: Extract<WorkflowSessionFact, { type: "group.expanded" }>): readonly ExpansionChange[] {
  return fact.version === 3 ? fact.payload.changes : fact.payload.changes.map(normalizeExpansionChangeV8);
}
