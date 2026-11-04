---
name: Code Review
description: Review completed code or a plan with right-sized specialist agents.
dependencies:
  - elegance-review-principles
agents:
  - reviewer-code-quality
  - reviewer-code-performance
  - reviewer-code-data-integrity
  - reviewer-code-security
  - reviewer-code-elegance
  - reviewer-uat
  - reviewer-code-design
  - reviewer-plan-quality
  - reviewer-plan-performance
  - reviewer-plan-data-integrity
  - reviewer-plan-security
  - reviewer-plan-elegance
  - reviewer-plan-design
  - reviewer-mechanism
  - advisor
---

# Code Review

Review a completed code change, or an implementation plan before code exists, against the request or settled design with a reviewer set sized to the actual target. This is the canonical review method after every implementation route, and for a plan that descends from a settled design.

Each reviewer's read-only evidence and findings contract comes from the individual method it composes: `code-review-method` for `reviewer-code-*`, `plan-review` for `reviewer-plan-*`. This parent skill owns dispatch and synthesis. During review, do not edit target implementation files or dispatch implementers. Complete and synthesize the review first. A review-only request ends with the report. Only when review is part of an already-authorized implementation task, leave review mode afterward, fix valid findings, and run the narrowest verification that proves each correction.

Reviewer dispatch is mandatory for every nontrivial target. A trivial target shrinks the set to one reviewer, never to zero.

## Determine the review target

1. Read the request or settled design. Record required behavior, non-goals, constraints, acceptance criteria, and applicable project context paths. Find the authorities that bind the change: read the root instructions file and the instructions file or README nearest to each changed path, and follow each authority they name for the changed area. Skip a document marked superseded or draft. Record the binding authorities as project context paths. When the repository names none, the request or settled design is the only intent source; search no further. If no intent source exists, report that blocker instead of inventing intent. The target is a first draft: the implementation recorded where it deviated from the plan or assignment, and the dispatching agent revises it into the design after this review. Reviewers therefore check the draft against the design as well as for defects and classify each recorded deviation and each discrepancy as consistent with the design or as drift, with evidence. Reviewers report; the dispatching agent decides acceptance.
2. Get the actual diff. A directory listing, file list, or implementation report is not a diff. When branch diff data is unavailable or includes unrelated concurrent work, use the current task's tracked changed files and tool write evidence, and state that limitation. For a plan target, read the complete plan instead.
3. Read changed files where hunks hide context. Trace changed public surfaces through callers, imports, registrations, and tests. Inspect deletions for live paths whose logic disappeared rather than moved.
4. Apply `elegance-review-principles` first and throughout. Additional specialist reviewers add constraints; they do not replace this method, severity model, or result contract.
5. List the target's material factual claims verbatim with their locations: version pins, artifact-content assertions, registry or feed availability, live-route statements, tool and file existence, and runtime-behavior premises the target depends on. Assign each claim to at least one reviewer. Every claim ends with one verdict from the reviewer protocol's vocabulary, and the result states exactly what the evidence supports.

## Select the reviewer set

Size the reviewer set from the target and named domain triggers before dispatching. A code change takes `reviewer-code-*` personas and a plan takes `reviewer-plan-*` personas; never mix the families.

- **Trivial tier:** a code diff roughly under 50 changed lines with no new file or abstraction, or a plan with one milestone, a handful of files, no new abstraction, and no runtime-behavior claim, when no optional trigger below matches. Dispatch `reviewer-code-elegance` or `reviewer-plan-elegance` alone. It owns structural fit and design elegance, and at plan granularity subsumes the structural half of the quality lens. With one reviewer, synthesis is integrate-or-defer per finding.
- **Standard tier:** every other target. Dispatch `reviewer-code-quality` and `reviewer-code-elegance`, or `reviewer-plan-quality` and `reviewer-plan-elegance`. Add an optional reviewer only when its named trigger matches:
- `reviewer-code-performance` or `reviewer-plan-performance`: hot paths, loops over unbounded data, queries, large data volumes, latency-sensitive code, or heavy I/O; also a plan of three or more milestones.
- `reviewer-code-data-integrity` or `reviewer-plan-data-integrity`: migrations, schemas, data models, persistence, durable state, or transactional logic; also a plan of three or more milestones.
- `reviewer-code-security` or `reviewer-plan-security`: secrets or credentials, authentication or authorization, untrusted input, command, subprocess, or shell execution, or path and file handling.
- `reviewer-code-design` or `reviewer-plan-design`: a rendered interface, including webview or TUI components, style sheets, layout, theming, interaction states, or user-facing copy. The plan variant judges design coverage in the plan and needs no pre-implementation render.
- `reviewer-uat`, code only: an explicit acceptance requirement needs direct observation, or verification leaves a specific user-facing behavior unproven. A changed CLI, UI, HTTP route, or output format alone is not a trigger. A live acceptance check requires fresh observation; past captures guide the scenario but do not prove the current behavior.

Never add an untriggered reviewer, or omit a triggered one.

## Dispatch reviewers

