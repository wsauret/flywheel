import type { NDJSONEvent } from "../../../infra/subprocess-types.js";

export interface ToolUseRecord {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
}

export interface ToolResultRecord {
  toolUseId: string;
  isError: boolean;
  toolOutput: unknown;
}

export function extractToolUseRecords(event: NDJSONEvent): ToolUseRecord[] {
  if (event.type !== "assistant") return [];

  const content = event.data.message?.content;
  if (!Array.isArray(content)) return [];

  const records: ToolUseRecord[] = [];
  for (const block of content) {
    if (block.type !== "tool_use") continue;
    records.push({
      toolUseId: String(block.id ?? ""),
      toolName: block.name,
      toolInput: block.input,
    });
  }
  return records;
}

export function extractToolResultRecord(event: NDJSONEvent): ToolResultRecord | null {
  if (event.type !== "tool_result") return null;

  return {
    toolUseId: String(event.data.tool_use_id ?? ""),
    isError: Boolean(event.data.is_error),
    toolOutput: event.data.content ?? "",
  };
}
