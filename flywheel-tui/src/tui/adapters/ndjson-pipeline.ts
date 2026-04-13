/**
 * NDJSON Pipeline — dispatcher/evaluator agent block management
 *
 * Owns the dispatcher and evaluator NDJSON parsers, block lifecycle tracking,
 * and Claude NDJSON event activity extraction. The OpenTUIAdapter delegates
 * dispatcher and evaluator event handling here.
 */

import { NDJSONParser } from "../../infra/ndjson-parser.js";
import type { NDJSONEvent } from "../../infra/subprocess-types.js";
import type { StructuredOutputBuilder } from "../../infra/output/structured-output-builder.js";
import { getToolDetail } from "../../infra/output/output-formatter.js";

interface ActivityInfo {
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
    const activity = extractActivityInfo(event);
    if (!activity) return;

    if (activity.name === "Thinking") {
      this.builder.updateAgentLatestChild(this._dispatcherBlockId, `Thinking: ${activity.detail}`);
    } else {
      this.builder.pushToolToAgent(this._dispatcherBlockId, activity.name, activity.detail, Date.now());
    }
  }

  private handleEvaluatorNdjsonEvent(event: NDJSONEvent): void {
    if (!this._evaluatorBlockId) return;
    const activity = extractActivityInfo(event);
    if (!activity) return;

    if (activity.name === "Thinking") {
      this.builder.updateAgentLatestChild(this._evaluatorBlockId, `Thinking: ${activity.detail}`);
    } else {
      this.builder.pushToolToAgent(this._evaluatorBlockId, activity.name, activity.detail, Date.now());
    }
  }
}

// ── Activity extraction ──

function extractActivityInfo(event: NDJSONEvent): ActivityInfo | null {
  if (event.type === "assistant") {
    const content = event.data.message?.content;
    if (!Array.isArray(content)) return null;

    // Prefer tool_use blocks
    for (const block of content) {
      if (block.type === "tool_use") {
        return { name: block.name, detail: getToolDetail(block.name, block.input ?? {}) ?? "" };
      }
    }
    // Fall back to thinking/text blocks
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

