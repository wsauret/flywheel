---
description: Use when decomposing an approved design into dependency-ordered milestones with per-milestone verification.
---

# Implementation Planning

Turn one approved design into milestones, each with its own proof, ordered so that independent milestones run at the same time. This package owns the decomposition method only; it does not write code, run tests, or own any artifact format.

## Milestones

- Give each milestone one purpose and one independently verifiable outcome.
- Size each milestone for one implementer agent in one run. A write set past roughly ten files, production code bundled with corpus or fixture regeneration, or code bundled with ADR or instruction rewrites is evidence that the milestone needs a real dependency split.
- Put shared foundations before their consumers, and state the exact surface each later milestone consumes instead of coupling milestones through unstated internals. A milestone that cannot pass checks without its consumer belongs with that consumer, not behind an approval request or a temporary lint exception.
- Give each milestone its prerequisites: the milestones whose output it consumes, or `None.` Then group the milestones into waves. A wave holds every milestone whose prerequisites are in earlier waves and whose files do not overlap the files of another milestone in the same wave. Two milestones that change the same file go in different waves. The order in which milestones commit is not a prerequisite.
- Keep tests with the feature-bearing milestone they prove. Do not defer all testing to a final milestone.
- Name concrete repository-relative production and test files, relevant symbols, exact changes, callers, wiring, migration or compatibility effects, and dependencies. A path that an earlier milestone creates is that milestone's output, not an existing path to verify.
- Treat milestone file lists as grounded expected-touch evidence, not a permission boundary, unless an explicit settled constraint makes them a hard boundary. Include transitive callers for API, schema, route, event, export, or configuration changes.
- If one change requires scattered edits across four or more components, reconsider the ownership or shared abstraction before accepting the scatter.

## Scenarios and verification

- Give each feature-bearing task explicit test file paths and scenario sentences that state input, behavior, and expected output. Cover requested behavior and justified failure branches. Use one canonical scenario per behavior; add a variant only when it exercises a distinct branch or call site, or the design names it. If no meaningful scenario can be stated, investigate until it can.
- Every milestone has the narrowest fresh runnable command that proves its outcome: a focused test file, a type or schema smoke check, or a small script, never a full-suite command unless nothing narrower can prove the milestone. When one command cannot prove a rendered or live surface, pair a minimal smoke command with a qualitative check judged from captured evidence. Never leave milestone verification empty and do not repeat global gates in every milestone.
- Never append `|| true` to a verification command, and never prefix the `timeout` shell utility, which is absent on macOS; bound a slow command with the bash tool's timeout parameter.
- Keep global acceptance separate: full suites, lint, boundary checks after file moves or additions, live entrypoint checks, cross-milestone behavior, and qualitative criteria. Every global criterion proves a settled requirement or an integration property that milestone-local checks cannot prove; do not restate milestone verification as global acceptance. Include at least one elegance criterion anchored to the rejected shape, `No instance of <rejected-shape> in <scope>.`, or a universal such as "No new helper added without first searching for an existing one." or "No line whose removal would not change behavior."
