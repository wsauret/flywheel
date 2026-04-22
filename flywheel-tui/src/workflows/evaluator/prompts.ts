import type { EvaluatorInput } from "./schemas.js";

const EVALUATOR_SYSTEM_PROMPT =
  "You are a verification agent. Read the worker's output, check each acceptance criterion, " +
  "and write a JSON verdict. You have tools — use them when a claim is worth verifying " +
  "(e.g., run the test command the worker reported, read a file the worker claims to have created). " +
  "Write the verdict file once you have enough evidence to decide.";

export function buildEvaluatorSystemPrompt(addendum?: string): string {
  return addendum
    ? `${EVALUATOR_SYSTEM_PROMPT}\n\n${addendum}`
    : EVALUATOR_SYSTEM_PROMPT;
}

export function buildEvaluatorPrompt(input: EvaluatorInput): string {
  const sections: string[] = [];

  if (input.task_context) {
    sections.push(`## Task\n${input.task_context}`, "");
  }

  if (input.handoff) {
    sections.push(`## Worker Summary\n${input.handoff.summary}`, "");

    if (input.handoff.verification) {
      const testStatus = input.handoff.verification.tests_passed === null ? "unknown"
        : input.handoff.verification.tests_passed ? "yes" : "no";
      sections.push(`Tests passed: ${testStatus}`);
      if (input.handoff.verification.test_output_summary) {
        sections.push(input.handoff.verification.test_output_summary);
      }
      sections.push("");
    }

    if (input.handoff.artifacts) {
      const created = input.handoff.artifacts.files_created ?? [];
      const modified = input.handoff.artifacts.files_modified ?? [];
      const all = [...created.map(f => `+ ${f}`), ...modified.map(f => `~ ${f}`)];
      if (all.length > 0) {
        sections.push(`## Artifacts\n${all.join("\n")}`, "");
      }
    }
  } else {
    sections.push(`## Worker Output\n${input.worker_output}`, "");
  }

  if (input.evaluation_criteria) {
    sections.push(`## Criteria\n${input.evaluation_criteria}`, "");
  }

  if (input.acceptance_criteria.length > 0) {
    sections.push(`## Acceptance\n${input.acceptance_criteria.map(c => `- ${c}`).join("\n")}`, "");
  }

  sections.push(
    `## Verdict`,
    "",
    "Before writing your verdict:",
    "1. Check each acceptance criterion — is it met by the worker's output?",
    "2. If the worker claims tests pass, verify: check the test output summary, or run the command if in doubt.",
    "3. Check for regressions: did the worker break anything that was working before?",
    "",
    "Fail ONLY for hard evidence: tests actually failing, secrets in code, critical deliverables missing, or fundamentally wrong output.",
    "When in doubt, pass with suggestions. Revision loops are expensive.",
  );

  return sections.join("\n");
}
