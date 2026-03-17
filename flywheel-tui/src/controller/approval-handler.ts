/**
 * ApprovalHandler interface — abstracts the manual verification gate.
 *
 * Work path uses UIApprovalHandler (UI-backed approval with modal);
 * non-work workflows pass `undefined` (no approval gates, auto-proceed).
 */

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
   * Whether all remaining gates should be skipped (session-level).
   * Set to `true` when the user clicks "Skip" in the approval modal.
   */
  readonly skipRemainingGates: boolean;
}