Dispatch every selected reviewer in parallel. When you can launch a workflow file, run them as one workflow in the Review shape of `workflow-authoring`. Use self-contained prompts and never `fork: true`. Inline the target, project context paths, design rationale, constraints, assigned claims, and location format. Include this instruction; for a plan target, name the plan and plan-scope locations instead:

```text
Review this completed change.

CHANGE:
[diff or changed-file paths]

PROJECT CONTEXT PATHS:
[applicable paths or none]

ASSIGNED CLAIMS (verify each with the narrowest tool you already hold before writing findings; report the check-derived evidence; add material claims this list missed):
[the claims assigned to this reviewer, verbatim, with locations, or none assigned]

DESIGN CONTEXT:
- Design intent (fixed): use the approved intent and decisions that the runtime carries from the parent's checkpoint.
- implementation design (revisable): [the spec shape, illustrative detail, and planned approach the implementer could revise]
- patterns: [established patterns]
- constraints: [user requirements, rejected alternatives, and Deferred entries]
- recorded deviations: [the implementation's recorded deviations from the plan or assignment, each with its stated reason, or none]

Check the change against the Design intent and the authorities in PROJECT CONTEXT PATHS as well as for defects. A contradiction with an authority is drift; cite its file and line. Classify each recorded deviation and each discrepancy you find as consistent with the Design intent or as drift, with evidence; a deviation from implementation design alone is not drift. Report the classification and do not decide whether a deviation is acceptable.

Use code-scope locations: <repo-relative-path> or <repo-relative-path>:<line>.
Investigate ambiguous, incomplete, or unverified evidence with targeted commands or mechanism verification before reporting it. If evidence remains unavailable, name the checks attempted, the missing proof, and the concrete failure mode. Do not pass the evidence gap to an implementer. Do not write files. Return prose findings, one block each with Title, Severity, Location, Failure, and Fix, or state No findings.

Apply the constraint rules in the reviewer protocol block to the supplied user requirements, rejected alternatives, and Deferred entries.

Failure must state a recognized principle, intended behavior, observed discrepancy, and concrete consequence. A hardening finding must name the reachable producer or requirement that triggers the risk. Preserve runtime claims that remain unresolved with an UNVERIFIED tag.
```

For `reviewer-uat`, provide changed paths without source content, acceptance criteria, and runnable verification commands. Tell it not to inspect source, to use observable locations, to choose one decisive live scenario rather than the full product surface, and to stop on decisive evidence or a failed primary check.

Investigate ambiguous runtime evidence within the review budget. If an acceptance criterion still cannot be verified, report the missing evidence and the narrowest command or probe attempted. Do not defer an unverified acceptance claim to implementers.

{{ref:reviewer-protocol}}

## Synthesize

Extract and validate every finding, then deduplicate by failure meaning rather than wording. Corroboration does not raise severity. Preserve the strongest concrete evidence and one complete failure statement.

Use these severities:

- **P1:** blocks acceptance because required behavior is broken, reachable regression or data loss exists, a security boundary fails, or a required criterion is unmet.
- **P2:** a concrete defect or structural debt that must be corrected now, including missing tests for changed behavior or an unsafe assumption with a real trigger.
- **P3:** a bounded correctness or elegance improvement with concrete evidence. Drop style preferences, hypothetical hardening, optional robustness, and changes with no behavioral or structural consequence.

## Remedy arbitration

Explicit requirements and verified correctness, security, data-integrity, performance, and runtime constraints are hard gates. Among remedies that satisfy those gates, choose the simplest feature-complete correction with the fewest owners, states, layers, abstractions, and failure branches.

Do not union reviewer fixes or count votes. When several findings share one structural cause, emit one root finding and one correction. Keep independent failures separate.

A reviewer's proposal that adds scope or a larger design is a hypothesis under the approved design's evidence bar: a causal link to an approved outcome in the smallest sufficient form. A recommendation alone earns no scope.

## Drift arbitration

For a finding outside the tracked changed files, first prove that the current change modified that file. Reading or using a file is not modification evidence. Then classify the change as:

- **Principled extension:** required reuse, cohesive ownership, shared helper, test fixture, or explicit uptake of a documented deferral. Judge the finding on its merits.
- **Scope creep:** unrelated behavior, speculative abstraction, or drive-by refactor. Keep the finding and add a P2 finding titled `Out-of-scope file: <path>`.

## Review result and continuation

Conclude with one of:

- `Findings:` actionable findings ordered by severity, each with Title, Severity, Location, Failure, and Fix.
- `Clean:` the reviewed target and evidence when no actionable finding remains.
- `Blocked:` the missing intent, diff, repository access, or decisive evidence and the narrowest action that unblocks review.

After the result, list under `Set aside:` each P1 or P2 finding that you rejected or deferred, with a one-line reason; omit dropped P3 findings.

P1 findings block acceptance. For a review-only request, report and stop without editing. When the original request authorizes implementation, resume that task after the review result is complete: fix valid findings, verify each correction with the smallest complete check, and do not rerun the whole review unless the correction materially changes the design or creates a new triggered review surface.

Group actionable findings by shared structural cause, not by file. Fix the structure once, then re-evaluate the remaining findings, which often dissolve. Do not apply reviewer fixes as isolated patches.

{{ref:plan-review-orchestration}}