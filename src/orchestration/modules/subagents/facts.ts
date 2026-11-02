import { Schema, SchemaTransformation } from "effect"
import { defineFact } from "../../../infra/event-registry.js"
import { canonicalModuleIds, ModuleIdSchema, type ModuleId } from "../../../protocol/module-ids.js"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))

const ChildRunCreatedV1Schema = defineFact({
  type: "child_run.created",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childRunId: Schema.String,
    kind: Schema.Literal("subagent"),
    toolUseId: Schema.optionalKey(Schema.String),
    modelRequestId: Schema.optionalKey(Schema.String),
    // Optional for historical rows: runs written before the stamp existed
    // resolve through the recovery caller's fallback conversation or are
    // skipped like any unmapped run.
    conversationId: Schema.optionalKey(Schema.String),
    agentType: Schema.String,
    description: Schema.String,
    model: Schema.String,
    // Decode-compatibility only: the retired pinning feature wrote this field.
    provider: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.String),
    fork: Schema.optionalKey(Schema.Literal(true)),
    maxTurns: PositiveInt,
    tools: Schema.Array(Schema.String),
    /** Optional only for historical version-1 rows. Current writers require it. */
    executionCwd: Schema.optionalKey(Schema.String),
  }),
})

/** Each retired module id that a child run recorded, and the module that replaced it. */
const RETIRED_MODULE_IDS = [
  // The Agent SDK provider replaced this module. Remove after 2027-04-09.
  ["provider-claude-subscription", "provider-claude-agent-sdk"],
  ["adhoc-workflows", "workflows"], // Workflows absorbed this retired module. Remove after 2027-04-30.
] as const
const CURRENT_MODULE_IDS: ReadonlyMap<string, ModuleId> = new Map(RETIRED_MODULE_IDS)

/** A module id list as a child run recorded it. Writers record each list in
 *  vocabulary order, so a list that names a retired id reads with its
 *  replacement in vocabulary order, each id once. */
const RecordedModuleIdsSchema = Schema.Array(Schema.Union([ModuleIdSchema, Schema.Literals(RETIRED_MODULE_IDS.map(([retired]) => retired))])).pipe(Schema.decodeTo(
  Schema.Array(ModuleIdSchema),
  SchemaTransformation.transform({
    decode: (ids) => canonicalModuleIds(ids.map((id) => CURRENT_MODULE_IDS.get(id) ?? id)),
    encode: (ids) => ids,
  }),
))

const CapabilityGrantSchema = Schema.Struct({
  operation: Schema.String,
  required: RecordedModuleIdsSchema,
  capabilities: RecordedModuleIdsSchema,
  moduleIds: RecordedModuleIdsSchema,
  requireWorkflowConfirmation: Schema.Boolean,
  workflowsMode: Schema.Literals(["off", "ask", "on"]),
  identity: Schema.String,
})

const ChildRunCreatedV2Schema = defineFact({
  type: "child_run.created",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childSessionId: Schema.String,
    childRunId: Schema.String,
    conversationId: Schema.String,
    parentSessionId: Schema.String,
    parentConversationId: Schema.String,
    parentToolCallId: Schema.String,
    modelRequestId: Schema.optionalKey(Schema.String),
    persona: Schema.Struct({
      name: Schema.String,
      kind: Schema.Union([Schema.Literal("general"), Schema.Literal("persona")]),
    }),
    capabilityGrant: CapabilityGrantSchema,
    admittedModuleIds: RecordedModuleIdsSchema,
    skillsRevision: NonNegativeInt,
    model: Schema.String,
    effort: Schema.optionalKey(Schema.String),
    tools: Schema.Array(Schema.String),
    executionCwd: Schema.String,
    budget: Schema.Struct({
      maxTurns: PositiveInt,
      maxTokens: NonNegativeInt,
    }),
    parentDepth: NonNegativeInt,
    description: Schema.String,
    fork: Schema.optionalKey(Schema.Literal(true)),
  }),
})

/** Version 2 records remain readable without changing their dispatch evidence.
 * Remove the historical version-2 reader after 2027-10-17. */
const ChildRunCreatedV3Schema = defineFact({
  type: "child_run.created",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    ...ChildRunCreatedV2Schema.fields.payload.fields,
    model: Schema.optionalKey(Schema.String),
  }),
})

