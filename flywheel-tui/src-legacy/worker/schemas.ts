import { z } from "zod";

/**
 * WorkerFailureReasonSchema — discriminated union of failure kinds.
 */
export const WorkerFailureReasonSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("timeout"),
    timeoutMs: z.number(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("exit_code"),
    exitCode: z.number(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("schema_error"),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("api_error"),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("rate_limited"),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("transient"),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("interrupted"),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("handoff_missing"),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("handoff_invalid"),
    message: z.string(),
  }),
]);

export type WorkerFailureReason = z.infer<typeof WorkerFailureReasonSchema>;

/**
 * WorkerResultSchema — includes `truncated: boolean` field.
 */
export const WorkerResultSchema = z.object({
  output: z.string(),
  rawOutput: z.string().optional(),
  rawStderr: z.string().optional(),
  exitCode: z.number(),
  truncated: z.boolean(),
  durationMs: z.number(),
  failure: WorkerFailureReasonSchema.optional(),
  sessionId: z.string().optional(),
  handoffPath: z.string(),
});

export type WorkerResult = z.infer<typeof WorkerResultSchema>;
