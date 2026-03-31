/**
 * Sprint evaluator prompt — adversarial quality enforcer.
 *
 * Reviews BOTH implementation quality AND verification script rigor.
 * Detects script weakening across iterations. Provides dual-channel
 * actionable feedback. Does NOT bias toward passing.
 *
 * Must NOT use the standard SubprocessEvaluatorTransport system prompt
 * which contains "Bias Toward Passing".
 */

import { renderEvaluatorHandoffInstruction } from "../../handoff/field-specs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SprintEvaluatorInput {
  taskDescription: string;
  iterationNumber: number;
  maxIterations: number;
  workerHandoff: {
    summary: string;
    artifacts?: { files_created?: string[]; files_modified?: string[] };
    verification?: { tests_passed: boolean | null; test_output_summary?: string };
    verification_script_path?: string;
  };
  verificationResult: {
    stdout: string;
    stderr: string;
    exitCode: number;
    passed: boolean;
  };
  currentScriptContent: string;
  previousScripts?: string[];
  handoffPath: string;
}

// ---------------------------------------------------------------------------
// System prompt — adversarial, no bias-toward-passing
// ---------------------------------------------------------------------------

/**
 * Adversarial system prompt for sprint evaluator.
 * Does NOT contain "Bias Toward Passing" or "When in doubt, pass".
 */
export const SPRINT_EVALUATOR_SYSTEM_PROMPT =
  "You are an adversarial evaluator for sprint mode. Your job is to find problems, " +
  "not rubber-stamp work. You assess both implementation correctness AND verification " +
  "script rigor. Be thorough and critical. When in doubt, FAIL with detailed feedback.";

/**
 * Sprint-specific evaluator addendum — appended to the base evaluator system prompt
 * when running sprint queues. Contains adversarial instructions for dual-channel
 * assessment (implementation quality + verification script rigor) and script
 * weakening detection. Does NOT duplicate the base evaluator prompt.
 */
export const SPRINT_EVALUATOR_ADDENDUM = [
  "",
  "## Sprint Mode: Adversarial Evaluation",
  "",
  "You are evaluating a sprint iteration. Be adversarial — your job is to find problems,",
  "not rubber-stamp work. When in doubt, FAIL with detailed, actionable feedback.",
  "",
  "### Dual-Channel Assessment",
  "",
  "You must assess TWO dimensions. Both must pass for the overall evaluation to pass.",
  "",
  "**1. Implementation Quality**",
  "- Does the implementation correctly fulfill the task requirements?",
  "- Are there bugs, missing error handling, or incomplete features?",
  "- Does the code follow project conventions and best practices?",
  "- Are tests present and meaningful?",
  "",
  "**2. Verification Script Quality**",
  "- Does the verification script test actual runtime behavior (not just compilation or file existence)?",
  "- Does the script cover the key acceptance criteria?",
  "- Does the script test error cases, not just the happy path?",
  "- Is the exit code correctly mapped (0=pass, non-zero=fail)?",
  "",
  "### Script Weakening Detection",
  "",
  "**CRITICAL:** If verification scripts from previous iterations are available, compare them.",
  "If the worker has weakened the script to make it pass, you MUST FAIL the evaluation.",
  "",
  "Weakening includes:",
  "- Assertions removed or commented out",
  "- Assertions trivialized (e.g., checking for any response instead of specific status)",
  "- Error case tests removed",
  "- Exit code logic changed to always pass",
  "- Try/catch blocks that swallow failures silently",
  "",
  "The correct approach is to fix the implementation to satisfy the assertions,",
  "NOT to weaken the assertions to match a broken implementation.",
].join("\n");

// ---------------------------------------------------------------------------
// Main prompt builder
// ---------------------------------------------------------------------------

/**
 * Builds the adversarial sprint evaluator prompt.
 *
 * Dual assessment: implementation quality + script rigor.
 * Script weakening detection via previous script comparison.
 * Iteration-aware context.
 */
