import type { AdapterType } from "./types";
import type { FlywheelEvent } from "../../events/types";
import { BaseUIAdapter } from "./base";
import { extractDisplayText } from "./output-formatter";

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

// Display text extraction functions are in ./output-formatter.ts
