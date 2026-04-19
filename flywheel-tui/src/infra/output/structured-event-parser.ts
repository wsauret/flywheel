import { randomUUID } from "node:crypto";
import type { NDJSONEvent, AssistantEventData, ContentBlock, UserEventData, UserEventToolResult } from "../ndjson-event-types.js";
import type { StructuredOutputBuilder } from "./structured-output-builder.js";
import type { ToolEntry, QuestionEntry } from "../output-blocks.js";
import { getToolDetail, extractToolDiff, extractErrorText, launderToolError } from "./output-formatter.js";
import { SUBAGENT_TOOL_NAMES } from "./tool-constants.js";

/** Tools that resolve near-instantly — rendered as already-completed (no spinner flash). Lowercase for case-insensitive lookup. */
const OPTIMISTIC_TOOLS = new Set(["read", "glob", "grep"]);

function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name.toLowerCase());
}


interface TrackedSubagent {
  agentId: string;
  spawnedAt: number;
}

/** Location of a tool row inside an agent's children, for later status update. */
interface RowLocation {
  agentId: string;
  childIndex: number;
  toolName: string;
}

/** Location of a standalone top-level tool entry (Edit/Write). */
interface StandaloneToolLocation {
  index: number;
  toolName: string;
}

/** Tracks a subagent's AskUserQuestion so the parent row's status can be updated when the answer arrives. */
interface QuestionLocation {
  agentRow?: RowLocation;
}

