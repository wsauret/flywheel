/**
 * Trace span types and Zod schemas for structured trace collection.
 *
 * Spans form a tree representing workflow execution. Each span has a `kind`
 * discriminator that determines the shape of `input` and `output`.
 *
 * Conventions:
 * - SpanKind is a string union (not enum), matching events.ts pattern
 * - Timestamps are epoch milliseconds (number)
 * - IDs use randomUUID from node:crypto
 * - Input/output fields are 4KB byte-capped via truncateField()
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// SpanKind — string union
// ---------------------------------------------------------------------------

export type SpanKind = "workflow" | "step" | "worker" | "subagent" | "tool_call";

// ---------------------------------------------------------------------------
// Per-kind input/output types
// ---------------------------------------------------------------------------

interface WorkflowSpanInput {
  stepIds: string[];
  workflowName: string;
}

interface WorkflowSpanOutput {
  stepsCompleted: number;
  failureReason: string | null;
}

interface StepSpanInput {
  stepType: string;
  stepTitle: string;
}

interface StepSpanOutput {
  failureReason: string | null;
}

interface WorkerSpanInput {
  stepIndex: number;
}

interface WorkerSpanOutput {
  resultSummary: string;
  failureReason: string | null;
  /** Number of ndjson transcript events emitted during this worker's lifetime (delta, not total). */
  ndjsonEventCount?: number;
}

interface SubagentSpanInput {
  agentType: string;
  description: string;
  prompt: string;
  model: string;
}

interface SubagentSpanOutput {
  result: string;
  exitStatus: number;
  error: string | null;
}

interface ToolCallSpanInput {
  toolName: string;
  toolInput: string; // truncated JSON
}

interface ToolCallSpanOutput {
  toolOutput: string; // truncated
  isError: boolean;
}

// ---------------------------------------------------------------------------
// SpanBase — shared fields
// ---------------------------------------------------------------------------

interface SpanBase {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  sessionId: string;
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status: "ok" | "error";
  error: { message: string; code?: string } | null;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

interface WorkflowSpan extends SpanBase {
  kind: "workflow";
  input: WorkflowSpanInput;
  output: WorkflowSpanOutput;
}

interface StepSpan extends SpanBase {
  kind: "step";
  input: StepSpanInput;
  output: StepSpanOutput;
}

interface WorkerSpan extends SpanBase {
  kind: "worker";
  input: WorkerSpanInput;
  output: WorkerSpanOutput;
}

interface SubagentSpan extends SpanBase {
  kind: "subagent";
  input: SubagentSpanInput;
  output: SubagentSpanOutput;
}

interface ToolCallSpan extends SpanBase {
  kind: "tool_call";
  input: ToolCallSpanInput;
  output: ToolCallSpanOutput;
}

export type Span = WorkflowSpan | StepSpan | WorkerSpan | SubagentSpan | ToolCallSpan;

// ---------------------------------------------------------------------------
// Exhaustiveness check helper
// ---------------------------------------------------------------------------

/**
 * Use in switch default case to ensure all SpanKind values are handled.
 * TypeScript will error at compile time if a case is missing.
 */
function assertNeverSpanKind(kind: never): never {
  throw new Error(`Unhandled span kind: ${kind}`);
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const SpanBaseSchema = z.object({
  spanId: z.string(),
  traceId: z.string(),
  parentSpanId: z.string().nullable(),
  sessionId: z.string(),
  startTimeMs: z.number(),
  endTimeMs: z.number().optional(),
  durationMs: z.number().optional(),
  status: z.enum(["ok", "error"]),
  error: z
    .object({ message: z.string(), code: z.string().optional() })
    .nullable(),
});

const WorkflowSpanSchema = SpanBaseSchema.extend({
  kind: z.literal("workflow"),
  input: z.object({
    stepIds: z.array(z.string()),
    workflowName: z.string(),
  }),
  output: z.object({
    stepsCompleted: z.number(),
    failureReason: z.string().nullable(),
  }),
});

const StepSpanSchema = SpanBaseSchema.extend({
  kind: z.literal("step"),
  input: z.object({
    stepType: z.string(),
    stepTitle: z.string(),
  }),
  output: z.object({
    failureReason: z.string().nullable(),
  }),
});

const WorkerSpanSchema = SpanBaseSchema.extend({
  kind: z.literal("worker"),
  input: z.object({
    stepIndex: z.number(),
  }),
  output: z.object({
    resultSummary: z.string(),
    failureReason: z.string().nullable(),
    ndjsonEventCount: z.number().optional(),
  }),
});

const SubagentSpanSchema = SpanBaseSchema.extend({
  kind: z.literal("subagent"),
  input: z.object({
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    model: z.string(),
  }),
  output: z.object({
    result: z.string(),
    exitStatus: z.number(),
    error: z.string().nullable(),
  }),
});

const ToolCallSpanSchema = SpanBaseSchema.extend({
  kind: z.literal("tool_call"),
  input: z.object({
    toolName: z.string(),
    toolInput: z.string(),
  }),
  output: z.object({
    toolOutput: z.string(),
    isError: z.boolean(),
  }),
});

export const SpanSchema = z.discriminatedUnion("kind", [
  WorkflowSpanSchema,
  StepSpanSchema,
  WorkerSpanSchema,
  SubagentSpanSchema,
  ToolCallSpanSchema,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a value to JSON and truncate to `maxBytes` bytes.
 * Handles multi-byte characters safely by encoding to a Buffer.
 */
export function truncateField(value: unknown, maxBytes: number = 4096): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    json = "null";
  }

  const buf = Buffer.from(json, "utf-8");
  if (buf.length <= maxBytes) return json;

  // Truncate at byte boundary, then decode — Buffer.toString handles partial
  // multi-byte sequences by stopping before an incomplete character.
  // We trim one extra byte at a time if we land mid-character.
  let end = maxBytes;
  while (end > 0) {
    const slice = buf.subarray(0, end);
    const decoded = slice.toString("utf-8");
    // Re-encode to check we didn't gain replacement characters
    if (!decoded.includes("\uFFFD")) {
      return decoded;
    }
    end--;
  }
  return "";
}

/**
 * Safely parse a single JSONL line into a Span.
 * Returns `null` for any malformed, truncated, or invalid line — never throws.
 */
export function parseSpanLine(line: string): Span | null {
  try {
    if (!line || !line.trim()) return null;
    const parsed = JSON.parse(line);
    const result = SpanSchema.safeParse(parsed);
    return result.success ? (result.data as Span) : null;
  } catch {
    return null;
  }
}
