import type { AdapterType } from "./types";
import type { FlywheelEvent } from "../../events/types";
import { BaseUIAdapter } from "./base";

/**
 * ConsoleAdapter — prints events to stdout/stderr as they arrive.
 *
 * Handles stream-json NDJSON lines from claude/opencode by extracting
 * displayable text content. Temporary adapter until the full OpenTUI
 * adapter is built.
 */
export class ConsoleAdapter extends BaseUIAdapter {
  readonly adapterType: AdapterType = "mock"; // reuse type until "console" is added

  /** Buffer for incomplete NDJSON lines across chunks */
  private stdoutLineBuf = "";

  protected handleEvent(event: FlywheelEvent): void {
    switch (event.type) {
      case "workflow:started":
        console.log(`\n▶ Workflow started: ${event.planPath}`);
        break;

      case "workflow:completed":
        console.log(`\n✓ Workflow completed`);
        break;

      case "workflow:failed":
        console.error(`\n✗ Workflow failed: ${event.reason}`);
        break;

      case "workflow:interrupted":
        console.warn(`\n⚠ Workflow interrupted: ${event.reason}`);
        break;

      case "phase:started":
        this.stdoutLineBuf = "";
        console.log(`\n── Phase ${event.phaseIndex + 1}: ${event.phaseName} ──`);
        break;

      case "phase:completed":
        console.log(`\n   ✓ Phase ${event.phaseIndex + 1} completed`);
        break;

      case "phase:failed":
        console.error(`\n   ✗ Phase ${event.phaseIndex + 1} failed: ${event.reason}`);
        break;

      case "worker:spawned":
        console.log(`   ⏳ Worker spawned (phase ${event.phaseIndex + 1})`);
        break;

      case "worker:completed": {
        const dur = (event.result.durationMs / 1000).toFixed(1);
        const trunc = event.result.truncated ? " [truncated]" : "";
        console.log(`   ✓ Worker completed in ${dur}s${trunc}`);
        break;
      }

      case "worker:failed":
        console.error(`   ✗ Worker failed: ${event.failure.message}`);
        break;

      case "worker:retrying":
        console.warn(`   ↻ Retrying (${event.attempt}/${event.maxAttempts}): ${event.reason}`);
        break;

      case "worker:output":
        this.handleWorkerOutput(event.stream, event.data);
        break;

      case "approval:requested":
        console.log(`   ? Approval requested for phase ${event.phaseIndex + 1}`);
        break;

      case "approval:received":
        console.log(`   ${event.approved ? "✓" : "✗"} Approval ${event.approved ? "granted" : "denied"}${event.skipped ? " (auto)" : ""}`);
        break;

      // Dispatcher/evaluator/step events — silent for now
      case "dispatcher:invoked":
      case "evaluator:invoked":
      case "step:started":
      case "dispatcher:completed":
      case "evaluator:completed":
      case "step:completed":
      case "step:failed":
        break;

      case "dispatcher:failed":
        console.error(`   ✗ Dispatcher failed: ${event.reason}`);
        break;

      case "evaluator:failed":
        console.error(`   ✗ Evaluator failed: ${event.reason}`);
        break;
    }
  }

  /**
   * Handle worker output chunks. Parses stream-json NDJSON lines and
   * extracts displayable text. Falls back to raw output for non-JSON.
   */
  private handleWorkerOutput(stream: "stdout" | "stderr", data: string): void {
    if (stream === "stderr") {
      process.stderr.write(data);
      return;
    }

    // Buffer lines — chunks may split across NDJSON line boundaries
    this.stdoutLineBuf += data;
    const lines = this.stdoutLineBuf.split("\n");
    // Last element is incomplete (or empty if data ended with \n)
    this.stdoutLineBuf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const text = extractDisplayText(trimmed);
      if (text) {
        process.stdout.write(text);
      }
    }
  }
}

/**
 * Extract displayable text from a stream-json NDJSON line.
 *
 * Handles claude stream-json format:
 * - {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}}
 * - {"type":"result","result":"..."}
 *
 * Returns null for non-displayable lines (system init, etc).
 * Falls back to raw text for non-JSON input.
 */
function extractDisplayText(line: string): string | null {
  // Try to parse as JSON
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON — output raw (plain text mode)
    return line + "\n";
  }

  const type = parsed.type as string | undefined;

  // assistant message — extract text content
  if (type === "assistant") {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = message?.content as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "tool_use") {
          texts.push(formatToolUse(block));
        }
      }
      return texts.length > 0 ? texts.join("") : null;
    }
  }

  // result — extract final result text
  if (type === "result") {
    const result = parsed.result as string | undefined;
    if (typeof result === "string" && result.length > 0) {
      return result + "\n";
    }
  }

  // system, tool_result, etc — skip
  return null;
}

/**
 * Format a tool_use content block for console display.
 */
function formatToolUse(block: Record<string, unknown>): string {
  const name = block.name as string | undefined;
  if (!name) return "";

  const input = block.input as Record<string, unknown> | undefined;
  if (!input) return `  ▸ ${name}\n`;

  // Extract the most useful detail per tool type
  const detail = getToolDetail(name, input);
  return detail ? `  ▸ ${name}: ${detail}\n` : `  ▸ ${name}\n`;
}

/**
 * Extract a short, useful detail string from tool input.
 */
function getToolDetail(name: string, input: Record<string, unknown>): string | null {
  switch (name) {
    case "Read":
      return truncate(input.file_path as string, 80);
    case "Write":
      return truncate(input.file_path as string, 80);
    case "Edit": {
      const fp = input.file_path as string | undefined;
      return fp ? truncate(fp, 80) : null;
    }
    case "Bash": {
      const cmd = input.command as string | undefined;
      return cmd ? truncate(cmd, 100) : null;
    }
    case "Glob":
      return truncate(input.pattern as string, 80);
    case "Grep":
      return truncate(input.pattern as string, 80);
    case "Agent":
    case "Task": {
      const prompt = input.prompt as string | undefined;
      const desc = input.description as string | undefined;
      return truncate(desc ?? prompt, 100);
    }
    case "WebFetch":
      return truncate(input.url as string, 100);
    case "TodoWrite":
      return null; // not interesting
    default: {
      // For unknown tools, show first string-valued key
      for (const val of Object.values(input)) {
        if (typeof val === "string" && val.length > 0) {
          return truncate(val, 80);
        }
      }
      return null;
    }
  }
}

function truncate(s: string | undefined | null, max: number): string | null {
  if (!s) return null;
  // Collapse to single line
  const oneLine = s.replace(/\n/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}
