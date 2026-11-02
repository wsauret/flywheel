import { Log } from "../log.js";
import type { AnyBlock, StreamPhase, ToolStreamingText, UserMessageBlock } from "../output-blocks.js";
import type { OutputChangeBatch } from "./output-block-delta.js";
import type { OutputProjectionEvent, SettledAssistantContent } from "./output-projection-events.js";
import { OutputToolProjector } from "./output-tool-projector.js";
import { StructuredOutputBuilder } from "./structured-output-builder.js";
import { assertNever } from "../assert-never.js";
import { interruptedLabel } from "./run-labels.js";

const log = Log.create({ service: "output-projector" });

interface StreamingToolTextEntries {
  readonly [toolUseId: string]: ToolStreamingText;
}

interface LogMetadata {
  [key: string]: unknown;
}

interface OutputProjectionSnapshot {
  outputBlocks: readonly AnyBlock[];
  visibleMessageCountSuffix: number;
  streamPhase: StreamPhase | null;
  streamingOutputChars: number;
  streamingToolText: StreamingToolTextEntries;
}

interface OutputProjectorOptions {
  onChange?: () => void;
  sessionId?: string;
  /** Directory relative tool paths, file links, and diffs resolve against
   *  (ARCH-DIRECTORIES-007). The owning session's recorded execution directory; never the
   *  reader's own process directory. */
  executionCwd: string;
}

export class OutputProjector {
  private readonly builder: StructuredOutputBuilder;
  private readonly tools: OutputToolProjector;

  constructor(options: OutputProjectorOptions) {
    this.builder = new StructuredOutputBuilder();
    this.tools = new OutputToolProjector(this.builder, { executionCwd: options.executionCwd });
    // Forward directly: the builder's change latch only arms while a listener
    // exists, so wrapping the handler in an always-present closure would make
    // pre-wiring notifications latch it with nobody to re-arm.
    this.builder.onChange = options.onChange ?? null;
    if (options.sessionId) this.tools.sessionId = options.sessionId;
  }

  set sessionId(id: string | undefined) {
    this.tools.sessionId = id;
  }

  get sessionId(): string | undefined {
    return this.tools.sessionId;
  }

  set onChange(handler: (() => void) | null) {
    this.builder.onChange = handler;
  }

  get onChange(): (() => void) | null {
    return this.builder.onChange;
  }

  get streamPhase(): StreamPhase | null {
    return this.builder.streamPhase;
  }

  snapshot(): OutputProjectionSnapshot {
    return {
      outputBlocks: this.getBlocks(),
      visibleMessageCountSuffix: this.builder.visibleMessageCountSuffix,
      streamPhase: this.streamPhase,
      streamingOutputChars: this.builder.streamingOutputChars,
      streamingToolText: this.builder.streamingText.snapshot(),
    };
  }

  /** Applies one projection event as one change: the change listener hears
   *  it after every step of the event, never between two of them. */
  apply(event: OutputProjectionEvent): void {
    this.builder.asOneChange(() => { this.applySteps(event); });
  }

