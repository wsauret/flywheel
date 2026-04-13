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
import type { NDJSONEvent, AssistantEventData, ContentBlock } from "../subprocess-types.js";
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
    if (event.type === "assistant") {
      this.handleClaudeAssistant(event.data, now);
    } else if (event.type === "result") {
      // Result contains accumulated text already streamed via assistant events.
      // Skip display — CompletionDetector handles completion signaling.
    } else if (event.type === "tool_result") {
      const toolUseId = event.data.tool_use_id;
      if (toolUseId) {
        const tracked = this.toolUseIdToAgent.get(toolUseId);
        if (tracked) {
          const durationMs = now - tracked.spawnedAt;
          if (event.data.is_error === true) {
            const content = typeof event.data.content === "string" ? event.data.content : "Unknown error";
            this.builder.errorAgent(tracked.agentId, content);
          } else {
            this.builder.completeAgent(tracked.agentId, durationMs);
          }
          this.toolUseIdToAgent.delete(toolUseId);
        }
      }
    }
  }

  private handleClaudeAssistant(data: AssistantEventData, now: number): void {
    const message = data.message;
    const content = message?.content;

    if (!Array.isArray(content)) return;

    // parent_tool_use_id routes child messages to their spawning subagent.
    // Claude puts it on message and sometimes at the top level.
    const parentToolUseId = message?.parent_tool_use_id ?? data.parent_tool_use_id;
    const parentAgentId = parentToolUseId ? this.toolUseIdToAgent.get(parentToolUseId)?.agentId : undefined;

    // Top-level output means all subagents are done — auto-complete open ones.
    // Skip when this message spawns new agents (parallel spawns arrive separately).
    const spawnsAgents = !parentAgentId && content.some(
      (block) => block.type === "tool_use" && isSubagentToolName(block.name),
    );
    if (!parentAgentId && !spawnsAgents) {
      this.builder.closeOpenSubagents(now);
    }

    for (const block of content) {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        if (!parentAgentId) {
          this.builder.pushThinking(block.thinking, now);
        }
      } else if (block.type === "text" && typeof block.text === "string") {
        if (!parentAgentId && block.text.length > 0) {
          this.builder.pushText(block.text, now);
        }
      } else if (block.type === "tool_use") {
        this.handleToolUse(block, parentAgentId, now);
      }
    }
  }

  private handleToolUse(block: ContentBlock & { type: "tool_use" }, parentAgentId: string | undefined, now: number): void {
    const { name, input, id: toolUseId } = block;

    if (name && isSubagentToolName(name)) {
      const agentId = randomUUID();
      const desc = (input?.description as string) || name;
      const label = (input?.subagent_type as string) || name;
      this.builder.startAgent(agentId, label, desc, now);
      if (toolUseId) {
        this.toolUseIdToAgent.set(toolUseId, { agentId, spawnedAt: now });
      }
    } else if (name === "Skill" && !parentAgentId) {
      const skillName = (input?.skill as string | undefined) ?? (input?.name as string | undefined) ?? "unknown";
      this.builder.pushSystemMessage(`Loaded skill: ${skillName}`, now);
    } else if (name === "TodoWrite" && !parentAgentId) {
      const todos = input?.todos as Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | undefined;
      if (Array.isArray(todos)) {
        this.builder.pushTodoWrite(todos, now);
      }
    } else if (name) {
      const detail = input ? (getToolDetail(name, input) ?? "") : "";
      const diffInfo = input ? extractToolDiff(name, input) : undefined;
      const filePath = (input?.file_path as string | undefined) ?? (input?.notebook_path as string | undefined);
      if (parentAgentId) {
        if (!this.builder.pushToolToAgent(parentAgentId, name, detail, now, diffInfo?.diff, diffInfo?.filetype, diffInfo?.content, filePath)) {
          this.builder.pushTool(name, detail, now, diffInfo?.diff, diffInfo?.filetype, diffInfo?.content, filePath);
        }
      } else {
        this.builder.pushTool(name, detail, now, diffInfo?.diff, diffInfo?.filetype, diffInfo?.content, filePath);
      }
    }
  }

  // ── Fallback handler (unknown engine) ──

  private dispatchFallbackEvent(event: NDJSONEvent, now: number): void {
    if (event.type === "assistant") {
      this.handleClaudeAssistant(event.data, now);
    }
    // Result text duplicates assistant events — skip. Unknown formats silently ignored.
  }
}
