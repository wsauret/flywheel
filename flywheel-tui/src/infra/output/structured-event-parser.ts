import { randomUUID } from "node:crypto";
import type { NDJSONEvent, AssistantEventData, ContentBlock, UserEventData, UserEventToolResult } from "../ndjson-event-types.js";
import type { StructuredOutputBuilder } from "./structured-output-builder.js";
import { getToolDetail, extractToolDiff, extractErrorText, launderToolError } from "./output-formatter.js";

const SUBAGENT_TOOL_NAMES = new Set(["task", "agent"]);

function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name.toLowerCase());
}

interface TrackedSubagent {
  agentId: string;
  spawnedAt: number;
}

type ToolEntryLocation =
  | { type: "top-level"; index: number; toolName: string }
  | { type: "agent-child"; agentId: string; childIndex: number; toolName: string };

export class StructuredEventParser {
  private builder: StructuredOutputBuilder;

  private toolUseIdToAgent = new Map<string, TrackedSubagent>();
  private toolUseIdToEntry = new Map<string, ToolEntryLocation>();

  constructor(builder: StructuredOutputBuilder) {
    this.builder = builder;
  }

  reset(): void {
    this.toolUseIdToAgent.clear();
    this.toolUseIdToEntry.clear();
  }

  dispatch(event: NDJSONEvent, now = Date.now()): void {
    // Result events carry cost/budget data — consumed by budget tracking, not display.
    if (event.type === "assistant") {
      this.handleClaudeAssistant(event.data, now);
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
    } else if (event.type === "user") {
      this.handleUserEvent(event.data, now);
    }
  }

  private handleClaudeAssistant(data: AssistantEventData, now: number) {
    const message = data.message;
    const content = message?.content;

    if (!Array.isArray(content)) return;

    const parentToolUseId = message?.parent_tool_use_id ?? data.parent_tool_use_id;
    const parentAgentId = parentToolUseId ? this.toolUseIdToAgent.get(parentToolUseId)?.agentId : undefined;

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

  private handleToolUse(block: ContentBlock & { type: "tool_use" }, parentAgentId: string | undefined, now: number) {
    const { name, input, id: toolUseId } = block;

    if (name && isSubagentToolName(name)) {
      // Subagent tools (Task/Agent) populate toolUseIdToAgent, NOT toolUseIdToEntry.
      // This mutual exclusivity ensures user-event tool_result handling (which reads
      // toolUseIdToEntry) and tool_result event handling (which reads toolUseIdToAgent)
      // never both fire for the same tool_use_id.
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
    } else if (name === "ToolSearch" && !parentAgentId) {
      // Swallow — internal plumbing to load deferred tool schemas, not user-visible.
      return;
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
        const childIndex = this.builder.pushToolToAgent(parentAgentId, name, detail, now, diffInfo?.diff, diffInfo?.filetype, diffInfo?.content, filePath);
        if (childIndex < 0) {
          const idx = this.builder.pushTool(name, detail, now, diffInfo?.diff, diffInfo?.filetype, diffInfo?.content, filePath);
          if (toolUseId && idx >= 0) {
            this.toolUseIdToEntry.set(toolUseId, { type: "top-level", index: idx, toolName: name });
          }
        } else if (toolUseId) {
          this.toolUseIdToEntry.set(toolUseId, { type: "agent-child", agentId: parentAgentId, childIndex, toolName: name });
        }
      } else {
        const idx = this.builder.pushTool(name, detail, now, diffInfo?.diff, diffInfo?.filetype, diffInfo?.content, filePath);
        if (toolUseId && idx >= 0) {
          this.toolUseIdToEntry.set(toolUseId, { type: "top-level", index: idx, toolName: name });
        }
      }
    }
  }

  private handleUserEvent(data: UserEventData, now: number): void {
    const content = data.message?.content;
    if (!Array.isArray(content)) return;

    for (const item of content) {
      if (item.type !== "tool_result") continue;
      const toolResult = item as UserEventToolResult;
      const toolUseId = toolResult.tool_use_id;
      if (!toolUseId) continue;

      const location = this.toolUseIdToEntry.get(toolUseId);
      if (!location) continue;

      if (toolResult.is_error === true) {
        const rawText = extractErrorText(toolResult.content) ?? "Unknown error";
        const message = launderToolError(rawText, location.toolName);

        if (location.type === "top-level") {
          this.builder.errorTool(location.index, message);
        } else {
          this.builder.errorAgentChildTool(location.agentId, location.childIndex, message);
        }
      } else {
        if (location.type === "top-level") {
          this.builder.completeTool(location.index);
        } else {
          this.builder.completeAgentChildTool(location.agentId, location.childIndex);
        }
      }

      this.toolUseIdToEntry.delete(toolUseId);
    }
  }

}
