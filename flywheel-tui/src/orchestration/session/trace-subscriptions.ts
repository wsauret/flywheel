import type { EventBus, Unsubscribe } from "../../infra/event-bus.js";
import type { SpanKind } from "../../infra/trace-types.js";

export interface TraceSpanOps {
  startSpan(kind: SpanKind, name: string, input?: unknown): string;
  endSpan(spanId: string, output?: unknown, status?: "ok" | "error", error?: { message: string; code?: string }): void;
  workflowSpanId: string | null;
  setWorkflowSpanId(id: string): void;
  stepSpanIds: Map<string, string>;
  toolSpanIds: Map<string, string>;
  spanStack: string[];
  openSpans: Map<string, { kind: string }>;
}

function findOpenSpanByKind(ops: TraceSpanOps, kind: SpanKind): string | null {
  for (let i = ops.spanStack.length - 1; i >= 0; i--) {
    const spanId = ops.spanStack[i]!;
    const open = ops.openSpans.get(spanId);
    if (open && open.kind === kind) {
      return spanId;
    }
  }
  return null;
}

export function subscribeTraceEvents(bus: EventBus, ops: TraceSpanOps, workflowName: string): Unsubscribe[] {
  const unsubs: Unsubscribe[] = [];

  unsubs.push(
    bus.subscribeToType("queue:initialized", (event) => {
      const id = ops.startSpan("workflow", workflowName, {
        stepIds: event.stepIds,
        workflowName,
      });
      ops.setWorkflowSpanId(id);
    }),
  );

  unsubs.push(
    bus.subscribeToType("queue:completed", (event) => {
      if (ops.workflowSpanId) {
        ops.endSpan(ops.workflowSpanId, {
          stepsCompleted: event.stepsCompleted,
          failureReason: null,
        }, "ok");
      }
    }),
  );

  unsubs.push(
    bus.subscribeToType("queue:failed", (event) => {
      if (ops.workflowSpanId) {
        ops.endSpan(ops.workflowSpanId, {
          stepsCompleted: event.stepsCompleted,
          failureReason: event.reason,
        }, "error", { message: event.reason });
      }
    }),
  );

  unsubs.push(
    bus.subscribeToType("queue:step-started", (event) => {
      const savedStack = [...ops.spanStack];

      ops.spanStack.length = 0;
      if (ops.workflowSpanId && ops.openSpans.has(ops.workflowSpanId)) {
        ops.spanStack.push(ops.workflowSpanId);
      }

      const stepSpanId = ops.startSpan("step", event.stepTitle, {
        stepType: event.stepType,
        stepTitle: event.stepTitle,
      });
      ops.stepSpanIds.set(event.stepId, stepSpanId);

      ops.spanStack.length = 0;
      for (const id of savedStack) {
        if (ops.openSpans.has(id)) {
          ops.spanStack.push(id);
        }
      }
      ops.spanStack.push(stepSpanId);
    }),
  );

  unsubs.push(
    bus.subscribeToType("queue:step-completed", (event) => {
      const workerSpanId = findOpenSpanByKind(ops, "worker");
      if (workerSpanId) {
        ops.endSpan(workerSpanId, { resultSummary: "", failureReason: null }, "ok");
      }
      const stepSpanId = ops.stepSpanIds.get(event.stepId);
      if (stepSpanId) {
        ops.endSpan(stepSpanId, { failureReason: null }, "ok");
        ops.stepSpanIds.delete(event.stepId);
      }
    }),
  );

  unsubs.push(
    bus.subscribeToType("queue:step-failed", (event) => {
      const workerSpanId = findOpenSpanByKind(ops, "worker");
      if (workerSpanId) {
        ops.endSpan(workerSpanId, { resultSummary: "", failureReason: event.reason }, "error", { message: event.reason });
      }
      const stepSpanId = ops.stepSpanIds.get(event.stepId);
      if (stepSpanId) {
        ops.endSpan(stepSpanId, { failureReason: event.reason }, "error", { message: event.reason });
        ops.stepSpanIds.delete(event.stepId);
      }
    }),
  );

  unsubs.push(
    bus.subscribeToType("subprocess:spawned", (event) => {
      ops.startSpan("worker", `worker-${event.stepIndex}`, {
        stepIndex: event.stepIndex,
      });
    }),
  );

  unsubs.push(
    bus.subscribeToType("trace:tool-started", (event) => {
      const spanId = ops.startSpan("tool_call", event.toolName, {
        toolName: event.toolName,
        toolInput: event.toolInput,
      });
      ops.toolSpanIds.set(event.toolUseId, spanId);
    }),
  );

  unsubs.push(
    bus.subscribeToType("trace:tool-completed", (event) => {
      const spanId = ops.toolSpanIds.get(event.toolUseId);
      if (spanId) {
        ops.endSpan(spanId, {
          toolOutput: event.toolOutput,
          isError: event.isError,
        }, event.isError ? "error" : "ok", event.isError ? { message: "tool returned error" } : undefined);
        ops.toolSpanIds.delete(event.toolUseId);
      }
    }),
  );

  unsubs.push(
    bus.subscribeToType("trace:subagent-started", (event) => {
      const spanId = ops.startSpan("subagent", event.agentType, {
        agentType: event.agentType,
        description: event.description,
        prompt: event.prompt,
        model: "",
      });
      ops.toolSpanIds.set(event.toolUseId, spanId);
    }),
  );

  unsubs.push(
    bus.subscribeToType("trace:subagent-completed", (event) => {
      const spanId = ops.toolSpanIds.get(event.toolUseId);
      if (spanId) {
        ops.endSpan(spanId, {
          result: event.result,
          exitStatus: event.isError ? 1 : 0,
          error: event.isError ? "subagent returned error" : null,
        }, event.isError ? "error" : "ok", event.isError ? { message: "subagent returned error" } : undefined);
        ops.toolSpanIds.delete(event.toolUseId);
      }
    }),
  );

  return unsubs;
}