  private applySteps(event: OutputProjectionEvent): void {
    switch (event.type) {
      case "push-text":
        this.builder.setStreamPhase("generating", event.timestamp);
        this.builder.pushText(event.text, event.timestamp, event.blockKey);
        return;
      case "push-thinking":
        if (event.parentToolUseId) return;
        this.builder.setStreamPhase("thinking", event.timestamp);
        this.pushThinkingContent(event);
        return;
      case "replace-text":
        this.builder.replaceText(event.blockKey, event.text);
        return;
      case "settle-assistant-message":
        for (const content of event.content) this.applySettledContent(content);
        this.builder.completeThinking(event.timestamp);
        return;
      case "complete-thinking":
        this.builder.completeThinking(event.timestamp);
        // Exit condition: thinking ended. Fall back to "no phase" (Idle)
        // unless something else has already moved phase forward.
        if (this.builder.streamPhase === "thinking") {
          this.builder.setStreamPhase(null, event.timestamp);
        }
        return;
      case "complete-text":
        if (this.builder.streamPhase === "generating") {
          this.builder.setStreamPhase(null, event.timestamp);
        }
        return;
      case "begin-turn":
        this.builder.resetPhase();
        return;
      case "set-model-phase":
        this.builder.setStreamPhase(event.phase, event.timestamp);
        return;
      case "push-user-message":
        this.builder.pushUserMessage(event.text, event.timestamp, event.pending ?? false, event.injected ?? false, event.submissionIds, event.images, event.from, event.dispatchIds, event.entryId);
        return;
      case "push-system-message":
        this.builder.pushSystemMessage(event.message, event.timestamp, { id: event.id, level: event.level, mutationEvidence: event.mutationEvidence });
        return;
      case "push-divider":
        this.builder.pushDivider(event.label, event.timestamp);
        return;
      case "tool-use":
        if (!event.parentToolUseId) this.builder.setStreamPhase("generating", event.timestamp);
        this.tools.handleToolUse(event);
        return;
      case "agent-tool-use":
        this.tools.handleAgentToolUse(event);
        return;
      case "tool-input-delta":
        if (!event.parentToolUseId) this.builder.addStreamingChars(event.partialJson.length);
        this.tools.handleToolInputDelta(event.toolUseId, event.partialJson);
        return;
      case "tool-preview-check":
        this.tools.handleToolPreviewCheck(event.toolUseId, event.operation);
        return;
      case "abandon-tool-inputs":
        if (this.isNestedInterior(event.parentToolUseId)) return;
        this.tools.abandonToolInputs(event.reason, event.parentToolUseId);
        return;
      case "tool-execution-output":
        if (this.isNestedInterior(event.parentToolUseId)) return;
        this.tools.handleToolExecutionOutput(event.toolUseId, event.output);
        return;
      case "tool-execution-output-recorded":
        if (!event.parentToolUseId) this.tools.handleToolExecutionOutputRecorded(event.toolUseId, event);
        return;
      case "tool-input-complete":
        if (!event.parentToolUseId) this.builder.setStreamPhase("tool_executing", event.timestamp);
        this.tools.handleToolInputComplete(event.toolUseId, event.name, event.input, event.timestamp, event.parentToolUseId, event.nestedInCode, event.leadingTextId);
        return;
      case "tool-result":
        this.handleToolResult(event);
        return;
      case "tool-result-ack":
        if (this.isNestedInterior(event.parentToolUseId)) return;
        this.tools.ackToolResult(event.toolUseId);
        return;
      case "push-question":
        this.builder.setStreamPhase("tool_executing", event.timestamp);
        this.builder.pushQuestion(event.toolUseId, event.questions, event.timestamp);
        return;
      case "answer-question":
        this.builder.answerQuestion(event.toolUseId, event.answers);
        return;
      case "cancel-question":
        this.builder.cancelQuestion(event.toolUseId);
        return;
      case "complete-agent":
        this.builder.completeAgent(event.agentId, event.durationMs, { description: event.description, label: event.label });
        return;
      case "fail-agent":
        this.builder.errorAgent(event.agentId, event.message);
        return;
      case "interrupt-agent":
        this.builder.interruptAgent(event.agentId, event.durationMs);
        return;
      case "pause-agent":
        this.builder.pauseAgent(event.agentId, event.pausedBy);
        return;
      case "update-agent-meta":
        this.builder.updateAgentMeta(event.agentId, event.label, event.description);
        return;
      case "update-agent-latest-child":
        this.builder.updateAgentLatestChild(event.agentId, event.text);
        return;
      case "agent-dispatched": {
        if (this.tools.dispatchChild(event.toolUseId)) return;
        const dispatchedAgentId = this.findParentAgentId(event.toolUseId, "agent-dispatched");
        if (dispatchedAgentId) this.builder.dispatchAgent(dispatchedAgentId);
        return;
      }
      case "agent-queued": {
        const queuedAgentId = this.findParentAgentId(event.toolUseId, "agent-queued");
        if (queuedAgentId) this.builder.queueAgent(queuedAgentId);
        return;
      }
      case "agent-paused": {
        if (this.tools.pauseChild(event.toolUseId, interruptedLabel(event.pausedBy))) return;
        const pausedAgentId = this.findParentAgentId(event.toolUseId, "agent-paused");
        if (pausedAgentId) this.builder.pauseAgent(pausedAgentId, event.pausedBy);
        return;
      }
      case "set-subagent-model": {
        const agentId = this.findParentAgentId(event.toolUseId, "set-subagent-model", { model: event.model });
        if (agentId) this.builder.setAgentModel(agentId, event.model);
        return;
      }
      case "set-agent-link": {
        this.tools.setChildLink(event.toolUseId, event.linkUri);
        return;
      }
      case "retract-draft":
        this.retractDraft(event);
        return;
      case "retract-thinking-drafts":
        this.builder.removeStreamingThinkingBlocks(event.blockKeys);
        return;
      case "end-turn":
        this.endTurn(event.timestamp, event.finalStatus);
        return;
      default:
        assertNever(event);
    }
  }

