/**
 * Multi-perspective verification checklist for task completion.
 *
 * Before the agent confirms task completion, it must evaluate its work
 * from multiple professional perspectives to catch gaps.
 */

/**
 * Generates a multi-perspective verification checklist that the model
 * must evaluate before confirming task completion.
 *
 * @param handoff - The handoff JSON submitted by the agent (stringified for display)
 */
export function getCompletionChecklist(handoff: unknown): string {
  const handoffPreview = JSON.stringify(handoff, null, 2).slice(0, 500);

  return `Before confirming task completion, verify your work from each perspective:

[1] Test Engineer
- Are all relevant tests passing?
- Did you run the test suite and verify the output?
- Are there new tests covering the changes you made?

[2] QA Engineer
- Are edge cases handled (empty inputs, large inputs, invalid data)?
- Is error handling robust and informative?
- Could any changes break existing functionality?

[3] User
- Does the output match what was originally requested?
- Is the solution complete, or are there unfinished pieces?
- Would the user be satisfied with this result?

[4] Flywheel
- Does the handoff JSON match the expected schema?
- Are all required fields present and correctly populated?
- Is the summary accurate and concise?

Handoff preview:
${handoffPreview}

FINAL CHECK: Review each perspective above and confirm all items are addressed. If anything is incomplete, fix it now. If everything looks good, call task_complete again to confirm.`;
}
