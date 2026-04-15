// Why in tui/adapters/ (not infra/output/): despite having no JSX, this is a TUI
// adapter — it bridges infra streaming primitives (NDJSONParser, StructuredOutputBuilder)
// into agent-block lifecycle management specific to TUI display. All consumers are in
// tui/ (opentui.ts, agent-block.tsx). Infra owns the generic output builder; this
// adapter owns the dispatcher/evaluator display policy on top of it.
import { NDJSONParser } from "../../infra/ndjson-parser.js";
import type { NDJSONEvent } from "../../infra/subprocess-types.js";
import type { StructuredOutputBuilder } from "../../infra/output/structured-output-builder.js";
import { getToolDetail } from "../../infra/output/output-formatter.js";

interface ActivityInfo {
  name: string;
  detail: string;
}

class AgentTracker {
  private blockId: string | null = null;
  private startedAt = 0;
  readonly parser: NDJSONParser;

  constructor(
    private readonly builder: StructuredOutputBuilder,
    private readonly prefix: string,
  ) {
    this.parser = new NDJSONParser();
    this.parser.onEvent = (event) => this.handleEvent(event);
    this.parser.onRawText = () => {};
  }

  start(label: string, description: string): string {
    const blockId = `${this.prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.blockId = blockId;
    this.startedAt = Date.now();
    this.parser.flush();
    this.builder.startAgent(blockId, label, description, Date.now());
    return blockId;
  }

  complete(description?: string): void {
    if (!this.blockId) return;
    const elapsed = Date.now() - this.startedAt;
    this.parser.flush();
    this.builder.completeAgent(this.blockId, elapsed, description);
    this.blockId = null;
  }

  fail(message: string): void {
    if (!this.blockId) return;
    this.parser.flush();
    this.builder.errorAgent(this.blockId, message);
    this.blockId = null;
  }

  private handleEvent(event: NDJSONEvent): void {
    if (!this.blockId) return;
    const activity = extractActivityInfo(event);
    if (!activity) return;

    if (activity.name === "Thinking") {
      this.builder.updateAgentLatestChild(this.blockId, `Thinking: ${activity.detail}`);
    } else {
      this.builder.pushToolToAgent(this.blockId, activity.name, activity.detail, Date.now());
    }
  }
}

/** Initial placeholder descriptions — suppressed by agent-block when unchanged. */
export const DISPATCHER_INITIAL_DESCRIPTION = "Analyzing step and crafting worker prompt";
export const EVALUATOR_INITIAL_DESCRIPTION = "Checking output quality";

export class NdjsonPipeline {
  private readonly dispatcher: AgentTracker;
  private readonly evaluator: AgentTracker;

  get dispatcherParser() { return this.dispatcher.parser; }
  get evaluatorParser() { return this.evaluator.parser; }

  constructor(builder: StructuredOutputBuilder) {
    this.dispatcher = new AgentTracker(builder, "dispatcher");
    this.evaluator = new AgentTracker(builder, "evaluator");
  }

  startDispatcher(): string { return this.dispatcher.start("Dispatcher", DISPATCHER_INITIAL_DESCRIPTION); }
  completeDispatcher(description?: string): void { this.dispatcher.complete(description); }
  failDispatcher(reason: string): void { this.dispatcher.fail(`Unavailable: ${reason}. Using static prompt.`); }

  startEvaluator(): string { return this.evaluator.start("Evaluator", EVALUATOR_INITIAL_DESCRIPTION); }
  completeEvaluator(description?: string): void { this.evaluator.complete(description); }
  failEvaluator(reason: string): void { this.evaluator.fail(`Failed: ${reason}. Skipping.`); }
}

function extractActivityInfo(event: NDJSONEvent): ActivityInfo | null {
  if (event.type === "assistant") {
    const content = event.data.message?.content;
    if (!Array.isArray(content)) return null;

    for (const block of content) {
      if (block.type === "tool_use") {
        return { name: block.name, detail: getToolDetail(block.name, block.input ?? {}) ?? "" };
      }
    }
    for (const block of content) {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        const line = extractLastMeaningfulLine(block.thinking);
        if (line) return { name: "Thinking", detail: line };
      }
      if (block.type === "text" && typeof block.text === "string") {
        const line = extractLastMeaningfulLine(block.text);
        if (line) return { name: "Thinking", detail: line };
      }
    }
    return null;
  }

  if (event.type === "tool_use") {
    return { name: event.data.name, detail: getToolDetail(event.data.name, event.data.input ?? {}) ?? "" };
  }

  if (event.type === "content_block_delta") {
    const delta = event.data.delta;
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
      const line = extractLastMeaningfulLine(delta.thinking);
      if (line) return { name: "Thinking", detail: line };
    }
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      const line = extractLastMeaningfulLine(delta.text);
      if (line) return { name: "Thinking", detail: line };
    }
  }

  return null;
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