  private handleToolResult(event: Extract<OutputProjectionEvent, { type: "tool-result" }>): void {
    this.tools.resolveToolResult(event.toolUseId, event.outcome, event.content, event.source ?? "render", event.details, event.executionOutputTail);
    // Exit condition: last in-flight top-level tool resolved. The model is now
    // processing tool results but hasn't emitted a delta yet; UI should
    // read "Idle", not stale "Executing". Only override when phase
    // is still tool_executing; if something else moved it, trust that.
    // Nested (subagent) tool results never touch phase; that's owned by
    // the parent agent's own events.
    if (!event.parentToolUseId && !this.tools.hasActiveTools && this.builder.streamPhase === "tool_executing") {
      this.builder.setStreamPhase(null, event.timestamp);
    }
  }

  /** The content half of each step's live handling, with no phase write. */
  private applySettledContent(content: SettledAssistantContent): void {
    switch (content.type) {
      case "push-text":
        this.builder.pushText(content.text, content.timestamp, content.blockKey);
        return;
      case "replace-text":
        this.builder.replaceText(content.blockKey, content.text);
        return;
      case "push-thinking":
        this.pushThinkingContent(content);
        return;
      case "retract-draft":
        this.retractDraft(content);
        return;
      case "tool-use":
        this.tools.handleToolUse(content);
        return;
      default:
        assertNever(content);
    }
  }

  private pushThinkingContent(event: Extract<OutputProjectionEvent, { type: "push-thinking" }>): void {
    // Char accounting lives here, not in the builder, so every top-level
    // route counts: visible/hidden foreground thinking blocks and
    // redacted thinking that arrives as a token estimate with no text.
    const chars = event.text.length + (event.estimatedTokens ?? 0) * 4;
    if (chars > 0) this.builder.addStreamingChars(chars);
    this.builder.pushThinking(event.text, event.timestamp, event.blockKey);
  }

  private retractDraft(event: Extract<OutputProjectionEvent, { type: "retract-draft" }>): void {
    this.builder.retractBlocks(event.blockKeys);
    if (event.reclassifiedChars !== undefined) this.builder.addStreamingChars(-event.reclassifiedChars);
  }

  /** True when the event's parent tool use does not resolve to an agent
   *  block: the interior of a nested subagent dispatch, which renders as a
   *  single row, so its inner events are dropped. */
  private isNestedInterior(parentToolUseId: string | undefined): boolean {
    return parentToolUseId !== undefined && this.tools.parentAgentId(parentToolUseId) === undefined;
  }

  private findParentAgentId(toolUseId: string, operation: string, meta: LogMetadata = {}): string | undefined {
    const agentId = this.tools.parentAgentId(toolUseId);
    if (!agentId) {
      // A nested subagent dispatch renders as a single child row, not an agent
      // block; its lifecycle events (dispatched/queued/model) are no-ops here.
      if (this.tools.isNestedDispatchRow(toolUseId)) return undefined;
      log.warn(`${operation}: parentAgentId not found`, {
        sessionId: this.tools.sessionId,
        toolUseId,
        ...meta,
        trackedToolCount: this.tools.trackedToolCount,
      });
    }
    return agentId;
  }

  getBlocks(): readonly AnyBlock[] {
    return this.builder.getBlocks();
  }

  drainChanges(): OutputChangeBatch {
    return this.builder.drainChanges();
  }

  seedBlocks(prior: readonly AnyBlock[]): void {
    this.builder.seedBlocks(prior);
    this.tools.seedAgentBlocks(prior);
  }

  hasQueued(): boolean {
    return this.builder.hasQueued();
  }

  drainQueued(identity?: Pick<UserMessageBlock, "submissionIds" | "dispatchIds">): string[] {
    return this.builder.drainQueued(identity);
  }

  recallQueued(): string | null {
    return this.builder.recallQueued();
  }
  withdrawQueued(dispatchIds: readonly string[]): (() => void) | null {
    return this.builder.withdrawQueued(dispatchIds);
  }

  resetTracking(): void {
    this.tools.reset();
    this.builder.resetTracking();
  }

  private endTurn(timestamp: number, finalStatus: "completed" | "paused" | "teardown"): void {
    this.builder.completeThinking(timestamp);
    this.tools.finalizeActiveTopLevelTools(finalStatus === "completed" ? "completed" : "paused");
    if (finalStatus === "completed") this.builder.closePendingAgentBlocks(timestamp);
    else if (finalStatus === "paused") this.builder.interruptPendingAgentBlocks(timestamp);
    else this.builder.interruptOpenAgentBlocks(timestamp);
    this.builder.streamingText.clearAll();
    this.builder.resetPhase();
  }
}
