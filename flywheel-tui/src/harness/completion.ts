/**
 * Double-confirm completion state machine.
 *
 * The agent must call task_complete twice:
 * 1. First call: validates handoff and returns a verification checklist
 * 2. Second call: confirms completion after review
 */

import { WorkerHandoffSchema } from "../protocol/handoff-schemas.js";
import { getCompletionChecklist } from "./verification.js";

export type CompletionResult =
  | { status: "pending"; checklist: string }
  | { status: "confirmed"; handoff: object }
  | { status: "error"; message: string };

type CompletionState = "idle" | "pending" | "confirmed";

/**
 * Manages the double-confirm workflow for task completion.
 *
 * First call with valid handoff transitions to `pending` and returns
 * the verification checklist. Second call with valid handoff transitions
 * to `confirmed`.
 */
export class CompletionStateMachine {
  private state: CompletionState = "idle";
  private pendingHandoff: object | undefined;

  /** Process a task_complete call with the given handoff data. */
  handleTaskComplete(handoff: unknown): CompletionResult {
    const parsed = WorkerHandoffSchema.safeParse(handoff);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      return {
        status: "error",
        message: `Invalid handoff:\n${issues.join("\n")}`,
      };
    }

    if (this.state === "idle") {
      this.state = "pending";
      this.pendingHandoff = parsed.data;
      return {
        status: "pending",
        checklist: getCompletionChecklist(parsed.data),
      };
    }

    if (this.state === "pending") {
      this.state = "confirmed";
      this.pendingHandoff = parsed.data;
      return {
        status: "confirmed",
        handoff: parsed.data,
      };
    }

    // Already confirmed — treat as re-confirmation
    return {
      status: "confirmed",
      handoff: parsed.data,
    };
  }

  /** Whether the task has been fully confirmed. */
  isComplete(): boolean {
    return this.state === "confirmed";
  }

  /** Whether we are awaiting the second confirmation. */
  isPending(): boolean {
    return this.state === "pending";
  }

  /** Reset to idle state for reuse. */
  reset(): void {
    this.state = "idle";
    this.pendingHandoff = undefined;
  }
}
