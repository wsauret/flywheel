/**
 * Handoff consumers — build structured data from worker handoff for
 * downstream consumers (dispatcher, step chaining).
 *
 * All consumers read from the same WorkerHandoff object, which is
 * parsed once after worker execution.
 */

import type { WorkerHandoff } from "./schemas";
import type { LastWorkerResult } from "../schemas/shared";

// ---------------------------------------------------------------------------
// buildLastWorkerResult — for dispatcher input
// ---------------------------------------------------------------------------

/**
 * Build a structured LastWorkerResult from a worker handoff.
 *
 * Maps handoff fields to the LastWorkerResultSchema:
 * - summary → output_summary
 * - artifacts.files_created + artifacts.files_modified → artifacts_produced
 * - verification.tests_passed → tests_passed
 * - step from stepIndex
 * - status = "completed"
 * - duration_seconds from durationMs / 1000
 */
export function buildLastWorkerResult(
  handoff: WorkerHandoff,
  stepIndex: number,
  durationMs: number,
): LastWorkerResult {
  const filesCreated = handoff.artifacts?.files_created ?? [];
  const filesModified = handoff.artifacts?.files_modified ?? [];

  return {
    step: stepIndex,
    status: "completed",
    output_summary: handoff.summary,
    artifacts_produced: [...filesCreated, ...filesModified],
    tests_passed: handoff.verification?.tests_passed ?? null,
    duration_seconds: durationMs / 1000,
    decisions: handoff.decisions ?? [],
    warnings: handoff.warnings ?? [],
    commands_run: (handoff.artifacts?.commands_run ?? []).map((c) =>
      typeof c === "string" ? c : c.command,
    ),
    files_to_review: handoff.files_to_review ?? [],
  };
}

// ---------------------------------------------------------------------------
// buildPreviousResultFromHandoff — for step chaining
// ---------------------------------------------------------------------------

/**
 * Build a clean markdown previousResult from structured handoff fields.
 *
 * Produces a compact summary from handoff instead of passing raw worker output.
 */
export function buildPreviousResultFromHandoff(handoff: WorkerHandoff): string {
  const sections: string[] = [];

  // Summary (always present)
  sections.push("## Previous Step Summary");
  sections.push(handoff.summary);

  // Decisions
  if (handoff.decisions && handoff.decisions.length > 0) {
    sections.push("");
    sections.push("### Decisions");
    for (const decision of handoff.decisions) {
      sections.push(`- ${decision}`);
    }
  }

  // Artifacts
  if (handoff.artifacts) {
    const files_created = handoff.artifacts.files_created ?? [];
    const files_modified = handoff.artifacts.files_modified ?? [];
    const commands_run = handoff.artifacts.commands_run ?? [];
    const hasArtifacts =
      files_created.length > 0 || files_modified.length > 0 || commands_run.length > 0;

    if (hasArtifacts) {
      sections.push("");
      sections.push("### Artifacts");
      if (files_created.length > 0) {
        sections.push(`- Files created: ${files_created.join(", ")}`);
      }
      if (files_modified.length > 0) {
        sections.push(`- Files modified: ${files_modified.join(", ")}`);
      }
      if (commands_run.length > 0) {
        sections.push(`- Commands run: ${commands_run.join(", ")}`);
      }
    }
  }

  // Verification
  if (handoff.verification) {
    sections.push("");
    sections.push("### Verification");
    if (handoff.verification.tests_passed !== null) {
      sections.push(
        `- Tests passed: ${handoff.verification.tests_passed ? "yes" : "no"}`,
      );
    }
    if (handoff.verification.test_output_summary) {
      sections.push(`- ${handoff.verification.test_output_summary}`);
    }
  }

  // Warnings
  if (handoff.warnings && handoff.warnings.length > 0) {
    sections.push("");
    sections.push("### Warnings");
    for (const warning of handoff.warnings) {
      sections.push(`- ${warning}`);
    }
  }

  return sections.join("\n");
}
