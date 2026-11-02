import type { AssistantEventData, RateLimitEventData, RuntimeEvent } from "../runtime-event-types.js";
import { extractToolResultRecords } from "../runtime-tool-records.js";
import { redactSecrets } from "../redact-secrets.js";
import { AssistantDraftProjector } from "./assistant-draft-projector.js";
import type { OutputProjector } from "./output-projector.js";
import { extractDisplayMeta } from "./structured-event-tool-results.js";

interface RuntimeEventFields {
  [key: string]: unknown;
}

type RuntimeEventType = RuntimeEvent["type"];
type RuntimeEventHandler<T extends RuntimeEventType> = (event: Extract<RuntimeEvent, { type: T }>, now: number) => void;
export type RuntimeEventProjectorDecisions<T extends RuntimeEventType = RuntimeEventType> = {
  [K in T]: RuntimeEventHandler<K> | null;
};

// Every RuntimeEvent payload carries an `[x: string]: unknown` rest index
// (StructWithRest over UnknownRecordSchema, or a bare Record), so the union is
// uniformly indexable as a Record without per-variant narrowing.
function extractStringField(data: RuntimeEventFields, key: string): string | undefined {
  const v = data[key];
  return typeof v === "string" ? v : undefined;
}

export class RuntimeEventProjector {
  private readonly assistantDraft: AssistantDraftProjector;
  private readonly handlers: RuntimeEventProjectorDecisions;

  constructor(private readonly projector: OutputProjector) {
    this.assistantDraft = new AssistantDraftProjector(projector);
    this.handlers = {
      "model.assistant_message.recorded": (event, now) => this.handleAssistant(event.data, this.parentToolUseId(event), now),
      "tool.result.recorded": (event, now) => this.handleToolResults(event, this.parentToolUseId(event), "render", now),
      "tool.result.available": (event, now) => this.handleToolResults(event, undefined, "availability", now),
      "tool.result.acknowledged": (event) => this.projector.apply({ type: "tool-result-ack", toolUseId: event.data.tool_use_id, ...this.parentToolUseIdFields(event) }),
      "tool.validation.failed": null,
      // A response's terminal event follows its settlement, so a response that
      // recorded no assistant message ends here.
      "model.turn.completed": (event, now) => { if (!this.parentToolUseId(event)) this.assistantDraft.endResponse(now); },
      "model.context.measured": null,
      "model.usage.measured": null,
      "budget.stream.completed": null,
      // Presentation family "provider.rate_limit_warning": transcript channel.
      "agent.rate_limit.observed": (event, now) => this.projector.apply({ type: "push-system-message", message: formatRateLimitWarning(event.data), level: "info", timestamp: now }),
      "model.content.delta": (event, now) => { if (!this.parentToolUseId(event)) this.handleContentBlockDelta(event.data.delta, extractStringField(event.data, "block_key"), now); },
      "model.text.completed": (event, now) => { if (!this.parentToolUseId(event)) this.assistantDraft.completeText(extractStringField(event.data, "block_key"), now); },
      "model.text.reconciled": (event, now) => { if (!this.parentToolUseId(event)) this.assistantDraft.reconcileTerminalText(extractStringField(event.data, "block_key"), event.data.content, now, extractStringField(event.data, "provisional_block_key")); },
      "tool.input.delta": (event) => this.projector.apply({ type: "tool-input-delta", toolUseId: event.data.tool_use_id, partialJson: event.data.partial_json, ...this.parentToolUseIdFields(event) }),
      "tool.preview.check": (event) => this.projector.apply({ type: "tool-preview-check", toolUseId: event.data.tool_use_id, operation: event.data.operation }),
      "tool.execution_output.delta": (event) => this.projector.apply({ type: "tool-execution-output", toolUseId: event.data.tool_use_id, output: event.data.output, ...this.parentToolUseIdFields(event) }),
      "tool.execution_output.recorded": (event) => this.projector.apply({
        type: "tool-execution-output-recorded",
        toolUseId: event.data.tool_use_id,
        output: event.data.output,
        ...extractDisplayMeta({ mutationEvidence: event.data.mutationEvidence }, { source: event.type, toolUseId: event.data.tool_use_id }),
        ...this.parentToolUseIdFields(event),
      }),
      "tool.input.completed": (event, now) => {
        const key = extractStringField(event.data, "block_key");
        this.assistantDraft.completeToolInput({ type: "tool-input-complete", toolUseId: event.data.tool_use.id, name: event.data.tool_use.name, input: event.data.tool_use.input, timestamp: now, ...(key ? { leadingTextId: `${key}:lead` } : {}), ...this.parentToolUseIdFields(event) }, key);
      },
      "model.user_message.recorded": (event, now) => this.handleToolResults(event, this.parentToolUseId(event), "conversation", now),
      // The background index reads the record; the transcript card shows the command itself.
      "tool.background_command.recorded": null,
      "agent.error.observed": null,
      "agent.compaction.started": null,
      "agent.compaction.progressed": null,
      "agent.compaction.completed": null,
      "agent.subagent_model.selected": (event) => this.handleSubagentModel(event.data),
      "agent.workflow_link.published": (event) => this.handleAgentLink(event.data),
      "agent.subagent.dispatched": (event, now) => {
        if (typeof event.data.tool_use_id === "string") this.projector.apply({ type: "agent-dispatched", toolUseId: event.data.tool_use_id, timestamp: now });
        this.handleAgentLink(event.data);
      },
      "agent.subagent.queued": (event, now) => {
        if (typeof event.data.tool_use_id === "string") this.projector.apply({ type: "agent-queued", toolUseId: event.data.tool_use_id, timestamp: now });
        this.handleAgentLink(event.data);
      },
      "agent.subagent.paused": (event, now) => {
        const pausedBy = event.data.paused_by;
        if (typeof event.data.tool_use_id !== "string" || (pausedBy !== "person" && pausedBy !== "agent" && pausedBy !== "runtime")) return;
        this.projector.apply({ type: "agent-paused", toolUseId: event.data.tool_use_id, timestamp: now, pausedBy });
      },
      "agent.waiting_on_subagents.recorded": null,
      "agent.provider_response.started": (event, now) => {
        if (this.parentToolUseId(event)) return;
        this.assistantDraft.endResponse(now);
        this.projector.apply({ type: "set-model-phase", phase: "waiting", timestamp: now });
      },
      "model.stream.retried": (event, now) => {
        if (!this.parentToolUseId(event)) this.assistantDraft.endResponse(now);
        this.projector.apply({ type: "abandon-tool-inputs", reason: "retry", ...this.parentToolUseIdFields(event) });
      },
      "model.stream.abandoned": (event, now) => {
        if (!this.parentToolUseId(event)) this.assistantDraft.endResponse(now);
        this.projector.apply({
          type: "abandon-tool-inputs", reason: event.data.reason, ...this.parentToolUseIdFields(event),
        });
      },
      "workflow.step.started": (event, now) => { if (typeof event.data.label === "string") this.projector.apply({ type: "push-divider", label: event.data.label, timestamp: now }); },
    };
  }

