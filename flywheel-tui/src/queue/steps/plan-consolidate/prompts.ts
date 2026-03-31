const CLEAN_JSON_EXAMPLE = `{
  "steps": [
    {
      "title": "Create server module with Bun.serve()",
      "description": "Implement GET /hello endpoint. Bind to 127.0.0.1:3000 (per security review).",
      "acceptanceCriteria": [
        "GET /hello returns 200 with JSON body",
        "Server binds to 127.0.0.1:3000 (not 0.0.0.0)"
      ],
      "fileReferences": ["src/server/index.ts", "tests/server.test.ts"],
      "feature": "server",
      "fulfills": ["BC-SERVER-001"],
      "milestone": "Foundation",
      "estimatedComplexity": "low"
    }
  ],
  "behavioralContract": [
    {
      "id": "BC-SERVER-001",
      "title": "Hello endpoint returns greeting",
      "description": "GET /hello returns 200 with greeting and timestamp",
      "evidence": "curl http://localhost:3000/hello returns 200",
      "area": "Server"
    }
  ],
  "decisions": [
    "Using Bun.serve() native API",
    "Bind to 127.0.0.1 per security review"
  ],
  "risks": [
    "Port 3000 may conflict with other services"
  ]
}`;

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
