/**
 * Plan import types.
 *
 * Type definitions for plan ingestion results. Used by plan-confirmation
 * components and logic.
 */

import type { BehavioralAssertion } from "./parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A step in an imported plan, mapped from either JSON or markdown format. */
export interface PlanImportStep {
  /** Short action title. */
  title: string;
  /** Detailed description. */
  description: string;
  /** Testable pass/fail criteria. */
  acceptanceCriteria: string[];
  /** Files to create or modify. */
  fileReferences?: string[];
  /** Feature grouping. */
  feature?: string;
  /** Behavioral contract assertion IDs. */
  fulfills?: string[];
  /** Milestone grouping. */
  milestone?: string;
  /** Estimated complexity. */
  estimatedComplexity?: string;
}

export interface PlanImportResult {
  status: "ready" | "needs-fix";
  /** Structured steps from JSON plan. */
  steps: PlanImportStep[];
  /** Behavioral contract assertions from JSON plan. */
  behavioralContract: BehavioralAssertion[];
  /** Architectural decisions from JSON plan. */
  decisions: string[];
  /** Identified risks from JSON plan. */
  risks: string[];
  issues: string[];
  summary: {
    stepCount: number;
    totalSteps: number;
    hasAcceptanceCriteria: boolean;
    contentHash: string;
  };
  /** Whether this was imported from a JSON plan. */
  isJsonPlan: boolean;
}
