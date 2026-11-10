## Plan Review Orchestration

A plan or implementation spec is a review target before code exists. Its reviewers compose `plan-review`, its locations are plan-scope, `<phase_id>` or `<phase_id>/<task_id>`, and its material claims include every runtime-behavior premise a task, constraint, or completion check depends on. The following rule applies on top of the shared dispatch and synthesis method when findings are integrated back into the plan.

### Full sweep after integration

After integrating arbitrated findings into the plan, walk the whole merged plan once, including content no reviewer flagged, and ask of every element whether it is design-cited or codebase-cited. Demote unjustified guards to `Deferred hardening:` constraints, collapse scenario permutations to the canonical variant, and delete criteria that restate phase verification. Specialist-driven defensive complexity that survived individual finding triage is removed here and never reaches the implementation. Note design-cited hardening that would otherwise fail the concrete-trigger test as advisory for the user, who can amend the design; nobody else questions it. Never weaken the user's verbatim constraint.
