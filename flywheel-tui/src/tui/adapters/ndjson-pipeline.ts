// Why in tui/adapters/ (not infra/output/): despite having no JSX, this is a TUI
// adapter — it bridges infra streaming primitives (StructuredOutputBuilder) into
// tool-group-block lifecycle management specific to TUI display. All consumers are
// in tui/ (opentui.ts, tool-group-block.tsx). Infra owns the generic output builder;
// this adapter owns the dispatcher/evaluator display policy on top of it.
import type { NDJSONEvent, UserEventToolResult } from "../../infra/ndjson-event-types.js";
import type { StructuredOutputBuilder } from "../../infra/output/structured-output-builder.js";
import type { ToolEntry } from "../../infra/output-blocks.js";
import { getToolDetail, extractErrorText, launderToolError } from "../../infra/output/output-formatter.js";

interface RowLocation {
  childIndex: number;
  toolName: string;
}

class AgentTracker {
  private blockId: string | null = null;
  private startedAt = 0;
  /** Tool-use id → child index inside the agent block, for in-place status updates. */
  private rowByToolUseId = new Map<string, RowLocation>();

  constructor(
    private readonly builder: StructuredOutputBuilder,
    private readonly prefix: string,
  ) {}

  start(label: string, description: string): string {
    const blockId = `${this.prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.blockId = blockId;
    this.startedAt = Date.now();
    this.rowByToolUseId.clear();
    this.builder.startAgent(blockId, label, description, Date.now());
    return blockId;
  }

  complete(description?: string): void {
    if (!this.blockId) return;
    const elapsed = Date.now() - this.startedAt;
    this.builder.completeAgent(this.blockId, elapsed, description);
    this.blockId = null;
    this.rowByToolUseId.clear();
  }

  fail(message: string): void {
    if (!this.blockId) return;
    this.builder.errorAgent(this.blockId, message);
    this.blockId = null;
    this.rowByToolUseId.clear();
  }

  feedEvent(event: NDJSONEvent): void {
    if (!this.blockId) return;

    if (event.type === "assistant") {
      this.handleAssistant(event);
      return;
    }

    if (event.type === "tool_use") {
      this.pushRow(undefined, event.data.name, event.data.input);
      return;
    }

    if (event.type === "content_block_delta") {
      const delta = event.data.delta;
      if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        const line = extractLastMeaningfulLine(delta.thinking);
        if (line) this.builder.updateAgentLatestChild(this.blockId, `Thinking: ${line}`);
      } else if (delta?.type === "text_delta" && typeof delta.text === "string") {
        const line = extractLastMeaningfulLine(delta.text);
        if (line) this.builder.updateAgentLatestChild(this.blockId, `Thinking: ${line}`);
      }
      return;
    }

    if (event.type === "tool_result") {
      this.updateRow(event.data.tool_use_id, event.data.is_error === true, event.data.content);
      return;
    }

    if (event.type === "user") {
      const content = event.data.message?.content;
      if (!Array.isArray(content)) return;
      for (const item of content) {
        if (item.type !== "tool_result") continue;
        const toolResult = item as UserEventToolResult;
        this.updateRow(toolResult.tool_use_id, toolResult.is_error === true, toolResult.content);
      }
    }
  }

  private handleAssistant(event: Extract<NDJSONEvent, { type: "assistant" }>): void {
    const content = event.data.message?.content;
    if (!Array.isArray(content)) return;

    let sawToolUse = false;
    for (const block of content) {
      if (block.type === "tool_use") {
        sawToolUse = true;
        this.pushRow(block.id, block.name, block.input);
      }
    }
    if (sawToolUse) return;

    if (!this.blockId) return;
    for (const block of content) {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        const line = extractLastMeaningfulLine(block.thinking);
        if (line) {
          this.builder.updateAgentLatestChild(this.blockId, `Thinking: ${line}`);
          return;
        }
      }
      if (block.type === "text" && typeof block.text === "string") {
        const line = extractLastMeaningfulLine(block.text);
        if (line) {
          this.builder.updateAgentLatestChild(this.blockId, `Thinking: ${line}`);
          return;
        }
      }
    }
  }

  private pushRow(toolUseId: string | undefined, name: string, input: Record<string, unknown> | undefined): void {
    if (!this.blockId) return;
    const detail = getToolDetail(name, input ?? {}) ?? "";
    const tool: ToolEntry = { kind: "tool", name, detail, timestamp: Date.now() };
    const childIndex = this.builder.pushToolRowToAgent(this.blockId, tool);
    if (toolUseId && childIndex >= 0) {
      this.rowByToolUseId.set(toolUseId, { childIndex, toolName: name });
    }
  }

  private updateRow(toolUseId: string | undefined, isError: boolean, content: string | unknown[] | undefined): void {
    if (!toolUseId || !this.blockId) return;
    const row = this.rowByToolUseId.get(toolUseId);
    if (!row) return;
    this.rowByToolUseId.delete(toolUseId);

    if (isError) {
      const rawText = extractErrorText(content) ?? "Unknown error";
      this.builder.errorAgentChildTool(this.blockId, row.childIndex, launderToolError(rawText, row.toolName));
    } else {
      this.builder.completeAgentChildTool(this.blockId, row.childIndex);
    }
  }
}

/** Initial placeholder descriptions — suppressed by tool-group-block when unchanged. */
export const DISPATCHER_INITIAL_DESCRIPTION = "Analyzing step and crafting worker prompt";
export const EVALUATOR_INITIAL_DESCRIPTION = "Checking output quality";

export class NdjsonPipeline {
  private readonly dispatcher: AgentTracker;
  private readonly evaluator: AgentTracker;

  constructor(builder: StructuredOutputBuilder) {
    this.dispatcher = new AgentTracker(builder, "dispatcher");
    this.evaluator = new AgentTracker(builder, "evaluator");
  }

  startDispatcher(): string { return this.dispatcher.start("Dispatcher", DISPATCHER_INITIAL_DESCRIPTION); }
  completeDispatcher(description?: string): void { this.dispatcher.complete(description); }
  failDispatcher(reason: string): void { this.dispatcher.fail(`Unavailable: ${reason}. Using static prompt.`); }

  feedDispatcherEvent(event: NDJSONEvent): void { this.dispatcher.feedEvent(event); }

  startEvaluator(): string { return this.evaluator.start("Evaluator", EVALUATOR_INITIAL_DESCRIPTION); }
  completeEvaluator(description?: string): void { this.evaluator.complete(description); }
  failEvaluator(reason: string): void { this.evaluator.fail(`Failed: ${reason}. Skipping.`); }

  feedEvaluatorEvent(event: NDJSONEvent): void { this.evaluator.feedEvent(event); }
}

/**
 * Extract the last non-empty, meaningful line from text.
 * Skips lines that are only whitespace or punctuation.
 * Caps at 500 chars to bound memory; display truncation is handled by flexbox.
 */
function extractLastMeaningfulLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0 || /^[\s\p{P}]+$/u.test(trimmed)) continue;
    return trimmed.length > 500 ? trimmed.slice(0, 497) + "..." : trimmed;
  }
  return null;
}