/**
 * Top-level tools that bypass row-in-group and produce their own block. The
 * handler runs on tool_use and returns a StandaloneToolLocation if a later
 * tool_result should update the block's status in place (Edit/Write), or null
 * for fire-and-forget blocks (Skill/TodoWrite/ToolSearch).
 *
 * Single source of truth for which top-level tools are "standalone" — add a new
 * entry here rather than editing a switch statement.
 */
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
    const todos = input?.todos as Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | undefined;
    if (Array.isArray(todos)) builder.pushTodoWrite(todos, now);
    return null;
  },
  todo_list: (input, now, builder) => {
    if (input?.operation !== "write") return null;
    const todos = input?.todos as Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | undefined;
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

  private toolUseIdToAgent = new Map<string, TrackedSubagent>();
  private toolUseIdToRow = new Map<string, RowLocation>();
  private toolUseIdToStandalone = new Map<string, StandaloneToolLocation>();
  private toolUseIdToQuestion = new Map<string, QuestionLocation>();

  private hasStreamedText = false;
  private hasStreamedThinking = false;

  constructor(builder: StructuredOutputBuilder) {
    this.builder = builder;
  }

  reset(): void {
    this.toolUseIdToAgent.clear();
    this.toolUseIdToRow.clear();
    this.toolUseIdToStandalone.clear();
    this.toolUseIdToQuestion.clear();
    this.hasStreamedText = false;
    this.hasStreamedThinking = false;
  }

  dispatch(event: NDJSONEvent, now = Date.now()): void {
    if (event.type === "assistant") {
      this.handleClaudeAssistant(event.data, now);
    } else if (event.type === "tool_result") {
      const toolUseId = event.data.tool_use_id;
      if (!toolUseId) return;
      const tracked = this.toolUseIdToAgent.get(toolUseId);
      if (tracked) {
        const durationMs = now - tracked.spawnedAt;
        if (event.data.is_error === true) {
          const rawText = typeof event.data.content === "string" ? event.data.content : "Unknown error";
          this.builder.errorAgent(tracked.agentId, launderToolError(rawText, "Agent"));
        } else {
          this.builder.completeAgent(tracked.agentId, durationMs);
        }
        this.toolUseIdToAgent.delete(toolUseId);
      } else {
        this.resolveToolResult(toolUseId, event.data.is_error === true, event.data.content);
      }
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
    const parentAgentId = parentToolUseId ? this.toolUseIdToAgent.get(parentToolUseId)?.agentId : undefined;

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

    if (name && isSubagentToolName(name)) {
      const agentId = randomUUID();
      const desc = (input?.description as string) || name;
      const label = (input?.subagent_type as string) || name;
      this.builder.startAgent(agentId, label, desc, now);
      if (toolUseId) {
        this.toolUseIdToAgent.set(toolUseId, { agentId, spawnedAt: now });
      }
      return;
    }

    if (!name) return;

    // Top-level standalone tools bypass row-in-group and produce their own block.
    if (!parentAgentId) {
      const handler = STANDALONE_TOP_LEVEL_TOOLS[name];
      if (handler) {
        const location = handler(input, now, this.builder, toolUseId);
        if (location && toolUseId) this.toolUseIdToStandalone.set(toolUseId, location);
        return;
      }
    }

    // Subagent AskUserQuestion: push top-level question block AND a pending row in the parent agent.
    if (parentAgentId && name === "AskUserQuestion") {
      const questions = extractQuestions(input);
      if (questions && questions.length > 0 && toolUseId) {
        this.builder.pushQuestion(toolUseId, questions, now);

        const detailSummary = questions.length === 1
          ? questions[0]!.question
          : `${questions.length} questions`;
        const pending: ToolEntry = {
          kind: "tool",
          name: "AskUserQuestion",
          detail: `Awaiting user answer: ${detailSummary}`,
          timestamp: now,
        };
        const childIndex = this.builder.pushToolRowToAgent(parentAgentId, pending);
        const agentRow: RowLocation | undefined = childIndex >= 0
          ? { agentId: parentAgentId, childIndex, toolName: name }
          : undefined;
        this.toolUseIdToQuestion.set(toolUseId, { agentRow });
      }
      return;
    }

    // Every other tool pushes immediately as a pending row. The row renders
    // with a spinner; status fills in when tool_result arrives (or defaults to
    // completed if the surrounding agent closes without a tool_result).
    const detail = input ? (getToolDetail(name, input) ?? "") : "";
    const filePath = (input?.file_path as string | undefined) ?? (input?.notebook_path as string | undefined);
    const pending: ToolEntry = {
      kind: "tool",
      name,
      detail,
      timestamp: now,
      ...(filePath && { filePath }),
      ...(OPTIMISTIC_TOOLS.has(name.toLowerCase()) && { completed: true }),
    };

    let location: RowLocation | null = null;
    if (parentAgentId) {
      const childIndex = this.builder.pushToolRowToAgent(parentAgentId, pending);
      if (childIndex >= 0) {
        location = { agentId: parentAgentId, childIndex, toolName: name };
      } else {
        // Subagent evicted — fall back to the top-level Tools group so the row
        // is still visible.
        const loc = this.builder.pushToolRow(pending);
        if (loc) location = { ...loc, toolName: name };
      }
    } else {
      const loc = this.builder.pushToolRow(pending);
      if (loc) location = { ...loc, toolName: name };
    }

    if (location && toolUseId) this.toolUseIdToRow.set(toolUseId, location);
  }

  private resolveToolResult(toolUseId: string, isError: boolean, rawContent?: string | unknown[]): void {
    const row = this.toolUseIdToRow.get(toolUseId);
    if (row) {
      if (isError) {
        const rawText = extractErrorText(rawContent) ?? "Unknown error";
        const message = launderToolError(rawText, row.toolName);
        this.builder.errorAgentChildTool(row.agentId, row.childIndex, message);
      } else {
        this.builder.completeAgentChildTool(row.agentId, row.childIndex);
      }
      this.toolUseIdToRow.delete(toolUseId);
      return;
    }

    const standalone = this.toolUseIdToStandalone.get(toolUseId);
    if (standalone) {
      if (standalone.toolName === "AskUserQuestion") {
        if (isError) {
          this.builder.cancelQuestion(toolUseId);
        } else {
          this.builder.answerQuestion(toolUseId, {});
        }
      } else if (isError) {
        const rawText = extractErrorText(rawContent) ?? "Unknown error";
        const message = launderToolError(rawText, standalone.toolName);
        this.builder.errorTool(standalone.index, message);
      } else {
        this.builder.completeTool(standalone.index);
      }
      this.toolUseIdToStandalone.delete(toolUseId);
      return;
    }

    const question = this.toolUseIdToQuestion.get(toolUseId);
    if (question) {
      if (isError) {
        this.builder.cancelQuestion(toolUseId);
        if (question.agentRow) {
          this.builder.errorAgentChildTool(question.agentRow.agentId, question.agentRow.childIndex, "Cancelled");
        }
      } else {
        this.builder.answerQuestion(toolUseId, {});
        if (question.agentRow) {
          this.builder.completeAgentChildTool(question.agentRow.agentId, question.agentRow.childIndex);
        }
      }
      this.toolUseIdToQuestion.delete(toolUseId);
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
