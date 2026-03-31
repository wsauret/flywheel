import { CLEAN_JSON_EXAMPLE } from "../../shared/plan-schemas";

export const PLAN_CONSOLIDATE_SYNTHESIS = `### Synthesis Principles

1. **Merge findings INTO steps.** Review findings belong in the step's description and acceptanceCriteria.
2. **P1 findings are mandatory.** Every P1 must be incorporated.
3. **P2 findings are strongly recommended.** Incorporate unless deferred with rationale.
4. **P3 findings are optional.** Incorporate useful ones, defer others.
5. **Resolve ALL open questions.** Document rationale in decisions.
6. **Preserve test-first intent.** acceptanceCriteria should be testable.
7. **No orphaned assertions.** Every behavioralContract assertion must be claimed by exactly one step.
8. **Each step = one subprocess (context-clearing boundary).** Every step spawns an independent AI worker with a blank context window. Split only when clearing context helps (e.g., fresh perspective for unrelated work). Keep activities in the same step when they need awareness of what was just done (running tests, auditing related code, smoke-testing) — losing context forces the worker to rediscover everything.`;

export const PLAN_CONSOLIDATE_QUALITY_CHECKS = `### Quality Checks

- [ ] Every P1 finding is incorporated into a step
- [ ] Every P2 finding is incorporated or deferred with rationale
- [ ] All open questions are resolved
- [ ] No \`review\` fields remain on any step
- [ ] No \`openQuestions\` field at the top level
- [ ] Every behavioralContract assertion is claimed by exactly one step
- [ ] Steps are ordered so dependencies flow forward
- [ ] Valid JSON — no trailing commas, no comments`;

export { CLEAN_JSON_EXAMPLE };