export function buildSprintEvaluatorPrompt(input: SprintEvaluatorInput): string {
  const {
    taskDescription,
    iterationNumber,
    maxIterations,
    workerHandoff,
    verificationResult,
    currentScriptContent,
    previousScripts,
    handoffPath,
  } = input;

  const sections: string[] = [];

  // ── Task context ──────────────────────────────────────────────
  sections.push(
    "## Task Context",
    "",
    taskDescription,
    "",
  );

  // ── Iteration info ────────────────────────────────────────────
  sections.push(
    `## Iteration ${iterationNumber} of ${maxIterations}`,
    "",
  );

  // ── Worker handoff ────────────────────────────────────────────
  sections.push(
    "## Worker Summary",
    "",
    workerHandoff.summary,
    "",
  );

  if (workerHandoff.artifacts) {
    const created = workerHandoff.artifacts.files_created ?? [];
    const modified = workerHandoff.artifacts.files_modified ?? [];
    if (created.length > 0 || modified.length > 0) {
      sections.push("## Artifacts", "");
      if (created.length > 0) {
        sections.push("Files created:", ...created.map((f) => `- ${f}`));
      }
      if (modified.length > 0) {
        sections.push("Files modified:", ...modified.map((f) => `- ${f}`));
      }
      sections.push("");
    }
  }

  if (workerHandoff.verification) {
    sections.push(
      "## Worker Test Results",
      `Tests passed: ${workerHandoff.verification.tests_passed === null ? "unknown" : workerHandoff.verification.tests_passed ? "yes" : "no"}`,
    );
    if (workerHandoff.verification.test_output_summary) {
      sections.push(workerHandoff.verification.test_output_summary);
    }
    sections.push("");
  }

  // ── Verification result ───────────────────────────────────────
  sections.push(
    "## Verification Script Result",
    "",
    `Exit code: ${verificationResult.exitCode} (${verificationResult.passed ? "PASSED" : "FAILED"})`,
    "",
  );

  if (verificationResult.stdout) {
    sections.push("stdout:", "```", verificationResult.stdout, "```", "");
  }
  if (verificationResult.stderr) {
    sections.push("stderr:", "```", verificationResult.stderr, "```", "");
  }

  // ── Current verification script source ────────────────────────
  sections.push(
    "## Current Verification Script",
    "",
    "```",
    currentScriptContent,
    "```",
    "",
  );

  // ── Previous scripts (for weakening detection) ────────────────
  if (previousScripts && previousScripts.length > 0) {
    sections.push(
      "## Previous Verification Scripts (for comparison)",
      "",
      "Compare the current script against these previous versions to detect weakening.",
      "",
    );

    previousScripts.forEach((script, i) => {
      sections.push(`### Iteration ${i + 1} Script`, "", "```", script, "```", "");
    });
  }

  // ── Adversarial assessment instructions ───────────────────────
  sections.push(
    "## Assessment Instructions",
    "",
    "You are an adversarial evaluator. Your job is to find problems, not rubber-stamp work.",
    "When in doubt, FAIL with detailed, actionable feedback.",
    "",
    "### Dual-Channel Assessment",
    "",
    "You must assess TWO dimensions. Both must pass for the overall evaluation to pass.",
    "",
    "**1. Implementation Quality**",
    "- Does the implementation correctly fulfill the task requirements?",
    "- Are there bugs, missing error handling, or incomplete features?",
    "- Does the code follow project conventions and best practices?",
    "- Are tests present and meaningful?",
    "",
    "**2. Verification Script Quality**",
    "- Does the script test actual runtime behavior (not just compilation or file existence)?",
    "- Does the script cover the key acceptance criteria?",
    "- Does the script test error cases, not just the happy path?",
    "- Does the script produce meaningful output?",
    "- Is the exit code correctly mapped (0=pass, non-zero=fail)?",
    "",
  );

  // ── Script weakening detection ────────────────────────────────
  if (previousScripts && previousScripts.length > 0) {
    sections.push(
      "### Script Weakening Detection",
      "",
      "**CRITICAL:** Compare the current verification script against the previous versions above.",
      "If the worker has weakened the script to make it pass, you MUST FAIL the evaluation.",
      "",
      "Weakening includes:",
      "- Assertions that were removed or commented out",
      "- Assertions that were trivialized (e.g., checking for any response instead of specific status)",
      "- Error case tests that were removed",
      "- Exit code logic that was changed to always pass",
      "- Try/catch blocks that swallow failures silently",
      "",
      "The correct approach is to fix the implementation to satisfy the assertions,",
      "NOT to weaken the assertions to match a broken implementation.",
      "",
    );
  }

  // ── Output format ─────────────────────────────────────────────
  sections.push(
    "## Output Format",
    "",
    "Respond with valid JSON matching this schema:",
    "",
    "```json",
    "{",
    '  "passed": boolean,',
    '  "reasoning": "string — overall assessment",',
    '  "implementation_feedback": "string — specific, actionable feedback on the implementation",',
    '  "script_feedback": "string — specific, actionable feedback on the verification script",',
    '  "suggestions": ["string — improvement suggestions"],',
    '  "confidence": 0.0-1.0,',
    '  "feedback": "string — combined feedback for the worker retry prompt",',
    '  "files_to_review": ["string — file paths"],',
    '  "issues": [{"description": "string", "severity": "blocking"|"non_blocking", "category": "test_failure"|"type_error"|"security"|"regression"|"incomplete"|"other"}]',
    "}",
    "```",
    "",
    "- `passed`: Set to `true` ONLY if BOTH implementation quality AND script quality are acceptable.",
    "- `implementation_feedback`: Specific issues with the implementation. Reference files and lines when possible.",
    "- `script_feedback`: Specific issues with the verification script. Reference what assertions are missing or weak.",
    "- `feedback`: Combined summary of both channels for the worker's retry prompt.",
    "- `issues`: Structured issues found. Use `blocking` severity for must-fix items.",
    "",
    "### When to FAIL",
    "",
    "- Implementation does not fulfill the task requirements",
    "- Verification script is trivial or does not test runtime behavior",
    "- Verification script was weakened compared to previous iterations",
    "- Implementation has bugs that the verification script should catch but doesn't",
    "- Test failures or type errors reported by the worker",
    "",
    "### When to PASS",
    "",
    "- Implementation correctly fulfills the task",
    "- Verification script rigorously tests the implementation's runtime behavior",
    "- Script has not been weakened from previous iterations",
    "- No blocking issues remain",
    "",
  );

  // ── Evaluator handoff instruction ─────────────────────────────
  sections.push(renderEvaluatorHandoffInstruction(handoffPath));

  return sections.join("\n");
}
