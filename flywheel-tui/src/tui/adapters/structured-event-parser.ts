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

import type { NDJSONEvent } from "../../worker/ndjson-parser";
import { isSubagentToolName, type ClaudeJsonlMessage } from "./subagent-tracing/types";
import type { SubagentTraceParser } from "./subagent-tracing/parser";
import type { StructuredOutputBuilder } from "./structured-output-builder";
import {
  isOpenCodeTaskTool,
  openCodeTaskToClaudeMessages,
} from "./subagent-tracing/opencode-adapter";
import type { OpenCodeJsonlMessage } from "./subagent-tracing/opencode-adapter";
import { getToolDetail } from "./output-formatter";
import { COMPLETION_REGEX } from "../../worker/completion";

// ── Types ──

export interface StructuredEventParserOptions {
  traceParser: SubagentTraceParser;
  builder: StructuredOutputBuilder;
}

// ── Parser ──

/** Strip completion markers from text before display. */
function stripCompletionMarker(text: string): string {
  return text.replace(COMPLETION_REGEX, "");
}

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

  /** Reset parser state (call on phase transitions). */
  reset(): void {
    this.toolUseIdToAgentId.clear();
  }

  /**
   * Dispatch a parsed NDJSON event through the correct engine handler.
   * Falls back to text extraction for unknown engines.
   */
  dispatch(event: NDJSONEvent, engineId?: string): void {
    const now = Date.now();

    if (engineId === "claude") {
      this.dispatchClaudeEvent(event, now);
    } else if (engineId === "opencode") {
      this.dispatchOpenCodeEvent(event, now);
    } else {
      // Unknown engine: fall back to text extraction
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
      const result = data.result;
      if (typeof result === "string" && result.length > 0) {
        const cleaned = stripCompletionMarker(result);
        if (cleaned.trim().length > 0) {
          this.builder.pushText(cleaned + "\n", now);
        }
      }
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

      if (blockType === "text" && typeof block.text === "string") {
        // Text inside a child message: skip (agent text is not useful for display)
        if (!parentAgentId) {
          const cleaned = stripCompletionMarker(block.text);
          if (cleaned.length > 0) {
            this.builder.pushText(cleaned, now);
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
          if (parentAgentId) {
            // This tool belongs to a subagent — add as child of that agent
            if (!this.builder.pushToolToAgent(parentAgentId, name, detail, now)) {
              // Agent not found (already evicted?) — fall through to top-level
              this.builder.pushTool(name, detail, now);
            }
          } else {
            this.builder.pushTool(name, detail, now);
          }
        }
      }
    }
  }

  // ── OpenCode handler ──

  private dispatchOpenCodeEvent(event: NDJSONEvent, now: number): void {
    const data = event.data;
    const type = data.type as string | undefined;

    if (type === "text") {
      const part = data.part as { text?: string } | undefined;
      if (part?.text) {
        const cleaned = stripCompletionMarker(part.text);
        if (cleaned.length > 0) {
          this.builder.pushText(cleaned, now);
        }
      }
    } else if (type === "tool_use") {
      this.handleOpenCodeToolUse(data, now);
    }
    // step_start, step_finish, reasoning, error — currently skipped
    // (can be added in future phases)
  }

  private handleOpenCodeToolUse(data: Record<string, unknown>, now: number): void {
    const part = data.part as Record<string, unknown> | undefined;
    if (!part) return;

    const toolName = part.tool as string | undefined;
    if (!toolName) return;

    // Build OpenCodeJsonlMessage for task detection
    const ocMsg: OpenCodeJsonlMessage = {
      source: "opencode",
      type: "tool_use",
      timestamp: typeof data.timestamp === "number" ? data.timestamp : undefined,
      part: part as any,
      raw: data,
    };

    if (isOpenCodeTaskTool(ocMsg)) {
      // Convert to Claude format for SubagentTraceParser compatibility
      const claudeMessages = openCodeTaskToClaudeMessages(ocMsg);
      for (const claudeMsg of claudeMessages) {
        const subEvents = this.traceParser.processMessage(claudeMsg);
        for (const subEvent of subEvents) {
          if (subEvent.type === "spawn") {
            const state = (part.state as Record<string, unknown>) ?? {};
            const input = state.input as Record<string, unknown> | undefined;
            const desc = (input?.description as string) || subEvent.description || toolName;
            this.builder.startAgent(subEvent.id, "Task", desc, now);
          } else if (subEvent.type === "complete") {
            this.builder.completeAgent(subEvent.id, subEvent.durationMs, 0);
          } else if (subEvent.type === "error") {
            this.builder.errorAgent(subEvent.id, subEvent.errorMessage);
          }
        }
      }
    } else {
      // Regular tool use
      const state = (part.state as Record<string, unknown>) ?? {};
      const input = state.input as Record<string, unknown> | undefined;
      const detail = input ? (getToolDetail(toolName, input) ?? "") : "";
      this.builder.pushTool(toolName, detail, now);
    }
  }

  // ── Fallback handler (unknown engine) ──

  private dispatchFallbackEvent(event: NDJSONEvent, now: number): void {
    // Best-effort: try Claude format first (most common)
    const data = event.data;
    const type = data.type as string | undefined;

    if (type === "assistant") {
      this.handleClaudeAssistant(data, now);
    } else if (type === "result") {
      const result = data.result;
      if (typeof result === "string" && result.length > 0) {
        const cleaned = stripCompletionMarker(result);
        if (cleaned.trim().length > 0) {
          this.builder.pushText(cleaned + "\n", now);
        }
      }
    } else if (type === "text") {
      // OpenCode text format
      const part = data.part as { text?: string } | undefined;
      if (part?.text) {
        const cleaned = stripCompletionMarker(part.text);
        if (cleaned.length > 0) {
          this.builder.pushText(cleaned, now);
        }
      }
    } else if (type === "tool_use") {
      // Could be OpenCode tool_use
      this.handleOpenCodeToolUse(data, now);
    }
    // Unknown format — silently skip
  }
}
