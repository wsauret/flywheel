/**
 * NDJSON Pipeline — dispatcher/evaluator agent block management
 *
 * Owns the dispatcher and evaluator NDJSON parsers, block lifecycle tracking,
 * and Claude NDJSON event activity extraction. The OpenTUIAdapter delegates
 * dispatcher and evaluator event handling here.
 */

import { NDJSONParser } from "../../orchestration/engines/subprocess/ndjson-parser.js";
import type { NDJSONEvent } from "../../orchestration/engines/subprocess/ndjson-parser.js";
import type { StructuredOutputBuilder } from "../../infra/output/structured-output-builder.js";
import { formatDisplayPath } from "../../infra/output/output-formatter.js";

/** Parsed activity from a Claude NDJSON event. */
export interface ActivityInfo {
  name: string;
  detail: string;
}

/**
 * Manages dispatcher and evaluator NDJSON parsing pipelines.
 *
 * Tracks agent block IDs and timing, routes parsed events into the
 * StructuredOutputBuilder as tool children or status updates, and
 * exposes lifecycle methods for the adapter to call from its event switch.
 */
export class NdjsonPipeline {
  private _dispatcherBlockId: string | null = null;
  private _dispatcherStartedAt: number = 0;
  private _evaluatorBlockId: string | null = null;
  private _evaluatorStartedAt: number = 0;

  readonly dispatcherParser: NDJSONParser;
  readonly evaluatorParser: NDJSONParser;

  constructor(private readonly builder: StructuredOutputBuilder) {
    this.dispatcherParser = new NDJSONParser();
    this.dispatcherParser.onEvent = (event) => {
      this.handleDispatcherNdjsonEvent(event);
    };
    this.dispatcherParser.onRawText = () => {}; // Discard raw text from dispatcher

    this.evaluatorParser = new NDJSONParser();
    this.evaluatorParser.onEvent = (event) => {
      this.handleEvaluatorNdjsonEvent(event);
    };
    this.evaluatorParser.onRawText = () => {}; // Discard raw text from evaluator
  }

  // ── Dispatcher lifecycle ──

  get dispatcherBlockId(): string | null {
    return this._dispatcherBlockId;
  }

  startDispatcher(): string {
    const blockId = `dispatcher_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._dispatcherBlockId = blockId;
    this._dispatcherStartedAt = Date.now();
    this.dispatcherParser.flush();
    this.builder.startAgent(blockId, "Dispatcher", "Analyzing step and crafting worker prompt", Date.now());
    return blockId;
  }

  completeDispatcher(description?: string): void {
    if (this._dispatcherBlockId) {
      const elapsed = Date.now() - this._dispatcherStartedAt;
      this.dispatcherParser.flush();
      this.builder.completeAgent(this._dispatcherBlockId, elapsed, description);
      this._dispatcherBlockId = null;
    }
  }

  failDispatcher(reason: string): void {
    if (this._dispatcherBlockId) {
      this.dispatcherParser.flush();
      this.builder.errorAgent(this._dispatcherBlockId, `Unavailable: ${reason}. Using static prompt.`);
      this._dispatcherBlockId = null;
    }
  }

  // ── Evaluator lifecycle ──

  get evaluatorBlockId(): string | null {
    return this._evaluatorBlockId;
  }

  startEvaluator(): string {
    const blockId = `evaluator_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._evaluatorBlockId = blockId;
    this._evaluatorStartedAt = Date.now();
    this.evaluatorParser.flush();
    this.builder.startAgent(blockId, "Evaluator", "Checking output quality", Date.now());
    return blockId;
  }

  completeEvaluator(description?: string): void {
    if (this._evaluatorBlockId) {
      const elapsed = Date.now() - this._evaluatorStartedAt;
      this.evaluatorParser.flush();
      this.builder.completeAgent(this._evaluatorBlockId, elapsed, description);
      this._evaluatorBlockId = null;
    }
  }

  failEvaluator(reason: string): void {
    if (this._evaluatorBlockId) {
      this.evaluatorParser.flush();
      this.builder.errorAgent(this._evaluatorBlockId, `Failed: ${reason}. Skipping.`);
      this._evaluatorBlockId = null;
    }
  }

  // ── NDJSON event handlers ──

