/**
 * FlywheelShell Types
 *
 * Types for the persistent shell's internal state.
 */

import type { WorkflowStatus } from "../routes/work/state/types"

/** Current state of the shell prompt */
export type ShellState = "idle" | "working" | "completed"

/** A single workflow run tracked by the shell */
export interface WorkflowRun {
  id: string
  planName: string
  status: WorkflowStatus
  startTime: number
  endTime?: number
}
