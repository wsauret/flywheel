/**
 * UIApprovalHandler — UI-backed approval gate implementation.
 *
 * Extracted from WorkExecutionLoop:324-362. Emits `approval:requested`
 * events and waits for the UI adapter's `onApprovalDecision` callback.
 *
 * Supports:
 * - Config-level auto-approve (`skip_approval_gates`)
 * - Session-level skip (user clicks "Skip" once, all future gates auto-approve)
 * - UI callback with `(approved: boolean, skip?: boolean)` signature
 */

import type { FlywheelEmitter } from "../events/event-bus";
import type { FlywheelConfig } from "../config/loader";
import type { IWorkflowUI } from "../tui/adapters/types";
import type { ApprovalHandler } from "./approval-handler";
import type { EvaluatorIssue } from "../schemas/handoff";

// ---------------------------------------------------------------------------
// UIApprovalHandler
// ---------------------------------------------------------------------------

export class UIApprovalHandler implements ApprovalHandler {
  private readonly emitter: FlywheelEmitter;
  private readonly config: FlywheelConfig;
  private readonly ui: IWorkflowUI;
  private readonly workflowId: string;

  private _skipRemainingGates = false;

  constructor(
    emitter: FlywheelEmitter,
    config: FlywheelConfig,
    ui: IWorkflowUI,
    workflowId: string,
  ) {
    this.emitter = emitter;
    this.config = config;
    this.ui = ui;
    this.workflowId = workflowId;
  }

  get skipRemainingGates(): boolean {
    return this._skipRemainingGates;
  }

  async requestIssueApproval(
    phaseIndex: number,
    title: string,
    issues: EvaluatorIssue[],
  ): Promise<boolean> {
    // Build a description string from the blocking issues
    const issueDescriptions = issues
      .map((issue) => `• [${issue.category}] ${issue.description}`)
      .join("\n");
    const description = `Phase ${phaseIndex + 1}: ${title}\n\nBlocking issues found:\n${issueDescriptions}`;

    // Delegate to the standard approval mechanism with the enriched description
    return this.requestApproval(phaseIndex, description);
  }

  async requestApproval(phaseIndex: number, title: string): Promise<boolean> {
    // Config-level auto-approve
    if (this.config.skip_approval_gates) {
      return true;
    }

    // Session-level skip (user previously clicked "Skip")
    if (this._skipRemainingGates) {
      this.emitter.approvalRequested(
        this.workflowId,
        phaseIndex,
        0,
        `Phase ${phaseIndex + 1}: ${title}`,
      );
      this.emitter.approvalReceived(this.workflowId, true, true);
      return true;
    }

    // Use the UI adapter's approval callback
    return new Promise<boolean>((resolve) => {
      const existingCallback = this.ui.onApprovalDecision;

      if (!existingCallback) {
        // No approval callback — auto-approve
        this.emitter.approvalRequested(
          this.workflowId,
          phaseIndex,
          0,
          `Phase ${phaseIndex + 1}: ${title}`,
        );
        this.emitter.approvalReceived(this.workflowId, true, true);
        resolve(true);
        return;
      }

      // Install resolver callback that will be called by the UI
      this.ui.onApprovalDecision = (approved: boolean, skip?: boolean) => {
        this.emitter.approvalReceived(this.workflowId, approved, false);

        // Handle "Skip all future gates"
        if (approved && skip) {
          this._skipRemainingGates = true;
        }

        // Restore original callback
        this.ui.onApprovalDecision = existingCallback;
        resolve(approved);
      };

      // Emit approval requested AFTER installing the callback
      this.emitter.approvalRequested(
        this.workflowId,
        phaseIndex,
        0,
        `Phase ${phaseIndex + 1}: ${title}`,
      );
    });
  }
}
