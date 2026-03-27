/**
 * Behavioral validation prompt template.
 *
 * Generates the prompt for behavioral validation steps that are auto-injected
 * at milestone boundaries (after scrutiny). Instructs the worker to:
 *
 * 1. Read the validation contract and identify assertions from completed
 *    steps' `fulfills` fields
 * 2. Verify each assertion's behavioral description independently
 *    (not trusting prior self-reports)
 * 3. Update `validation-state.json` with pass/fail/blocked per assertion
 *
 * On re-run (when `priorResults` is provided), only failed/blocked/pending
 * assertions are re-validated; previously passed assertions are skipped.
 *
 * Adapted from multi-agent mission system behavioral validation patterns.
 *
 * Fulfills: VAL-EXEC-005, VAL-EXEC-006, VAL-EXEC-010, VAL-CROSS-006
 */

import type { StepInfo } from "../../controller/step-provider.js";
import type { AssertionStatus } from "../../schemas/validation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single assertion from the validation contract.
 */
export interface ContractAssertion {
  /** Assertion ID (e.g., "VAL-AUTH-001") */
  id: string;
  /** Short title describing the assertion */
  title: string;
  /** Full behavioral description of the expected behavior */
  description: string;
  /** Expected evidence type (e.g., "unit test output (bun test)") */
  evidence: string;
}

/**
 * Context needed to build a behavioral validation prompt.
 */
export interface BehavioralValidationContext {
  /** Name of the milestone being validated */
  milestoneName: string;
  /** Assertions to validate (extracted from validation contract) */
  assertions: ContractAssertion[];
  /** Path to validation-state.json (for update instructions) */
  validationStatePath: string;
  /** Project working directory */
  projectCwd?: string;
  /**
   * Prior validation results keyed by assertion ID.
   * When provided (re-run), only failed/blocked/pending assertions
   * are re-validated; passed assertions are skipped.
   */
  priorResults?: Record<string, Pick<AssertionStatus, "status"> & { lastChecked?: string; evidence?: string }>;
}

// ---------------------------------------------------------------------------
// Utility: Collect assertion IDs from steps' fulfills
// ---------------------------------------------------------------------------

/**
 * Collect all unique assertion IDs from completed steps belonging
 * to a specific milestone.
 *
 * Only includes steps that:
 * 1. Belong to the given milestone
 * 2. Have status "completed"
 * 3. Have a non-empty `fulfills` array
 *
 * Returns deduplicated assertion IDs in insertion order.
 *
 * @param steps - All steps (from step provider)
 * @param milestoneName - The milestone to collect assertions for
 * @returns Deduplicated array of assertion IDs
 */
export function collectAssertionsForMilestone(
  steps: readonly StepInfo[],
  milestoneName: string,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const step of steps) {
    if (step.milestone !== milestoneName) continue;
    if (step.status !== "completed") continue;
    if (!step.fulfills) continue;

    for (const id of step.fulfills) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }

  return ids;
}

// ---------------------------------------------------------------------------
// Utility: Filter assertions for re-validation
// ---------------------------------------------------------------------------

/**
 * Result of filtering assertions for re-validation.
 */
export interface RevalidationFilter {
  /** Assertions that need to be (re-)validated */
  toValidate: ContractAssertion[];
  /** Assertions that already passed (can be skipped) */
  alreadyPassed: ContractAssertion[];
}

/**
 * Filter assertions based on prior validation results.
 *
 * On first run (no prior results): all assertions need validation.
 * On re-run: only assertions with status "failed", "blocked", or "pending"
 * need re-validation. "passed" assertions are skipped.
 *
 * Assertions not present in prior results are treated as needing validation.
 *
 * @param assertions - All assertions to potentially validate
 * @param priorResults - Prior validation results (or undefined for first run)
 * @returns Filtered assertions split into toValidate and alreadyPassed
 */
