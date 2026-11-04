/**
 * Subagent turn-log types and formatters.
 *
 * `SubagentToolCallRecord` captures one tool invocation: the requested call
 * (toolName + input), terminal status, and an optional result string.
 *
 * `buildSubagentWorkLog` renders the full log as markdown for an LLM prompt;
 * `buildFallbackSummary` produces a terse, LLM-free summary the parent can
 * read when the LLM summarization step is skipped or fails.
 *
 */

import type { RuntimeEvent } from "../../../../infra/runtime-event-types.js";
import { toolIdentity } from "../../../tool-catalog.js";

interface ToolInput {
  [key: string]: unknown;
}

type ToolResultContent = Extract<RuntimeEvent, { type: "tool.result.recorded" }>["data"]["content"];

export interface SubagentTurnLogObserver {
  recordToolUse(toolUseId: string, toolName: string, input: ToolInput): void;
  recordToolResult(
    toolUseId: string,
    content: ToolResultContent,
    isError: boolean,
    interrupted: boolean,
  ): void;
}

export interface SubagentToolCallRecord {
  toolName: string;
  input: ToolInput;
  status: "pending" | "done" | "error" | "interrupted";
  result?: string;
}

const RESULT_TRUNCATION_CHARS = 300;
const COMMAND_TRUNCATION_CHARS = 200;
const FALLBACK_COMMAND_CHARS = 60;
const RETAINED_RESULT_CHARS = RESULT_TRUNCATION_CHARS + 1;
const RETAINED_COMMAND_CHARS = COMMAND_TRUNCATION_CHARS + 1;
interface FallbackBuckets {
  fileChanges: string[];
  commands: string[];
  reads: string[];
  searches: string[];
  otherTools: string[];
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated)`;
}

function stringField(input: ToolInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function retainedInput(toolName: string, input: ToolInput): ToolInput {
  switch (toolName) {
    case "edit":
    case "write":
    case "read":
      return retainedStringFields(input, ["path"]);
    case "search":
    case "list":
      return retainedStringFields(input, ["pattern", "path"]);
    case "bash": {
      const command = stringField(input, "command");
      return command === undefined ? {} : { command: command.slice(0, RETAINED_COMMAND_CHARS) };
    }
    default:
      return {};
  }
}

function retainedStringFields(input: ToolInput, keys: readonly string[]): ToolInput {
  const retained: ToolInput = {};
  for (const key of keys) {
    const value = stringField(input, key);
    if (value !== undefined) retained[key] = value;
  }
  return retained;
}

interface SubagentTurnLog {
  records: SubagentToolCallRecord[];
  observer: SubagentTurnLogObserver;
}

/** Captures only failure-summary inputs without retaining unused tool payloads.
 * Observations update records in place; source events remain untouched. */
export function createSubagentTurnLog(): SubagentTurnLog {
  const records: SubagentToolCallRecord[] = [];
  const recordIndex = new Map<string, number>();
  return {
    records,
    observer: {
      recordToolUse(id, presentedName, input) {
        // Rows name the tool, so every registration of one renders alike.
        const toolName = toolIdentity(presentedName);
        recordIndex.set(id, records.length);
        records.push({ toolName, input: retainedInput(toolName, input), status: "pending" });
      },
      recordToolResult(id, content, isError, interrupted) {
        const index = recordIndex.get(id);
        if (index === undefined) return;
        const existing = records[index];
        if (!existing) return;
        const status = interrupted ? "interrupted" : isError ? "error" : "done";
        const capturesResult = status === "done"
          && (existing.toolName === "bash" || existing.toolName === "edit" || existing.toolName === "write");
        const serialized = capturesResult && content ? JSON.stringify(content) : undefined;
        records[index] = {
          ...existing,
          status,
          ...(serialized === undefined ? {} : { result: serialized.slice(0, RETAINED_RESULT_CHARS) }),
        };
      },
    },
  };
}

export function formatSubagentToolCall(record: SubagentToolCallRecord): string {
  const { toolName, input, status, result } = record;
  const parts: string[] = [`\n### ${toolName} (${status})`];

  switch (toolName) {
    case "edit":
    case "write":
    case "read": {
      const path = stringField(input, "path");
      if (path) parts.push(`\n**Path:** \`${path}\``);
      break;
    }
    case "search": {
      const pattern = stringField(input, "pattern");
      const path = stringField(input, "path");
      if (pattern) parts.push(`\n**Pattern:** \`${pattern}\``);
      if (path) parts.push(` in \`${path}\``);
      break;
    }
    case "list": {
      const path = stringField(input, "path");
      const pattern = stringField(input, "pattern");
      if (path) parts.push(`\n**Path:** \`${path}\``);
      if (pattern) parts.push(`\n**Pattern:** \`${pattern}\``);
      break;
    }
    case "bash": {
      const command = stringField(input, "command");
      if (command) {
        const shown = command.length > COMMAND_TRUNCATION_CHARS
          ? `${command.slice(0, COMMAND_TRUNCATION_CHARS)}...`
          : command;
        parts.push(`\n**Command:** \`${shown}\``);
      }
      break;
    }
  }

  if (status === "done" && result) {
    if (toolName === "bash") {
      parts.push(`\n**Output:**\n\`\`\`\n${truncate(result, RESULT_TRUNCATION_CHARS)}\n\`\`\``);
    } else if (toolName === "edit" || toolName === "write") {
      parts.push(`\n**Result:**\n\`\`\`\n${truncate(result, RESULT_TRUNCATION_CHARS)}\n\`\`\``);
    }
  }

  return parts.join("");
}