  /**
   * Handle NDJSON event from dispatcher subprocess.
   * Routes tool-use events as agent children; thinking text as status-only updates.
   */
  private handleDispatcherNdjsonEvent(event: NDJSONEvent): void {
    if (!this._dispatcherBlockId) return;
    const activity = extractActivityInfo(event.data);
    if (!activity) return;

    if (activity.name === "Thinking") {
      this.builder.updateAgentLatestChild(this._dispatcherBlockId, `Thinking: ${activity.detail}`);
    } else {
      this.builder.pushToolToAgent(this._dispatcherBlockId, activity.name, activity.detail, Date.now());
    }
  }

  /**
   * Handle NDJSON event from evaluator subprocess.
   * Routes tool-use events as agent children; thinking text as status-only updates.
   */
  private handleEvaluatorNdjsonEvent(event: NDJSONEvent): void {
    if (!this._evaluatorBlockId) return;
    const activity = extractActivityInfo(event.data);
    if (!activity) return;

    if (activity.name === "Thinking") {
      this.builder.updateAgentLatestChild(this._evaluatorBlockId, `Thinking: ${activity.detail}`);
    } else {
      this.builder.pushToolToAgent(this._evaluatorBlockId, activity.name, activity.detail, Date.now());
    }
  }
}

// ── Activity extraction (pure functions) ──

/**
 * Extract activity info from a Claude NDJSON event data payload.
 * Returns tool-use info OR thinking text from assistant messages.
 * Returns null if the event contains no actionable activity.
 */
function extractActivityInfo(data: Record<string, unknown>): ActivityInfo | null {
  // Claude assistant message — content may be at data.content or data.message.content
  const content =
    (Array.isArray(data.content) ? data.content : null) ??
    (data.message && typeof data.message === "object"
      ? (Array.isArray((data.message as Record<string, unknown>).content)
          ? (data.message as Record<string, unknown>).content as unknown[]
          : null)
      : null);

  if (data.type === "assistant" && content) {
    // Prefer tool_use blocks over text/thinking blocks
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        const input = block.input as Record<string, unknown> | undefined;
        const detail = extractToolDetail(block.name, input);
        return { name: block.name, detail };
      }
    }
    // Fall back to thinking blocks, then text blocks
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        const line = extractLastMeaningfulLine(block.thinking);
        if (line) return { name: "Thinking", detail: line };
      }
      if (block.type === "text" && typeof block.text === "string") {
        const line = extractLastMeaningfulLine(block.text);
        if (line) return { name: "Thinking", detail: line };
      }
    }
  }

  // Claude tool_use event (direct)
  if (data.type === "tool_use" && typeof data.name === "string") {
    const input = data.input as Record<string, unknown> | undefined;
    const detail = extractToolDetail(data.name, input);
    return { name: data.name, detail };
  }

  // Claude streaming content_block_delta with text_delta or thinking_delta
  if (data.type === "content_block_delta") {
    const delta = data.delta as Record<string, unknown> | undefined;
    if (delta) {
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        const line = extractLastMeaningfulLine(delta.thinking);
        if (line) return { name: "Thinking", detail: line };
      }
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        const line = extractLastMeaningfulLine(delta.text);
        if (line) return { name: "Thinking", detail: line };
      }
    }
  }

  return null;
}

/**
 * Extract the last non-empty, meaningful line from text, truncated to 80 chars.
 * Skips lines that are only whitespace or punctuation.
 */
function extractLastMeaningfulLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0 || /^[\s\p{P}]+$/u.test(trimmed)) continue;
    return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
  }
  return null;
}

/**
 * Extract a short detail string from tool input for display.
 */
function extractToolDetail(toolName: string, input?: Record<string, unknown>): string {
  if (!input) return "";
  if (input.file_path && typeof input.file_path === "string") {
    const path = formatDisplayPath(input.file_path) ?? "";
    if (toolName === "Read") {
      const offset = input.offset as number | undefined;
      const limit = input.limit as number | undefined;
      if (offset != null || limit != null) {
        const start = (offset ?? 0) + 1;
        const end = limit != null ? start + limit - 1 : undefined;
        const range = end != null ? `:${start}-${end}` : `:${start}+`;
        return `${path}${range}`;
      }
    }
    return path;
  }
  if (input.path && typeof input.path === "string") {
    return formatDisplayPath(input.path) ?? "";
  }
  if (input.command && typeof input.command === "string") {
    const cmd = input.command as string;
    return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  }
  return "";
}