export function filterAssertionsForRevalidation(
  assertions: readonly ContractAssertion[],
  priorResults: Record<string, Pick<AssertionStatus, "status">> | undefined,
): RevalidationFilter {
  if (!priorResults) {
    return {
      toValidate: [...assertions],
      alreadyPassed: [],
    };
  }

  const toValidate: ContractAssertion[] = [];
  const alreadyPassed: ContractAssertion[] = [];

  for (const assertion of assertions) {
    const prior = priorResults[assertion.id];
    if (prior && prior.status === "passed") {
      alreadyPassed.push(assertion);
    } else {
      toValidate.push(assertion);
    }
  }

  return { toValidate, alreadyPassed };
}

// ---------------------------------------------------------------------------
// Assertion list section
// ---------------------------------------------------------------------------

/**
 * Build the section listing assertions to validate.
 */
function buildAssertionListSection(
  assertions: ContractAssertion[],
  label: string,
  instruction: string,
): string {
  if (assertions.length === 0) {
    return "";
  }

  const sections: string[] = [];
  sections.push(`## ${label}`);
  sections.push("");
  sections.push(instruction);
  sections.push("");

  for (const assertion of assertions) {
    sections.push(`### ${assertion.id}: ${assertion.title}`);
    sections.push("");
    sections.push(`**Behavioral Description:** ${assertion.description}`);
    sections.push("");
    sections.push(`**Evidence Required:** ${assertion.evidence}`);
    sections.push("");
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Re-validation section
// ---------------------------------------------------------------------------

/**
 * Build the re-validation context section showing prior results.
 */
function buildRevalidationSection(
  toValidate: ContractAssertion[],
  alreadyPassed: ContractAssertion[],
  priorResults: Record<string, Pick<AssertionStatus, "status"> & { evidence?: string }>,
): string {
  const sections: string[] = [];

  sections.push("## Re-Validation Mode");
  sections.push("");
  sections.push(
    "This is a **re-validation run**. Prior validation results exist. " +
    "Only re-check assertions that previously failed, were blocked, or are still pending. " +
    "Do NOT re-check assertions that already passed — their results are preserved.",
  );
  sections.push("");

  // Show passed assertions (for context, not re-checking)
  if (alreadyPassed.length > 0) {
    sections.push("### Previously Passed (skip these)");
    sections.push("");
    for (const assertion of alreadyPassed) {
      const prior = priorResults[assertion.id];
      const evidence = prior?.evidence ? ` — ${prior.evidence}` : "";
      sections.push(`- ✅ **${assertion.id}**: ${assertion.title} (passed${evidence})`);
    }
    sections.push("");
  }

  // Show assertions needing re-check
  if (toValidate.length > 0) {
    sections.push("### Needs Re-Check");
    sections.push("");
    for (const assertion of toValidate) {
      const prior = priorResults[assertion.id];
      const status = prior?.status ?? "pending";
      const evidence = prior?.evidence ? ` — ${prior.evidence}` : "";
      const icon = status === "failed" ? "❌" : status === "blocked" ? "🚫" : "⏳";
      sections.push(`- ${icon} **${assertion.id}**: ${assertion.title} (${status}${evidence})`);
    }
    sections.push("");
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the complete behavioral validation prompt.
 *
 * Adapted from multi-agent mission system behavioral validation patterns.
 *
 * @param ctx - Behavioral validation context
 * @returns Complete prompt string
 */
export function buildBehavioralValidationPrompt(ctx: BehavioralValidationContext): string {
  const { milestoneName, assertions, validationStatePath, projectCwd, priorResults } = ctx;

  const sections: string[] = [];

  // Header
  sections.push(`# Behavioral Validation: ${milestoneName}`);
  sections.push("");
  sections.push(
    `You are validating milestone "${milestoneName}". Your job is to independently verify ` +
    `that each assertion from the validation contract is satisfied by the current codebase.`,
  );
  sections.push("");
  sections.push(
    "**CRITICAL: Do not trust prior self-reports from implementation steps.** " +
    "Independently verify each assertion by examining the actual code, running tests, " +
    "or checking behaviors. Worker claims of \"tests pass\" or \"feature works\" must be " +
    "independently confirmed with real evidence.",
  );

  // Working directory
  if (projectCwd) {
    sections.push("");
    sections.push("## Working Directory");
    sections.push("");
    sections.push(`\`${projectCwd}\``);
  }

  // Determine whether this is a re-validation run
  const isRevalidation = priorResults && Object.keys(priorResults).length > 0;
  const { toValidate, alreadyPassed } = filterAssertionsForRevalidation(assertions, priorResults);

  // Re-validation context
  if (isRevalidation && priorResults) {
    sections.push("");
    sections.push(buildRevalidationSection(toValidate, alreadyPassed, priorResults));
  }

  // Assertions to validate
  if (toValidate.length > 0) {
    sections.push("");
    sections.push(
      buildAssertionListSection(
        toValidate,
        isRevalidation ? "Assertions to Re-Validate" : "Assertions to Validate",
        isRevalidation
          ? "Re-check each of the following assertions. These previously failed, were blocked, or are pending."
          : "Verify each of the following assertions independently. For each assertion, collect evidence that confirms or refutes the behavioral description.",
      ),
    );
  } else if (assertions.length > 0) {
    // All passed on re-validation
    sections.push("");
    sections.push("## All Assertions Previously Passed");
    sections.push("");
    sections.push(
      "All assertions for this milestone have already passed in a prior validation run. " +
      "No re-validation needed. Report success.",
    );
  } else {
    // No assertions at all
    sections.push("");
    sections.push("## No Assertions Found");
    sections.push("");
    sections.push(
      `No testable assertions were found for milestone "${milestoneName}". ` +
      "This may indicate that steps in this milestone did not specify `fulfills` annotations. " +
      "Report success (nothing to validate).",
    );
  }

  // Verification protocol
  sections.push("");
  sections.push("## Verification Protocol");
  sections.push("");
  sections.push("For **each assertion**, follow this protocol:");
  sections.push("");
  sections.push("1. **Read** the behavioral description and evidence requirements.");
  sections.push("2. **Plan** how to verify it (which files to check, which tests to run, which commands to execute).");
  sections.push("3. **Execute** the verification plan. Run actual commands, read actual files.");
  sections.push("4. **Evaluate** the evidence. Does it confirm the assertion?");
  sections.push("5. **Record** the result:");
  sections.push("   - **pass** — Evidence confirms the assertion is satisfied.");
  sections.push("   - **fail** — Evidence shows the assertion is NOT satisfied. Include what's wrong.");
  sections.push("   - **blocked** — Cannot verify (e.g., service unavailable, test infrastructure broken). Include the blocker.");
  sections.push("");

  // Update validation-state.json instructions
  sections.push("## Update Validation State");
  sections.push("");
  sections.push(`After verifying each assertion, update \`${validationStatePath}\` with the results.`);
  sections.push("");
  sections.push("The file uses this JSON format:");
  sections.push("```json");
  sections.push("{");
  sections.push('  "assertions": {');
  sections.push('    "VAL-EXAMPLE-001": {');
  sections.push('      "status": "passed",');
  sections.push('      "lastChecked": "2026-03-25T10:00:00Z",');
  sections.push('      "evidence": "Tests pass: bun test output shows 50 passing, 0 failing"');
  sections.push("    }");
  sections.push("  }");
  sections.push("}");
  sections.push("```");
  sections.push("");
  sections.push("Status values: `passed`, `failed`, `blocked`.");
  sections.push("Always set `lastChecked` to the current ISO timestamp.");
  sections.push("Always provide `evidence` describing what you observed.");
  sections.push("");
  if (isRevalidation) {
    sections.push(
      "**Important:** Only update assertions you re-checked. " +
      "Do not modify previously passed assertions — their results are preserved.",
    );
    sections.push("");
  }

  // Results summary
  sections.push("## Results Summary");
  sections.push("");
  sections.push("After completing all assertion checks, provide a summary:");
  sections.push("");
  sections.push("1. **Total assertions checked:** N");
  sections.push("2. **Passed:** N (list IDs)");
  sections.push("3. **Failed:** N (list IDs with reasons)");
  sections.push("4. **Blocked:** N (list IDs with blockers)");
  sections.push("5. **Overall verdict:** Pass (all checked assertions passed) or Fail (any failed/blocked)");

  return sections.join("\n");
}
