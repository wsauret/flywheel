export const debugInvestigateEvaluationCriteria =
  "Hypothesis formed with evidence and likelihood assessment";

export const INVESTIGATION_METHODOLOGY = `## Investigation Methodology

Follow this order:

1. **Read error output carefully.** The error message usually points to the root cause. Do not skim.
2. **Search codebase for related code.** Find the function/module where the error originates.
3. **Check recent git changes.** \`git log --oneline -10\` and \`git diff HEAD~3\` can reveal what broke it.
4. **Form a hypothesis:**

\`\`\`
Hypothesis: <summary of what you think is wrong>
Evidence: <what supports this hypothesis>
Likelihood: <high / medium / low>
\`\`\`

Only proceed to fix after forming a hypothesis. Do NOT make changes based on guesses.`;
