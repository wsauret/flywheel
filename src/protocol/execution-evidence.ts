import { Schema } from "effect";
import { migrateUncoveredUsageEntry, UncoveredUsageEntrySchema, UsageEntrySchema } from "../infra/llm/usage-entry.js";
import { AccessProviderCandidateSchema } from "./auth-status-protocol-schemas.js";

const RequestEvidenceSchema = Schema.Struct({
  requestId: Schema.NonEmptyString,
  identity: Schema.Struct({
    providerSessionKey: Schema.NonEmptyString,
    conversationId: Schema.optionalKey(Schema.NonEmptyString),
  }),
  turn: Schema.Number,
  attemptId: Schema.optional(Schema.String),
  /** The workflow attempt whose agent sent the request, when its usage
   *  recorded one. `attemptId` names the provider attempt. */
  workflowAttemptId: Schema.optional(Schema.String),
  preparedAt: Schema.optional(Schema.Number),
  dispatchedAt: Schema.optional(Schema.Number),
  respondedAt: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
  dispatchState: Schema.Literals(["prepared", "dispatched", "unknown"]),
  completionState: Schema.Literals(["unknown", "terminal"]),
  purpose: Schema.Literals(["normal", "compaction"]),
  model: Schema.optional(Schema.String),
  accessProvider: Schema.optional(Schema.String),
  accessProviderCandidate: Schema.optional(AccessProviderCandidateSchema),
  reasoningEffort: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.Literals(["ok", "aborted", "context_overflow", "output_overflow", "stream_error", "fatal_error"])),
  errorTag: Schema.optional(Schema.String),
  measurement: Schema.Literals(["available", "unavailable"]),
});

const ExecutionEvidenceFields = {
  projectRoot: Schema.String,
  rootSessionId: Schema.NonEmptyString,
  descendantDiscovery: Schema.Literals(["current-metadata", "incomplete"]),
  metadataGaps: Schema.Array(Schema.Struct({
    sessionId: Schema.NonEmptyString,
    kind: Schema.Literals(["corrupt", "missing"]),
    scope: Schema.Literals(["workspace", "descendant"]),
  })),
  accounting: Schema.Struct({
    usage: Schema.Literals(["available", "unavailable"]),
    price: Schema.Literal("estimate"),
    providerInvoicedCost: Schema.Literal("unavailable"),
  }),
} as const;

const evidenceSession = <Entry extends Schema.Top>(entry: Entry) => Schema.Struct({
  sessionId: Schema.NonEmptyString,
  kind: Schema.Literals(["chat", "workflow", "workflow-agent", "subagent"]),
  parentSessionId: Schema.optional(Schema.NonEmptyString),
  requests: Schema.Array(RequestEvidenceSchema),
  usageEntries: Schema.Array(entry),
});

/** Public JSON v2 contains canonical usage and safe request identities, not request bodies or provider invoices.
 * Version 2 entries state their coverage, and a served request without a usage report is an unmeasured entry.
 * Usage with no measured entry is unavailable. Metadata gaps can hide descendants. Unknown versions are refused. */
export const ExecutionEvidenceSchema = Schema.Struct({
  version: Schema.Literal(2),
  ...ExecutionEvidenceFields,
  sessions: Schema.Array(evidenceSession(UsageEntrySchema)),
});

export type ExecutionEvidence = typeof ExecutionEvidenceSchema.Type;

// Remove after 2027-04-30. Version 1 evidence, which benchmark result directories keep, predates coverage: each of
// its entries held the provider's final report.
const ExecutionEvidenceV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  ...ExecutionEvidenceFields,
  sessions: Schema.Array(evidenceSession(UncoveredUsageEntrySchema)),
});

/** Decodes stored or emitted evidence JSON, converting version 1 to the current shape. Throws on any other shape. */
export function decodeExecutionEvidence(value: unknown): ExecutionEvidence {
  const decoded = Schema.decodeUnknownSync(Schema.Union([ExecutionEvidenceSchema, ExecutionEvidenceV1Schema]), { onExcessProperty: "error" })(value);
  if (decoded.version === 2) return decoded;
  return {
    ...decoded,
    version: 2,
    sessions: decoded.sessions.map((session) => ({ ...session, usageEntries: session.usageEntries.map(migrateUncoveredUsageEntry) })),
  };
}