  reset(): void {
    this.projector.resetTracking();
    this.assistantDraft.reset();
  }

  dispatch(event: RuntimeEvent, now = Date.now()): void {
    const handler = this.handlers[event.type];
    if (!handler) return;
    // SAFETY: The event discriminant selects its matching handler, but TypeScript does not retain that correlation.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: keyed discriminated-union correlation
    handler(event as never, now);
  }

  private parentToolUseId(event: RuntimeEvent): string | undefined {
    return extractStringField(event.data, "parent_tool_use_id");
  }

  private parentToolUseIdFields(event: RuntimeEvent): { parentToolUseId?: string } {
    const parentToolUseId = this.parentToolUseId(event);
    return parentToolUseId ? { parentToolUseId } : {};
  }

  private handleSubagentModel(data: RuntimeEventFields): void {
    if (typeof data.tool_use_id === "string" && typeof data.model === "string") {
      this.projector.apply({ type: "set-subagent-model", toolUseId: data.tool_use_id, model: data.model });
    }
  }

  private handleAgentLink(data: RuntimeEventFields): void {
    if (typeof data.tool_use_id === "string" && typeof data.link_uri === "string") {
      this.projector.apply({ type: "set-agent-link", toolUseId: data.tool_use_id, linkUri: data.link_uri });
    }
  }

  private handleContentBlockDelta(delta: RuntimeEventFields | undefined, blockKey: string | undefined, now: number): void {
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      const estimatedTokens = typeof delta.estimated_tokens === "number" ? delta.estimated_tokens : undefined;
      if (delta.presentation === "progress") this.assistantDraft.streamText(blockKey, redactSecrets(delta.thinking), now);
      else this.assistantDraft.streamThinking(blockKey, delta.thinking, now, estimatedTokens);
    } else if (delta?.type === "thinking_complete" && typeof delta.thinking === "string") {
      this.assistantDraft.finalizeThinking(blockKey, delta.thinking, now, extractStringField(delta, "provisional_block_key"));
    } else if (delta?.type === "text_delta" && typeof delta.text === "string") {
      this.assistantDraft.streamText(blockKey, delta.text, now);
    }
  }

  private handleToolResults(event: RuntimeEvent, parentToolUseId: string | undefined, source: "render" | "conversation" | "availability", now: number): void {
    for (const result of extractToolResultRecords(event)) {
      this.projector.apply({
        type: "tool-result",
        toolUseId: result.toolUseId,
        outcome: result.outcome,
        content: result.toolOutput,
        timestamp: now,
        source,
        ...(result.details != null ? { details: result.details } : {}),
        ...(result.executionOutputTail !== undefined ? { executionOutputTail: result.executionOutputTail } : {}),
        ...(parentToolUseId ? { parentToolUseId } : {}),
      });
    }
  }

  private handleAssistant(data: AssistantEventData, parentToolUseId: string | undefined, now: number): void {
    const message = data.message;
    const content = message?.content;
    if (!Array.isArray(content)) return;

    // A recorded entry settles; an entry-less message is the live preview
    // that tool_input_start publishes, or the observed calls of an attempt
    // that failed without a turn result; both carry only tool calls.
    const entryId = extractStringField(data, "entry_id");
    if (entryId === undefined) this.assistantDraft.previewToolUse(content, parentToolUseId, now);
    else this.assistantDraft.settle(content, parentToolUseId, now, entryId);
  }

}

function formatRateLimitWarning(data: RateLimitEventData): string {
  const info = data.rate_limit_info;
  const pieces = ["Provider rate limit warning"];
  if (info?.rateLimitType) pieces.push(info.rateLimitType);
  if (typeof info?.utilization === "number") pieces.push(`${Math.round(info.utilization * 100)}% used`);
  if (typeof info?.surpassedThreshold === "number") pieces.push(`warning threshold ${Math.round(info.surpassedThreshold * 100)}%`);
  if (typeof info?.resetsAt === "number") pieces.push(`resets ${new Date(info.resetsAt * 1000).toISOString()}`);
  if (info?.isUsingOverage) pieces.push("using overage");
  if (info?.status) pieces.push(`status ${info.status}`);
  return pieces.join(" · ");
}
