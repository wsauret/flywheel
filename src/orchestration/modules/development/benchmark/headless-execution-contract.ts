import { Schema } from "effect";
import { ExecutionEvidenceSchema } from "../../../../protocol/execution-evidence.js";
import { RuntimeSessionModelPlanResultSchema } from "../../../../protocol/model-assignment-protocol-schemas.js";
import { BenchmarkAccountingSchema } from "./evidence.js";

const ArtifactSchema = Schema.Struct({
  path: Schema.String,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String,
});

/** Versioned benchmark execution evidence. A handoff is acceptance evidence, not grader proof.
 * Preflight submits no work. Missing usage and missing prices remain unavailable.
 * `incomplete` is the subject's own settlement without a handoff. */
export const HeadlessBenchmarkExecutionSchema = Schema.Struct({
  version: Schema.Literal(1),
  outcome: Schema.Literals(["preflight", "complete", "input_required", "incomplete", "failed"]),
  exitCode: Schema.NullOr(Schema.Number),
  sessionId: Schema.optionalKey(Schema.String),
  workflowSessionId: Schema.optionalKey(Schema.String),
  models: Schema.optionalKey(Schema.Array(Schema.String)),
  handoff: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  wallMs: Schema.Number,
  plan: Schema.optionalKey(RuntimeSessionModelPlanResultSchema),
  workflowsMode: Schema.optionalKey(Schema.Literals(["on", "ask", "off"])),
  reason: Schema.optionalKey(Schema.String),
  evidence: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("observed"),
      value: ExecutionEvidenceSchema,
      requestCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      parentRequestCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      childSessionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
    Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.String }),
  ]),
  totalAccounting: BenchmarkAccountingSchema,
  parentAccounting: BenchmarkAccountingSchema,
  artifacts: Schema.Record(Schema.String, ArtifactSchema),
});

export type HeadlessBenchmarkExecution = typeof HeadlessBenchmarkExecutionSchema.Type;
