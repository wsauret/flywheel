---
description: Read-only evidence and findings method for one code review.
disable-model-invocation: true
dependencies:
  - elegance-review-principles
---

# Individual Code Review Method

{{if:type:reviewer}}
Review only the supplied implementation against the original request or settled design. This package defines an individual review, not parent orchestration. When assigned an individual review: Do not dispatch reviewers, combine other reviewers' findings, edit code, or fix findings. Return evidence to the caller and stop. A composing parent skill owns orchestration and continuation separately.
{{else}}
Review only the supplied implementation against the original request or settled design. This package defines an individual review, not parent orchestration. When assigned an individual review: Do not dispatch agents, combine findings of other reviews, edit code, or fix findings. Return evidence to the caller and stop. A composing parent skill owns orchestration and continuation separately.
{{end}}

## Establish the target

Read required behavior, non-goals, constraints, and acceptance criteria. The section labeled Design intent is the fixed tier the user approved; everything else the brief supplies, such as the plan's shape, file lists, and planned approach, is implementation design the author was free to revise. Get the actual diff. A file list or implementation report is not a diff; state the limitation when only changed-file evidence is available. Read changed files where hunks hide context, then trace affected callers, imports, registrations, and tests. Inspect deletions for live paths whose logic disappeared. Stay within the supplied change and applicable project context.

## Apply the review

Apply the composed elegance principles throughout. Additional loaded specialist principles constrain the same evidence, locations, severity, and result.

Check intent fidelity first. Read the change against the Design intent and classify each recorded deviation and each discrepancy you find as consistent with it or as drift, with evidence. A deviation from implementation design alone is never drift. Lead a drift finding with the principle name `Intent Drift`, at P1 when required behavior is missing or a non-goal was built, so the caller sees it at a glance. Report the classification; whether a deviation is acceptable is the caller's decision, not yours.

Then check complete acceptance behavior, correctness, regressions, error behavior, type contracts, boundary validation, meaningful tests, caller compatibility, naming, cohesion, maintainability, unfinished markers, necessary additions, and safe deletions. Judge tests in both directions: a missing behavioral test is a finding, and so is an added test that duplicates an existing owner's assertion, cannot fail for the reason its name states, or exercises a copy, a source spelling, a restated constant, or a mock that implements the asserted behavior.

Every finding names a concrete path and line and explains what fails, under which input or condition, and why it matters. A claim about ordering, reachability, races, crashes, subprocess survival, or durability requires a traced code path. Preserve unresolved claims as `UNVERIFIED` with the evidence checked and exact missing proof. Do not treat plausibility as evidence.

For an unresolved behavioral premise, tag it `UNVERIFIED`; the caller owns verification before accepting the finding. Live acceptance of the running product belongs to UAT.

## Result

Return `Findings:` with one block per actionable issue: Title, Severity, Location, Failure, Fix. Failure states the principle, intent, observed discrepancy, and consequence. Fix proposes the smallest complete correction. Order by severity:

- P1 (critical): broken required behavior, reachable regression or data loss, security boundary failure, or unmet acceptance.
- P2 (major): concrete defect, structural debt, missing behavioral tests, or an unsafe assumption with a real trigger.
- P3 (minor): bounded correctness or elegance improvement supported by evidence, including a redundant or vacuous test, never style preference or hypothetical hardening. A redundant test that forces a test-only production seam is P2.

Return `Clean:` with the target and evidence only when no actionable finding remains. Return `Blocked:` with missing intent, diff, access, or decisive evidence and the narrowest action needed. Do not emit workflow handoffs or continue into implementation.
