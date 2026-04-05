/**
 * Structured Event Parser
 *
 * Receives pre-parsed NDJSONEvent objects from NDJSONParser and dispatches
 * them to the correct engine-specific handler. Does NOT do line buffering
 * or JSON parsing — that is handled by NDJSONParser upstream.
 *
 * Pipeline position:
 *   NDJSONParser.onEvent → StructuredEventParser.dispatch() →
 *     SubagentTraceParser + StructuredOutputBuilder
 */

import type { NDJSONEvent } from "../../orchestration/worker/ndjson-parser";
import { isSubagentToolName, type ClaudeJsonlMessage } from "./subagent-tracing/types";
import type { SubagentTraceParser } from "./subagent-tracing/parser";
import type { StructuredOutputBuilder } from "./structured-output-builder";
import { getToolDetail, extractToolDiff } from "./output-formatter";

// ── Types ──

export interface StructuredEventParserOptions {
  traceParser: SubagentTraceParser;
  builder: StructuredOutputBuilder;
}

// ── Parser ──

export class StructuredEventParser {
  private traceParser: SubagentTraceParser;
  private builder: StructuredOutputBuilder;

  /**
   * Maps Claude tool_use IDs to builder agent IDs.
   * When a Task tool_use spawns an agent, we store toolUseId → builderAgentId.
   * Child messages with `parent_tool_use_id` use this to route tools to the correct agent.
   */
  private toolUseIdToAgentId = new Map<string, string>();

  constructor(options: StructuredEventParserOptions) {
    this.traceParser = options.traceParser;
    this.builder = options.builder;
  }

  /** Reset parser state (call on step transitions). */
  reset(): void {
    this.toolUseIdToAgentId.clear();
  }

  /**
   * Dispatch a parsed NDJSON event through the correct engine handler.
   * Falls back to Claude format for unknown engines.
   */
  dispatch(event: NDJSONEvent, engineId?: string): void {
    const now = Date.now();

    if (engineId === "claude" || engineId === "harness") {
      this.dispatchClaudeEvent(event, now);
    } else {
      // Unknown engine: fall back to Claude format (most common)
      this.dispatchFallbackEvent(event, now);
    }
  }

  // ── Claude handler ──

  private dispatchClaudeEvent(event: NDJSONEvent, now: number): void {
    const data = event.data;
    const type = data.type as string | undefined;

    if (type === "assistant") {
      this.handleClaudeAssistant(data, now);
    } else if (type === "result") {
      // The result event contains the full accumulated text from the session.
      // This text was already streamed via individual assistant events, so
      // pushing it again would cause double printing. Skip display — the
      // result event is handled by CompletionDetector for completion signaling.
    } else if (type === "tool_result") {
      // Tool results correlate with subagent completions
      const claudeMsg: ClaudeJsonlMessage = {
        type: "result",
        result: typeof data.content === "string" ? data.content : undefined,
        raw: data,
      };
      const events = this.traceParser.processMessage(claudeMsg);
      for (const subEvent of events) {
        if (subEvent.type === "complete") {
          this.builder.completeAgent(subEvent.id, subEvent.durationMs, 0);
        } else if (subEvent.type === "error") {
          this.builder.errorAgent(subEvent.id, subEvent.errorMessage);
        }
      }
    }
    // system, init, etc. — skip
  }

  private handleClaudeAssistant(data: Record<string, unknown>, now: number): void {
    const message = data.message as Record<string, unknown> | undefined;
    const content = message?.content as Array<Record<string, unknown>> | undefined;

    if (!Array.isArray(content)) return;

    // Check if this message is a child of a subagent via parent_tool_use_id.
    // Claude Code stream-json: each assistant message has parent_tool_use_id
    // (null for top-level, tool_use ID for child messages inside a subagent).
    const parentToolUseId = (message?.parent_tool_use_id ?? data.parent_tool_use_id) as string | null | undefined;
    const parentAgentId = parentToolUseId ? this.toolUseIdToAgentId.get(parentToolUseId) : undefined;

    for (const block of content) {
      const blockType = block.type as string | undefined;

      if (blockType === "thinking" && typeof block.thinking === "string") {
        if (!parentAgentId) {
          this.builder.pushThinking(block.thinking, now);
        }
      } else if (blockType === "text" && typeof block.text === "string") {
        // Text inside a child message: skip (agent text is not useful for display)
        if (!parentAgentId) {
          if (block.text.length > 0) {
            this.builder.pushText(block.text as string, now);
          }
        }
      } else if (blockType === "tool_use") {
        const name = block.name as string;
        const input = block.input as Record<string, unknown> | undefined;
        const toolUseId = block.id as string | undefined;

        if (name && isSubagentToolName(name)) {
          // Subagent spawn: send through trace parser, then create AgentBlock
          const claudeMsg: ClaudeJsonlMessage = {
            type: "assistant",
            tool: { name, input },
            raw: data,
          };
          const subEvents = this.traceParser.processMessage(claudeMsg);
          for (const subEvent of subEvents) {
            if (subEvent.type === "spawn") {
              const desc = (input?.description as string) || subEvent.description || name;
              // Use subagent_type from input if available, otherwise use the tool name
              const label = (input?.subagent_type as string) || name;
              this.builder.startAgent(subEvent.id, label, desc, now);
              // Map the tool_use ID to the builder agent ID so child messages
              // with parent_tool_use_id can route tools to this agent.
              if (toolUseId) {
                this.toolUseIdToAgentId.set(toolUseId, subEvent.id);
              }
            }
          }
        } else if (name) {
          // Regular tool use — route to parent agent if this is a child message
          const detail = input ? (getToolDetail(name, input) ?? "") : "";
          const diffInfo = input ? extractToolDiff(name, input) : undefined;
          if (parentAgentId) {
            // This tool belongs to a subagent — add as child of that agent
            if (!this.builder.pushToolToAgent(parentAgentId, name, detail, now, diffInfo?.diff, diffInfo?.filetype)) {
              // Agent not found (already evicted?) — fall through to top-level
              this.builder.pushTool(name, detail, now, diffInfo?.diff, diffInfo?.filetype);
            }
          } else {
            this.builder.pushTool(name, detail, now, diffInfo?.diff, diffInfo?.filetype);
          }
        }
      }
    }
  }

  // ── Fallback handler (unknown engine) ──

  private dispatchFallbackEvent(event: NDJSONEvent, now: number): void {
    // Best-effort: try Claude format (most common)
    const data = event.data;
    const type = data.type as string | undefined;

    if (type === "assistant") {
      this.handleClaudeAssistant(data, now);
    } else if (type === "result") {
      // Skip — same rationale as dispatchClaudeEvent: result text duplicates
      // content already streamed via assistant events.
    }
    // Unknown format — silently skip
  }
}
