import { randomUUID } from "node:crypto";
import type { NDJSONEvent, AssistantEventData, ContentBlock, UserEventData, UserEventToolResult } from "../ndjson-event-types.js";
import type { StructuredOutputBuilder } from "./structured-output-builder.js";
import type { ToolEntry, QuestionEntry, TodoItem } from "../output-blocks.js";
import { getToolDetail, extractToolDiff, extractErrorText, launderToolError } from "./output-formatter.js";
import { classifyTool } from "../tool-display-registry.js";

/** Tools that resolve near-instantly — rendered as already-completed (no spinner flash). Lowercase for case-insensitive lookup. */
const OPTIMISTIC_TOOLS = new Set(["read", "glob", "grep"]);

/** Unified tracking for all tool_use → tool_result resolution. */
type TrackedTool =
  | { kind: "agent"; agentId: string; spawnedAt: number }
  | { kind: "row"; agentId: string; childIndex: number; toolName: string }
  | { kind: "standalone"; index: number; toolName: string };

/**
 * Top-level tools that bypass row-in-group and produce their own block. The
 * handler runs on tool_use and returns a StandaloneToolLocation if a later
 * tool_result should update the block's status in place (Edit/Write), or null
 * for fire-and-forget blocks (Skill/TodoWrite/ToolSearch).
 *
 * Single source of truth for which top-level tools are "standalone" — add a new
 * entry here rather than editing a switch statement.
 */
interface StandaloneToolLocation {
  index: number;
  toolName: string;
}

type StandaloneHandler = (
  input: Record<string, unknown> | undefined,
  now: number,
  builder: StructuredOutputBuilder,
  toolUseId?: string,
) => StandaloneToolLocation | null;

function standaloneToolHandler(toolName: "Edit" | "Write"): StandaloneHandler {
  return (input, now, builder) => {
    const detail = input ? (getToolDetail(toolName, input) ?? "") : "";
    const filePath = (input?.file_path as string | undefined) ?? (input?.notebook_path as string | undefined);
    const diffInfo = input ? extractToolDiff(toolName, input) : undefined;
    const idx = builder.pushTool(toolName, detail, now, diffInfo?.diff, diffInfo?.filetype, diffInfo?.content, filePath);
    return idx >= 0 ? { index: idx, toolName } : null;
  };
}

const STANDALONE_TOP_LEVEL_TOOLS: Record<string, StandaloneHandler> = {
  Skill: (input, now, builder) => {
    const skill = (input?.skill as string | undefined) ?? (input?.name as string | undefined) ?? "unknown";
    builder.pushSystemMessage(`Loaded skill: ${skill}`, now);
    return null;
  },
  ToolSearch: () => null, // internal plumbing to load deferred tool schemas — not user-visible
  TodoWrite: (input, now, builder) => {
    const todos = input?.todos as TodoItem[] | undefined;
    if (Array.isArray(todos)) builder.pushTodoWrite(todos, now);
    return null;
  },
  todo_list: (input, now, builder) => {
    if (input?.operation !== "write") return null;
    const todos = input?.todos as TodoItem[] | undefined;
    if (Array.isArray(todos)) builder.pushTodoWrite(todos, now);
    return null;
  },
  Edit: standaloneToolHandler("Edit"),
  Write: standaloneToolHandler("Write"),
  AskUserQuestion: (input, now, builder, toolUseId) => {
    const questions = extractQuestions(input);
    if (!questions || questions.length === 0) return null;
    if (!toolUseId) return null;
    const idx = builder.pushQuestion(toolUseId, questions, now);
    return idx >= 0 ? { index: idx, toolName: "AskUserQuestion" } : null;
  },
};