// The launch inputs of one subagent dispatch. `task` is the
// composed persona/parent instruction text handed to the child runner, NOT the
// system prompt the provider received: the runtime assembles that per request
// (core prompt, project instructions, tool guidance, environment, provider
// notes) and records it in the `prompt.assembled` audit fact.
// Version 3 states the `task` key. Version 2 was written under two names for
// that field (`taskInstructions`, then `task`), so a version-2 row is
// ambiguous and the migration in ./migrations/subagent-prompt.ts adopts every
// earlier version into this one before a strict reader opens the store.
const SubagentPromptedSchema = defineFact({
  type: "subagent.prompted",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childRunId: Schema.String,
    prompt: Schema.String,
    task: Schema.String,
    toolNames: Schema.Array(Schema.String),
  }),
})

const SubagentCompletedSchema = defineFact({
  type: "subagent.completed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childRunId: Schema.String,
    status: Schema.Union([Schema.Literal("completed"), Schema.Literal("failed"), Schema.Literal("cancelled")]),
    isError: Schema.Boolean,
    durationMs: NonNegativeNumber,
    totalTokens: Schema.optionalKey(NonNegativeInt),
    inputTokens: Schema.optionalKey(NonNegativeInt),
    outputTokens: Schema.optionalKey(NonNegativeInt),
    cacheReadInputTokens: Schema.optionalKey(NonNegativeInt),
    cacheCreationInputTokens: Schema.optionalKey(NonNegativeInt),
    reasoningTokens: Schema.optionalKey(NonNegativeInt),
    totalCostUsd: Schema.optionalKey(NonNegativeNumber),
    toolUses: Schema.optionalKey(NonNegativeInt),
    resultBytes: NonNegativeInt,
    resultSha256: Schema.String,
    resultPreview: Schema.String,
  }),
})

const SubagentCompletedV2Schema = defineFact({
  type: "subagent.completed",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childRunId: Schema.String,
    status: Schema.Union([Schema.Literal("completed"), Schema.Literal("failed"), Schema.Literal("cancelled")]),
    isError: Schema.Boolean,
    durationMs: NonNegativeNumber,
    totalTokens: Schema.optionalKey(NonNegativeInt),
    inputTokens: Schema.optionalKey(NonNegativeInt),
    outputTokens: Schema.optionalKey(NonNegativeInt),
    cacheReadInputTokens: Schema.optionalKey(NonNegativeInt),
    cacheCreationInputTokens: Schema.optionalKey(NonNegativeInt),
    reasoningTokens: Schema.optionalKey(NonNegativeInt),
    totalCostUsd: Schema.optionalKey(NonNegativeNumber),
    toolUses: Schema.optionalKey(NonNegativeInt),
    result: Schema.String,
    resultBytes: NonNegativeInt,
    resultSha256: Schema.String,
    resultPreview: Schema.String,
  }),
})

const SubagentCompletedV3Schema = defineFact({
  type: "subagent.completed",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childRunId: Schema.String,
    status: Schema.Union([Schema.Literal("completed"), Schema.Literal("failed"), Schema.Literal("cancelled")]),
    isError: Schema.Boolean,
    modelFailure: Schema.optionalKey(Schema.Literal(true)),
    durationMs: NonNegativeNumber,
    totalTokens: Schema.optionalKey(NonNegativeInt),
    inputTokens: Schema.optionalKey(NonNegativeInt),
    outputTokens: Schema.optionalKey(NonNegativeInt),
    cacheReadInputTokens: Schema.optionalKey(NonNegativeInt),
    cacheCreationInputTokens: Schema.optionalKey(NonNegativeInt),
    reasoningTokens: Schema.optionalKey(NonNegativeInt),
    totalCostUsd: Schema.optionalKey(NonNegativeNumber),
    toolUses: Schema.optionalKey(NonNegativeInt),
    result: Schema.String,
    resultBytes: NonNegativeInt,
    resultSha256: Schema.String,
    resultPreview: Schema.String,
  }),
})

/** Version 4 adds `partial`: the child stopped at its turn budget with a
 *  handoff or text in hand. Earlier versions stay registered as readers; a
 *  v3 fact is a valid v4 payload, so no rewrite is needed. The v3 reader and
 *  its old-shape test may be retired after 2027-03-21. */