export function buildSubagentWorkLog(records: ReadonlyArray<SubagentToolCallRecord>): string {
  if (records.length === 0) return "";
  const lines: string[] = [];
  for (const [i, record] of records.entries()) {
    lines.push(`## Tool call ${i + 1}`, formatSubagentToolCall(record), "\n---\n");
  }
  return lines.join("\n");
}

export function buildFallbackSummary(records: ReadonlyArray<SubagentToolCallRecord>): string {
  if (records.length === 0) {
    return "No tool calls completed before the error occurred.";
  }

  const summary = createFallbackBuckets();

  for (const record of records) {
    if (record.status !== "done") continue;
    addFallbackRecord(summary, record);
  }

  const sections: string[] = ["## Work completed before error"];
  if (summary.fileChanges.length > 0) sections.push("", "**File changes:**", ...summary.fileChanges);
  if (summary.commands.length > 0) sections.push("", "**Commands run:**", ...summary.commands);
  if (summary.reads.length > 0) sections.push("", "**Files read:**", ...summary.reads);
  if (summary.searches.length > 0) sections.push("", "**Searches:**", ...summary.searches);
  if (summary.otherTools.length > 0) {
    const unique = [...new Set(summary.otherTools)];
    sections.push("", `**Other tools used:** ${unique.join(", ")}`);
  }
  return sections.join("\n");
}

function createFallbackBuckets(): FallbackBuckets {
  return { fileChanges: [], commands: [], reads: [], searches: [], otherTools: [] };
}

function addFallbackRecord(summary: FallbackBuckets, record: SubagentToolCallRecord): void {
  switch (record.toolName) {
    case "edit":
    case "write": {
      const path = stringField(record.input, "path");
      if (path) summary.fileChanges.push(`- ${record.toolName}: \`${path}\``);
      return;
    }
    case "bash": {
      const command = stringField(record.input, "command");
      if (command) {
        const shown = command.slice(0, FALLBACK_COMMAND_CHARS);
        summary.commands.push(`- \`${shown}${command.length > FALLBACK_COMMAND_CHARS ? "..." : ""}\``);
      }
      return;
    }
    case "read": {
      const path = stringField(record.input, "path");
      if (path) summary.reads.push(`- \`${path}\``);
      return;
    }
    case "search":
    case "list": {
      const pattern = stringField(record.input, "pattern");
      const path = stringField(record.input, "path");
      const detail = pattern ?? path;
      if (detail) summary.searches.push(`- ${record.toolName}: \`${detail}\``);
      return;
    }
    default:
      summary.otherTools.push(record.toolName);
  }
}
