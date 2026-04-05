export const debugFixEvaluationCriteria =
  "Fix applied with references documenting the change";

export const FIX_LOOP_RULES = `## Fix Loop Rules

1. **Minimum change principle:** The fix should be as small as possible. If your fix is >5 lines, explain why a smaller fix isn't possible.
2. **No shotgun debugging:** Do not change multiple things at once hoping one works. Fix the root cause.
3. **Changes accumulate:** Do not stash or revert between iterations. Each fix builds on the previous state.
4. **One fix per iteration:** Make one logical change, then verify. If it doesn't work, understand why before the next attempt.`;

export const FIX_ITERATION_TEMPLATE = `## Fix Iteration Template

For each fix attempt:

\`\`\`
### Attempt N

**Hypothesis:** <what you think is wrong>
**Change:** <what you're changing and why>
**File(s):** <file:line references>
**Verification:** <command run and its output>
**Result:** PASS / FAIL
**Next step:** <if FAIL, what the output tells you>
\`\`\``;
