export type SpanKind = "workflow" | "step" | "worker" | "subagent" | "tool_call";
export type SpanStatus = "ok" | "error";

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

interface SpanBase {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  sessionId: string;
  startTimeMs: number;
  endTimeMs?: number;
  durationMs?: number;
  status: SpanStatus;
  error: { message: string; code?: string } | null;
}

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

