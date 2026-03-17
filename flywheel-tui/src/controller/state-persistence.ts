/**
 * StatePersistence interface — abstracts state file management.
 *
 * The work path uses FileStatePersistence (file-backed with locking);
 * non-work workflows pass `undefined` (no persistence).
 */

import type { ParsedStateFile } from "../state/reader";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface StatePersistence {
  /**
   * Load existing state or create initial state from plan content.
   */
  load(planContent: string): ParsedStateFile;

  /**
   * Update a phase's status in the state file.
   * Optionally appends to the error log on failure.
   */
  updatePhase(
    state: ParsedStateFile,
    phaseIndex: number,
    status: "completed" | "pending" | "in_progress",
    errorMessage?: string,
  ): void;

  /**
   * Get key decisions from the state file.
   */
  getKeyDecisions(state: ParsedStateFile): string[];
}
