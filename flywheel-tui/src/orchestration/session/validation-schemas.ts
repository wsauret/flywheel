/**
 * Validation state schema for assertion tracking.
 *
 * Defines the Zod schema for `validation-state.json`, which tracks
 * assertion pass/fail/blocked status across milestones.
 *
 * Adapted from multi-agent mission system validation patterns.
 *
 * Schema:
 * ```json
 * {
 *   "assertions": {
 *     "VAL-AUTH-001": {
 *       "status": "pending" | "passed" | "failed" | "blocked",
 *       "lastChecked": "2026-03-25T10:00:00Z",  // optional ISO string
 *       "evidence": "Tests pass, login works"     // optional
 *     }
 *   }
 * }
 * ```
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Assertion status enum
// ---------------------------------------------------------------------------

const AssertionStatusEnum = z.enum([
  "pending",
  "passed",
  "failed",
  "blocked",
]);

type AssertionStatusValue = z.infer<typeof AssertionStatusEnum>;

// ---------------------------------------------------------------------------
// Individual assertion status
// ---------------------------------------------------------------------------

export const AssertionStatusSchema = z.object({
  /** Current status of the assertion */
  status: AssertionStatusEnum,
  /** ISO timestamp of when this assertion was last checked */
  lastChecked: z.string().optional(),
  /** Evidence or reason for the current status */
  evidence: z.string().optional(),
});

type AssertionStatus = z.infer<typeof AssertionStatusSchema>;

// ---------------------------------------------------------------------------
// Full validation state (the top-level document)
// ---------------------------------------------------------------------------

export const ValidationStateSchema = z.object({
  /** Map of assertion ID → status */
  assertions: z.record(z.string(), AssertionStatusSchema),
});

export type ValidationState = z.infer<typeof ValidationStateSchema>;
