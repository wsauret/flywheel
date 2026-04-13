import { randomUUID } from "node:crypto";
import type { NDJSONEvent, AssistantEventData, ContentBlock } from "../subprocess-types.js";
import type { StructuredOutputBuilder } from "./structured-output-builder.js";
import { getToolDetail, extractToolDiff } from "./output-formatter.js";

const SUBAGENT_TOOL_NAMES = new Set(["task", "agent"]);

function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name.toLowerCase());
}

interface StructuredEventParserOptions {
  builder: StructuredOutputBuilder;
}

interface TrackedSubagent {
  agentId: string;
  spawnedAt: number;
}

export class StructuredEventParser {
  private builder: StructuredOutputBuilder;

  private toolUseIdToAgent = new Map<string, TrackedSubagent>();

  constructor(options: StructuredEventParserOptions) {
    this.builder = options.builder;
  }

  reset(): void {
    this.toolUseIdToAgent.clear();
  }

  dispatch(event: NDJSONEvent): void {
    this.dispatchClaudeEvent(event, Date.now());
  }

  private dispatchClaudeEvent(event: NDJSONEvent, now: number) {
    if (event.type === "assistant") {
      this.handleClaudeAssistant(event.data, now);
    } else if (event.type === "result") {
      // Result events carry cost/budget data — consumed by budget tracking, not display.
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

}