const SubagentCompletedV4Schema = defineFact({
  type: "subagent.completed",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childRunId: Schema.String,
    status: Schema.Union([Schema.Literal("completed"), Schema.Literal("partial"), Schema.Literal("failed"), Schema.Literal("cancelled")]),
    isError: Schema.Boolean,
    modelFailure: Schema.optionalKey(Schema.Literal(true)),
    durationMs: NonNegativeNumber,
    totalTokens: Schema.optionalKey(NonNegativeInt),
    inputTokens: Schema.optionalKey(NonNegativeInt),
    outputTokens: Schema.optionalKey(NonNegativeInt),
    cacheReadInputTokens: Schema.optionalKey(NonNegativeInt),
    cacheCreationInputTokens: Schema.optionalKey(NonNegativeInt),
    reasoningTokens: Schema.optionalKey(NonNegativeInt),
    totalCostUsd: Schema.optionalKey(NonNegativeNumber),
    toolUses: Schema.optionalKey(NonNegativeInt),
    result: Schema.String,
    resultBytes: NonNegativeInt,
    resultSha256: Schema.String,
    resultPreview: Schema.String,
  }),
})

/** Version 5 adds `stopped`: a person ended the run with Stop, distinct from
 *  the requesting agent's own `cancelled`. A v4 fact is a valid v5 payload,
 *  so the v4 reader converts by reading it as is. The v4 reader and its
 *  old-shape test may be retired after 2027-03-22. */
const SubagentCompletedV5Schema = defineFact({
  type: "subagent.completed",
  version: 5,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childRunId: Schema.String,
    status: Schema.Union([Schema.Literal("completed"), Schema.Literal("partial"), Schema.Literal("failed"), Schema.Literal("cancelled"), Schema.Literal("stopped")]),
    isError: Schema.Boolean,
    modelFailure: Schema.optionalKey(Schema.Literal(true)),
    durationMs: NonNegativeNumber,
    totalTokens: Schema.optionalKey(NonNegativeInt),
    inputTokens: Schema.optionalKey(NonNegativeInt),
    outputTokens: Schema.optionalKey(NonNegativeInt),
    cacheReadInputTokens: Schema.optionalKey(NonNegativeInt),
    cacheCreationInputTokens: Schema.optionalKey(NonNegativeInt),
    reasoningTokens: Schema.optionalKey(NonNegativeInt),
    totalCostUsd: Schema.optionalKey(NonNegativeNumber),
    toolUses: Schema.optionalKey(NonNegativeInt),
    result: Schema.String,
    resultBytes: NonNegativeInt,
    resultSha256: Schema.String,
    resultPreview: Schema.String,
  }),
})

const SubagentInterruptedSchema = defineFact({
  type: "subagent.interrupted",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childRunId: Schema.String,
    reason: Schema.Literal("runtime_restarted"),
    recoveryId: Schema.String,
  }),
})

/** The run stopped at a save point on purpose and keeps its binding: a person
 *  paused it from its card, or the runtime paused it at a planned shutdown.
 *  `subagent.resumed` continues it; recovery never touches it. */
const SubagentPausedSchema = defineFact({
  type: "subagent.paused",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childRunId: Schema.String,
    pausedBy: Schema.Literals(["person", "runtime"]),
  }),
})

const SubagentResumedSchema = defineFact({
  type: "subagent.resumed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    childRunId: Schema.String,
    authorizationId: Schema.String,
    continuation: PositiveInt,
  }),
})

const ChildRunOwnershipRecoveredSchema = defineFact({
  type: "child_run.ownership.recovered", version: 1, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ childRunId: Schema.NonEmptyString, parentSessionId: Schema.NonEmptyString, parentConversationId: Schema.NonEmptyString }),
})

export const SubagentRunFactSchemas = [
  ChildRunOwnershipRecoveredSchema,
  ChildRunCreatedV1Schema,
  ChildRunCreatedV2Schema,
  ChildRunCreatedV3Schema,
  SubagentPromptedSchema,
  SubagentCompletedSchema,
  SubagentCompletedV2Schema,
  SubagentCompletedV3Schema,
  SubagentCompletedV4Schema,
  SubagentCompletedV5Schema,
  SubagentInterruptedSchema,
  SubagentPausedSchema,
  SubagentResumedSchema,
] as const

const SubagentRunFactSchema = Schema.Union(SubagentRunFactSchemas)

export type SubagentRunFact = typeof SubagentRunFactSchema.Type

export function parseSubagentRunFact(value: unknown): SubagentRunFact {
  return Schema.decodeUnknownSync(SubagentRunFactSchema, { onExcessProperty: "error" })(value)
}
