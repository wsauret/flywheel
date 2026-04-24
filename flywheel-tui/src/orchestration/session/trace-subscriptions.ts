import type { EventBus, Unsubscribe } from "../../infra/event-bus.js";
import type { SpanKind, SpanStatus } from "../../infra/trace-types.js";

interface TraceSpanOps {
  startSpan(kind: SpanKind, name: string, input?: unknown): string;
  endSpan(spanId: string, output?: unknown, status?: SpanStatus, error?: { message: string; code?: string }): void;
  findOpenSpanByKind(kind: SpanKind): string | null;
  /** Reset the span stack to only contain the workflow span, then push a new step span. */
  resetStackForStep(workflowSpanId: string | null): void;
  workflowSpanId: string | null;
  setWorkflowSpanId(id: string): void;
  getStepSpanId(stepId: string): string | undefined;
  setStepSpanId(stepId: string, spanId: string): void;
  deleteStepSpanId(stepId: string): void;
  getToolSpanId(toolUseId: string): string | undefined;
  setToolSpanId(toolUseId: string, spanId: string): void;
  deleteToolSpanId(toolUseId: string): void;
}

export function subscribeTraceEvents(bus: EventBus, ops: TraceSpanOps, workflowName: string): Unsubscribe[] {
  return [
    bus.subscribeToType("queue:initialized", (event) => {
      const id = ops.startSpan("workflow", workflowName, {
        stepIds: event.stepIds,
        workflowName,
      });
      ops.setWorkflowSpanId(id);
    }),

    bus.subscribeToType("queue:completed", (event) => {
      if (ops.workflowSpanId) {
        ops.endSpan(ops.workflowSpanId, {
          stepsCompleted: event.stepsCompleted,
          failureReason: null,
        }, "ok");
      }
    }),

    bus.subscribeToType("queue:failed", (event) => {
      if (ops.workflowSpanId) {
        ops.endSpan(ops.workflowSpanId, {
          stepsCompleted: event.stepsCompleted,
          failureReason: event.reason,
        }, "error", { message: event.reason });
      }
    }),

    bus.subscribeToType("queue:step-started", (event) => {
      ops.resetStackForStep(ops.workflowSpanId);
      const stepSpanId = ops.startSpan("step", event.stepTitle, {
        stepType: event.stepType,
        stepTitle: event.stepTitle,
      });
      ops.setStepSpanId(event.stepId, stepSpanId);
    }),

    bus.subscribeToType("queue:step-completed", (event) => {
      const workerSpanId = ops.findOpenSpanByKind("worker");
      if (workerSpanId) {
        ops.endSpan(workerSpanId, { resultSummary: "", failureReason: null }, "ok");
      }
      const stepSpanId = ops.getStepSpanId(event.stepId);
      if (stepSpanId) {
        ops.endSpan(stepSpanId, { failureReason: null }, "ok");
        ops.deleteStepSpanId(event.stepId);
      }
    }),

    bus.subscribeToType("queue:step-failed", (event) => {
      const workerSpanId = ops.findOpenSpanByKind("worker");
      if (workerSpanId) {
        ops.endSpan(workerSpanId, { resultSummary: "", failureReason: event.reason }, "error", { message: event.reason });
      }
      const stepSpanId = ops.getStepSpanId(event.stepId);
      if (stepSpanId) {
        ops.endSpan(stepSpanId, { failureReason: event.reason }, "error", { message: event.reason });
        ops.deleteStepSpanId(event.stepId);
      }
    }),

    bus.subscribeToType("engine:started", (event) => {
      ops.startSpan("worker", `worker-${event.stepIndex}`, {
        stepIndex: event.stepIndex,
      });
    }),

    bus.subscribeToType("trace:tool-started", (event) => {
      const spanId = ops.startSpan("tool_call", event.toolName, {
        toolName: event.toolName,
        toolInput: event.toolInput,
      });
      ops.setToolSpanId(event.toolUseId, spanId);
    }),

    bus.subscribeToType("trace:tool-completed", (event) => {
      const spanId = ops.getToolSpanId(event.toolUseId);
      if (spanId) {
        ops.endSpan(spanId, {
          toolOutput: event.toolOutput,
          isError: event.isError,
        }, event.isError ? "error" : "ok", event.isError ? { message: "tool returned error" } : undefined);
        ops.deleteToolSpanId(event.toolUseId);
      }
    }),

    bus.subscribeToType("trace:subagent-started", (event) => {
      const spanId = ops.startSpan("subagent", event.agentType, {
        agentType: event.agentType,
        description: event.description,
        prompt: event.prompt,
        model: event.model,
      });
      ops.setToolSpanId(event.toolUseId, spanId);
    }),

    bus.subscribeToType("trace:subagent-completed", (event) => {
      const spanId = ops.getToolSpanId(event.toolUseId);
      if (spanId) {
        ops.endSpan(spanId, {
          result: event.result,
          exitStatus: event.isError ? 1 : 0,
          error: event.isError ? "subagent returned error" : null,
        }, event.isError ? "error" : "ok", event.isError ? { message: "subagent returned error" } : undefined);
        ops.deleteToolSpanId(event.toolUseId);
      }
    }),
  ];
}