function extractQuestions(input: Record<string, unknown> | undefined): QuestionEntry[] | null {
  const raw = input?.questions;
  if (!Array.isArray(raw)) return null;
  const questions: QuestionEntry[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const rec = q as Record<string, unknown>;
    if (typeof rec.question !== "string") continue;
    const options = Array.isArray(rec.options)
      ? (rec.options as Array<Record<string, unknown>>)
          .filter((o) => o && typeof o.label === "string")
          .map((o) => ({
            label: o.label as string,
            ...(typeof o.description === "string" && { description: o.description }),
          }))
      : [];
    questions.push({
      question: rec.question,
      options,
      ...(typeof rec.multiSelect === "boolean" && { multiSelect: rec.multiSelect }),
    });
  }
  return questions;
}

export class StructuredEventParser {
  private builder: StructuredOutputBuilder;
  private trackedTools = new Map<string, TrackedTool>();

  private hasStreamedText = false;
  private hasStreamedThinking = false;

  constructor(builder: StructuredOutputBuilder) {
    this.builder = builder;
  }

  reset(): void {
    this.trackedTools.clear();
    this.hasStreamedText = false;
    this.hasStreamedThinking = false;
  }

  dispatch(event: NDJSONEvent, now = Date.now()): void {
    if (event.type === "assistant") {
      this.handleClaudeAssistant(event.data, now);
    } else if (event.type === "tool_result") {
      const toolUseId = event.data.tool_use_id;
      if (!toolUseId) return;
      this.resolveToolResult(toolUseId, event.data.is_error === true, event.data.content);
    } else if (event.type === "user") {
      this.handleUserEvent(event.data);
    } else if (event.type === "content_block_delta") {
      const delta = event.data.delta;
      if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        if (this.builder.hasActiveToolsContext) {
          if (!this.hasStreamedThinking) {
            this.builder.pushThinkingAsToolRow(now);
          }
        } else {
          this.builder.pushThinking(delta.thinking, now);
        }
        this.hasStreamedThinking = true;
      } else if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this.builder.pushText(delta.text, now);
        this.hasStreamedText = true;
      }
    }
  }

  private handleClaudeAssistant(data: AssistantEventData, now: number) {
    const message = data.message;
    const content = message?.content;

    if (!Array.isArray(content)) return;

    const parentToolUseId = message?.parent_tool_use_id ?? data.parent_tool_use_id;
    const parentTracked = parentToolUseId ? this.trackedTools.get(parentToolUseId) : undefined;
    const parentAgentId = parentTracked?.kind === "agent" ? parentTracked.agentId : undefined;

    const skipStreamedText = this.hasStreamedText && !parentAgentId;
    const skipStreamedThinking = this.hasStreamedThinking && !parentAgentId;
    this.hasStreamedText = false;
    this.hasStreamedThinking = false;

    // Process tools first — they create the context group
    for (const block of content) {
      if (block.type === "tool_use") {
        this.handleToolUse(block, parentAgentId, now);
      }
    }

    // Now process thinking and text
    for (const block of content) {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        if (!parentAgentId && !skipStreamedThinking) {
          if (this.builder.hasActiveToolsContext) {
            this.builder.pushThinkingAsToolRow(now);
          } else if (block.thinking.length > 0) {
            this.builder.pushThinking(block.thinking, now);
          }
        }
      } else if (block.type === "text" && typeof block.text === "string") {
        if (!skipStreamedText && !parentAgentId && block.text.length > 0) {
          this.builder.pushText(block.text, now);
        }
      }
    }
  }

  private handleToolUse(block: ContentBlock & { type: "tool_use" }, parentAgentId: string | undefined, now: number) {
    const { name, input, id: toolUseId } = block;
    if (!name) return;

    const category = classifyTool(name);

    if (category === "subagent") {
      const agentId = randomUUID();
      const desc = (input?.description as string) || name;
      const label = (input?.subagent_type as string) || name;
      this.builder.startAgent(agentId, label, desc, now);
      if (toolUseId) {
        this.trackedTools.set(toolUseId, { kind: "agent", agentId, spawnedAt: now });
      }
      return;
    }

    // Top-level tools with a handler bypass row-in-group and produce their own
    // block. classifyTool routes subagent/groupable; the handler map dispatches
    // standalone rendering for tools that need it (Edit, Write, AskUserQuestion, etc.).
    if (!parentAgentId) {
      const handler = STANDALONE_TOP_LEVEL_TOOLS[name];
      if (handler) {
        const location = handler(input, now, this.builder, toolUseId);
        if (location && toolUseId) {
          this.trackedTools.set(toolUseId, { kind: "standalone", index: location.index, toolName: location.toolName });
        }
        return;
      }
    }

    // Every other tool pushes immediately as a pending child. Most render as a
    // compact row, but mutation tools can carry diff/content so the group
    // renderer can upgrade them to a full ToolEntry preview with highlighting.
    const detail = input ? (getToolDetail(name, input) ?? "") : "";
    const filePath = (input?.file_path as string | undefined) ?? (input?.notebook_path as string | undefined);
    const diffInfo = input ? extractToolDiff(name, input) : undefined;
    const pending: ToolEntry = {
      kind: "tool",
      name,
      detail,
      timestamp: now,
      ...(filePath && { filePath }),
      ...(diffInfo?.diff && { diff: diffInfo.diff }),
      ...(diffInfo?.content && { content: diffInfo.content }),
      ...(diffInfo?.filetype && { filetype: diffInfo.filetype }),
      ...(OPTIMISTIC_TOOLS.has(name.toLowerCase()) && { completed: true }),
    };

    let tracked: TrackedTool | null = null;
    if (parentAgentId) {
      const childIndex = this.builder.pushToolRowToAgent(parentAgentId, pending);
      if (childIndex >= 0) {
        tracked = { kind: "row", agentId: parentAgentId, childIndex, toolName: name };
      } else {
        // Subagent evicted — fall back to the top-level Tools group so the row
        // is still visible.
        const loc = this.builder.pushToolRow(pending);
        if (loc) tracked = { kind: "row", ...loc, toolName: name };
      }
    } else {
      const loc = this.builder.pushToolRow(pending);
      if (loc) tracked = { kind: "row", ...loc, toolName: name };
    }

    if (tracked && toolUseId) this.trackedTools.set(toolUseId, tracked);
  }

  private resolveToolResult(toolUseId: string, isError: boolean, rawContent?: string | unknown[]): void {
    const tracked = this.trackedTools.get(toolUseId);
    if (!tracked) return;
    this.trackedTools.delete(toolUseId);

    switch (tracked.kind) {
      case "agent": {
        const durationMs = Date.now() - tracked.spawnedAt;
        if (isError) {
          const rawText = extractErrorText(rawContent) ?? "Unknown error";
          this.builder.errorAgent(tracked.agentId, launderToolError(rawText, "Agent"));
        } else {
          this.builder.completeAgent(tracked.agentId, durationMs);
        }
        break;
      }
      case "row": {
        if (isError) {
          const rawText = extractErrorText(rawContent) ?? "Unknown error";
          const message = launderToolError(rawText, tracked.toolName);
          this.builder.errorAgentChildTool(tracked.agentId, tracked.childIndex, message);
        } else {
          this.builder.completeAgentChildTool(tracked.agentId, tracked.childIndex);
        }
        break;
      }
      case "standalone": {
        if (tracked.toolName === "AskUserQuestion") {
          if (isError) {
            this.builder.cancelQuestion(toolUseId);
          } else {
            this.builder.answerQuestion(toolUseId, {});
          }
        } else if (isError) {
          const rawText = extractErrorText(rawContent) ?? "Unknown error";
          const message = launderToolError(rawText, tracked.toolName);
          this.builder.errorTool(tracked.index, message);
        } else {
          this.builder.completeTool(tracked.index);
        }
        break;
      }
    }
  }

  private handleUserEvent(data: UserEventData): void {
    const content = data.message?.content;
    if (!Array.isArray(content)) return;

    for (const item of content) {
      if (item.type !== "tool_result") continue;
      const toolResult = item as UserEventToolResult;
      const toolUseId = toolResult.tool_use_id;
      if (!toolUseId) continue;
      this.resolveToolResult(toolUseId, toolResult.is_error === true, toolResult.content);
    }
  }
}
