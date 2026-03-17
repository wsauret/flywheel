/**
 * Plan import service.
 *
 * Orchestrates plan ingestion from either a file path or pasted text.
 * Resolves content, normalizes line endings, runs structural validation
 * via `validatePlan()`, and returns a `PlanImportResult` with status,
 * parsed phases, issues, and a summary.
 *
 * The content hash (SHA-256) can be stored in session JSON for plan
 * change detection between sessions.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  validatePlan,
  hasAcceptanceCriteria,
  type PlanPhase,
} from "./plan-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanImportResult {
  status: "ready" | "needs-fix";
  phases: PlanPhase[];
  issues: string[];
  summary: {
    phaseCount: number;
    totalSteps: number;
    hasAcceptanceCriteria: boolean;
    contentHash: string;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import a plan from either a file path or raw text content.
 *
 * @param source - Raw plan text (string) or `{ filePath: string }` to read from disk
 * @returns PlanImportResult with status, phases, issues, and summary
 */
export async function importPlan(
  source: string | { filePath: string },
): Promise<PlanImportResult> {
  const rawContent = await resolveContent(source);

  // Normalize CRLF -> LF
  const content = rawContent.replace(/\r\n/g, "\n");

  // Structural validation (uses parsePlan internally)
  const validation = validatePlan(content);

  // Compute content hash for change detection
  const contentHash = crypto
    .createHash("sha256")
    .update(content)
    .digest("hex");

  const totalSteps = validation.phases.reduce(
    (sum, phase) => sum + phase.steps.length,
    0,
  );

  const summary = {
    phaseCount: validation.phases.length,
    totalSteps,
    hasAcceptanceCriteria: hasAcceptanceCriteria(content),
    contentHash,
  };

  if (validation.ok) {
    return {
      status: "ready",
      phases: validation.phases,
      issues: [],
      summary,
    };
  }

  // TODO: LLM evaluator integration — when status is "needs-fix", a future
  // implementation will call an LLM to assess the plan, suggest fixes, and
  // prompt the user for missing sections. For now, we just return the issues.

  return {
    status: "needs-fix",
    phases: validation.phases,
    issues: validation.issues,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function resolveContent(
  source: string | { filePath: string },
): Promise<string> {
  if (typeof source === "string") {
    return source;
  }

  // Read from file path
  return fs.readFileSync(source.filePath, "utf-8");
}
