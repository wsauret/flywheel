/**
 * Structured Event Parser
 *
 * Receives pre-parsed NDJSONEvent objects from NDJSONParser and dispatches
 * them to the correct engine-specific handler. Does NOT do line buffering
 * or JSON parsing — that is handled by NDJSONParser upstream.
 *
 * Pipeline position:
 *   NDJSONParser.onEvent → StructuredEventParser.dispatch() →
 *     StructuredOutputBuilder
 */

import { randomUUID } from "node:crypto";
import type { NDJSONEvent } from "../../orchestration/engines/subprocess/ndjson-parser";
import type { StructuredOutputBuilder } from "./structured-output-builder";
import { getToolDetail, extractToolDiff } from "./output-formatter";

// ── Helpers ──

/**
 * Tool names that indicate a subagent spawn (matched case-insensitively).
 *
 * Claude Code uses two names depending on the agent type:
 * - "Task" — user-dispatched subagents
 * - "Agent" — Claude Code's built-in agents (Explore, Plan, etc.)
 */
const SUBAGENT_TOOL_NAMES = new Set(["task", "agent"]);

/** Check if a tool name represents a subagent spawn. */
export function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name.toLowerCase());
}

// ── Types ──

export interface StructuredEventParserOptions {
  builder: StructuredOutputBuilder;
}

/** Tracked subagent state for duration computation. */
interface TrackedSubagent {
  agentId: string;
  spawnedAt: number;
}

// ── Parser ──

export class StructuredEventParser {
  private builder: StructuredOutputBuilder;

  /**
   * Maps Claude tool_use IDs to builder agent IDs + spawn timestamps.
   * When a Task tool_use spawns an agent, we store toolUseId → { agentId, spawnedAt }.
   * Child messages with `parent_tool_use_id` use this to route tools to the correct agent.
   */
  private toolUseIdToAgent = new Map<string, TrackedSubagent>();

  constructor(options: StructuredEventParserOptions) {
    this.builder = options.builder;
  }

  /** Reset parser state (call on step transitions). */
  reset(): void {
    this.toolUseIdToAgent.clear();
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
      const toolUseId = data.tool_use_id as string | undefined;
      if (toolUseId) {
        const tracked = this.toolUseIdToAgent.get(toolUseId);
        if (tracked) {
          const durationMs = now - tracked.spawnedAt;
          const isError = data.is_error === true;
          if (isError) {
            const content = typeof data.content === "string" ? data.content : "Unknown error";
            this.builder.errorAgent(tracked.agentId, content);
          } else {
            this.builder.completeAgent(tracked.agentId, durationMs, 0);
          }
          this.toolUseIdToAgent.delete(toolUseId);
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
    const parentAgentId = parentToolUseId ? this.toolUseIdToAgent.get(parentToolUseId)?.agentId : undefined;

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
          // Subagent spawn: generate ID, create AgentBlock, track for completion
          const agentId = randomUUID();
          const desc = (input?.description as string) || name;
          const label = (input?.subagent_type as string) || name;
          this.builder.startAgent(agentId, label, desc, now);
          // Map the tool_use ID to the agent so child messages with
          // parent_tool_use_id can route tools, and tool_result can complete it.
          if (toolUseId) {
            this.toolUseIdToAgent.set(toolUseId, { agentId, spawnedAt: now });
          }
        } else if (name) {
          // Regular tool use — route to parent agent if this is a child message
          const detail = input ? (getToolDetail(name, input) ?? "") : "";
          const diffInfo = input ? extractToolDiff(name, input) : undefined;
          // Extract raw file_path for clickable path support
          const filePath = (input?.file_path as string | undefined) ?? (input?.notebook_path as string | undefined);
          if (parentAgentId) {
            // This tool belongs to a subagent — add as child of that agent
            if (!this.builder.pushToolToAgent(parentAgentId, name, detail, now, diffInfo?.diff, diffInfo?.filetype, diffInfo?.content, filePath)) {
              // Agent not found (already evicted?) — fall through to top-level
              this.builder.pushTool(name, detail, now, diffInfo?.diff, diffInfo?.filetype, diffInfo?.content, filePath);
            }
          } else {
            this.builder.pushTool(name, detail, now, diffInfo?.diff, diffInfo?.filetype, diffInfo?.content, filePath);
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
