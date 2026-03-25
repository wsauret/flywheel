/**
 * ApprovalHandler interface — abstracts the manual verification gate.
 *
 * Work path uses UIApprovalHandler (UI-backed approval with modal);
 * non-work workflows pass `undefined` (no approval gates, auto-proceed).
 */

import type { EvaluatorIssue } from "../schemas/handoff";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ApprovalHandler {
  /**
   * Request approval for a phase.
   *
   * Resolves `true` if approved (proceed), `false` if rejected (stop).
   * Implementations may auto-approve based on configuration or session-level
   * skip flags.
   */
  requestApproval(phaseIndex: number, title: string): Promise<boolean>;

  /**
   * Request approval due to blocking evaluator issues.
   *
   * Called when the evaluator returns blocking issues (even if passed:true).
   * The issues array contains ONLY the blocking issues. The user can decide
   * to continue (true) or stop (false).
   *
   * Implementations should surface each issue's description string to the user.
   * When no approval handler is present, blocking issues always halt the pipeline.
   */
  requestIssueApproval?(
    phaseIndex: number,
    title: string,
    issues: EvaluatorIssue[],
  ): Promise<boolean>;

  /**
   * Whether all remaining gates should be skipped (session-level).
   * Set to `true` when the user clicks "Skip" in the approval modal.
   */
  readonly skipRemainingGates: boolean;
}
