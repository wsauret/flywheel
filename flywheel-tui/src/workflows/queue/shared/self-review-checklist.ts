/** The 7-item self-review checklist injected at the first turn boundary for code steps. */
export const SELF_REVIEW_CHECKLIST = `Review your changes before completing:

1. **Diff review** — scan for obvious mistakes, unused imports, missing implementations, debug/temp code
2. **Task alignment** — all requested changes present? Any files mentioned in the task you didn't touch?
3. **Completeness** — any TODOs, placeholders, half-finished pieces? If acceptance criteria exist, verify each is met.
4. **Test coverage** — did you add/update tests for new behavior?
5. **Regression check** — could your changes break existing functionality?
6. **Edge cases** — obvious error handling gaps? Inputs that would break?
7. **Elegance** — is this the simplest, most symmetric design? No unnecessary abstractions, no callback chains, no duplicated state? Would a reader say "of course" rather than "why"?

If you find issues: fix them now.
If everything looks good: confirm in your handoff.`;
