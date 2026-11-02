---
description: Use when reviewing a settled design or implementation plan before code exists.
dependencies:
  - elegance-review-principles
---

# Plan Review

Review a settled design or implementation plan. Do not create the design, implement code, or choose product decisions that the plan leaves open.

## Establish the target

1. Read the originating request or settled design. Record requirements, non-goals, constraints, acceptance criteria, and explicit decisions. If these are unavailable, return a design blocker rather than inventing them.
2. Read the complete plan. Identify its milestones, tasks, files, API or schema changes, tests, verification, dependencies, and delivery boundaries.
3. Ground concrete claims in the repository. Verify named files and existing surfaces, and trace planned API changes through callers, imports, registrations, and tests. A plan location is `<milestone_id>` or `<milestone_id>/<task_id>`.
4. Preserve approved outcomes, constraints, and explicit user decisions. If evidence proves a user commitment impossible or unsafe, report the conflict rather than changing it. Treat implementation choices as hypotheses that evidence may support, narrow, or reject. Review the implementation shape, not the settled product intent.

## Apply the review

Apply `elegance-review-principles` first and throughout. Then apply every additional loaded `*-review-principles` skill to the same plan and repository evidence. Those lenses add constraints; they do not replace this target method, severity, locations, or result contract.

Baseline plan quality covers requirement and non-goal coverage, implementability, dependency order, ownership and boundary fit, call-site and API impact, changed behavior tests, regression coverage, milestone-sized verification, runnable final acceptance, and whether every task earns its place. Flag missing design decisions as blockers. Do not silently decide them.

Review scope asymmetrically. Accept evidence-backed reductions and simpler substitutions that preserve every approved outcome and constraint. Admit additional work only when concrete evidence shows it is the smallest sufficient addition needed for the approved outcome. An independently useful improvement belongs outside the plan. Reducing scope never means dropping required behavior or verification.

## Evidence and behavioral premises

Every finding names a plan location and cites the plan text or repository evidence that establishes the discrepancy and consequence. Ambiguous or missing evidence does not clear the plan.

When the dispatch prompt carries an assigned claim checklist, verify every assigned claim with the narrowest tool you already hold before writing findings, report the check-derived evidence with each claim, and add any material claim the checklist missed. Evidence for a weaker claim does not verify a stronger claim.

Tag runtime claims about ordering, reachability, races, crashes, subprocess survival, or durability as `UNVERIFIED` until traced. State the exact claim and preserve available evidence. Do not resolve it from plausibility. The caller owns any separate mechanism verification.

## Severity

- **P1 (critical):** the plan cannot deliver a requirement, contradicts a user commitment, crosses an unsafe boundary, or lacks a required implementation or proof path.
- **P2 (major):** a concrete gap in impact analysis, decomposition, tests, verification, or maintainable structure should be corrected before implementation.
- **P3 (minor):** a bounded correctness or elegance improvement with concrete evidence. Do not report style preference or hypothetical hardening.

## Result

Return `Findings:` with one block per issue containing `Title`, `Severity`, `Location`, `Failure`, and `Fix`; `Clean:` with the reviewed plan and evidence; or `Blocked:` with the missing design input or repository evidence and the narrowest unblocking action. Corrections must preserve settled intent and use the smallest complete plan shape.

Do not select reviewers, fan out work, synthesize other reviewers, integrate findings into an artifact, emit a typed handoff, or review implemented code.