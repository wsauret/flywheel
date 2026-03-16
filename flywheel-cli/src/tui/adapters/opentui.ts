/**
 * OpenTUI Adapter
 *
 * Translates FlywheelEvent → UIActions (store mutations).
 * Uses assertNever for exhaustive switch — adding a new event type
 * without a case here causes a compile-time error.
 *
 * Timer service integration: converts phase indexes to string IDs
 * ("phase-0", "phase-1", …) for the agent-based timer API.
 */

import type { FlywheelEvent } from "../../events/types";
import { assertNever } from "../../events/types";
import type { AdapterType } from "./types";
import { BaseUIAdapter } from "./base";
import type { UIActions } from "../routes/work/context/ui-state/types";
import { timerService } from "../shared/services/timer";
import { extractDisplayText } from "./output-formatter";

export interface OpenTUIAdapterOptions {
  actions: UIActions;
}

export class OpenTUIAdapter extends BaseUIAdapter {
  readonly adapterType: AdapterType = "opentui";
  private actions: UIActions;

  /** Buffer for incomplete NDJSON lines across stdout chunks */
  private stdoutLineBuf = "";

  /** When true, pass raw output without NDJSON parsing */
  private _rawMode = false;

  constructor(options: OpenTUIAdapterOptions) {
    super();
    this.actions = options.actions;
  }

  /** Toggle raw output mode. Returns the new state. */
  toggleRawMode(): boolean {
    this._rawMode = !this._rawMode;
    return this._rawMode;
  }

  /** Check if raw mode is enabled. */
  get rawMode(): boolean {
    return this._rawMode;
  }

  protected handleEvent(event: FlywheelEvent): void {
    switch (event.type) {
      case "workflow:started":
        timerService.reset();
        timerService.start();
        this.actions.startWorkflow(event.planPath);
        break;

      case "workflow:completed":
        timerService.stop();
        this.actions.stopWorkflow("completed");
        break;

      case "workflow:failed":
        timerService.stop();
        this.actions.setError(event.reason);
        break;

      case "workflow:interrupted":
        timerService.stop();
        this.actions.stopWorkflow("interrupted");
        break;

      case "phase:started":
        // Dynamic phase discovery: if phase doesn't exist yet, add it
        if (event.phaseIndex >= this.actions.getState().phases.length) {
          this.actions.addPhase({
            index: event.phaseIndex,
            name: event.phaseName,
          });
        }
        this.stdoutLineBuf = "";
        timerService.registerAgent(`phase-${event.phaseIndex}`);
        this.actions.startPhase(event.phaseIndex, event.phaseName);
        break;

      case "phase:completed":
        timerService.completeAgent(`phase-${event.phaseIndex}`);
        this.actions.completePhase(event.phaseIndex);
        break;

      case "phase:failed":
        timerService.completeAgent(`phase-${event.phaseIndex}`);
        this.actions.failPhase(event.phaseIndex, event.reason);
        break;

      case "worker:output":
        this.handleWorkerOutput(event.stream, event.data, event.timestamp);
        break;

      case "worker:retrying":
        this.actions.appendOutput({
          stream: "stdout",
          data: `↻ Retrying (${event.attempt}/${event.maxAttempts}): ${event.reason}\n`,
          timestamp: event.timestamp,
        });
        break;

      case "approval:requested":
        this.actions.setApprovalPending(event.description);
        break;

      case "approval:received":
        this.actions.clearApproval();
        break;

      // Worker lifecycle events
      case "worker:spawned":
        this.actions.appendOutput({
          stream: "stdout",
          data: `◉ Worker spawned for step ${event.stepIndex}\n`,
          timestamp: event.timestamp,
        });
        break;

      case "worker:completed":
        this.actions.appendOutput({
          stream: "stdout",
          data: `◉ Worker finished\n`,
          timestamp: event.timestamp,
        });
        break;

      case "worker:failed":
        this.actions.appendOutput({
          stream: "stderr",
          data: `◉ Worker failed: ${event.failure.message}\n`,
          timestamp: event.timestamp,
        });
        break;

      // Step events
      case "step:started":
        this.actions.appendOutput({
          stream: "stdout",
          data: `▸ Step ${event.stepIndex}: ${event.description}\n`,
          timestamp: event.timestamp,
        });
        break;

      case "step:completed":
        this.actions.appendOutput({
          stream: "stdout",
          data: `✓ Step ${event.stepIndex} complete\n`,
          timestamp: event.timestamp,
        });
        break;

      case "step:failed":
        this.actions.appendOutput({
          stream: "stderr",
          data: `✗ Step ${event.stepIndex} failed: ${event.reason}\n`,
          timestamp: event.timestamp,
        });
        break;

      // Dispatcher events
      case "dispatcher:invoked":
        this.actions.appendOutput({
          stream: "stdout",
          data: `⚡ Dispatcher: crafting prompt for step ${event.stepIndex}...\n`,
          timestamp: event.timestamp,
        });
        break;

      case "dispatcher:completed":
        this.actions.appendOutput({
          stream: "stdout",
          data: `⚡ Dispatcher: prompt ready\n`,
          timestamp: event.timestamp,
        });
        break;

      case "dispatcher:failed":
        this.actions.appendOutput({
          stream: "stderr",
          data: `⚠ Dispatcher failed: ${event.reason}. Using static template.\n`,
          timestamp: event.timestamp,
        });
        break;

      // Evaluator events
      case "evaluator:invoked":
        this.actions.appendOutput({
          stream: "stdout",
          data: `🔍 Evaluator: checking output quality...\n`,
          timestamp: event.timestamp,
        });
        break;

      case "evaluator:completed":
        this.actions.appendOutput({
          stream: "stdout",
          data: `🔍 Evaluator: ${event.result.passed ? "passed" : "needs revision"} — ${event.result.reasoning}\n`,
          timestamp: event.timestamp,
        });
        break;

      case "evaluator:failed":
        this.actions.appendOutput({
          stream: "stderr",
          data: `⚠ Evaluator failed: ${event.reason}. Skipping.\n`,
          timestamp: event.timestamp,
        });
        break;

      default:
        assertNever(event);
    }
  }

  /**
   * Handle worker output chunks. In formatted mode, buffers NDJSON lines
   * and extracts displayable text (same logic as ConsoleAdapter).
   * In raw mode, passes chunks through unfiltered.
   */
  private handleWorkerOutput(
    stream: "stdout" | "stderr",
    data: string,
    timestamp: string,
  ): void {
    // stderr always passes through directly
    if (stream === "stderr") {
      this.actions.appendOutput({ stream, data, timestamp });
      return;
    }

    // Raw mode: pass through without parsing
    if (this._rawMode) {
      this.actions.appendOutput({ stream, data, timestamp });
      return;
    }

    // Formatted mode: buffer lines and extract display text
    this.stdoutLineBuf += data;
    const lines = this.stdoutLineBuf.split("\n");
    // Last element is incomplete (or empty if data ended with \n)
    this.stdoutLineBuf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const text = extractDisplayText(trimmed);
      if (text) {
        this.actions.appendOutput({ stream, data: text, timestamp });
      }
    }
  }
}

/** Factory function for creating an OpenTUI adapter */
export function createOpenTUIAdapter(actions: UIActions): OpenTUIAdapter {
  return new OpenTUIAdapter({ actions });
}
