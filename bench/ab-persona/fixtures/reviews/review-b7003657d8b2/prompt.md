Review this completed change.

CHANGE (uncommitted in the working tree; other agents have unrelated uncommitted edits elsewhere, so review only these files with `git diff -- <path>`):
- src/orchestration/agent-runtime/tools/bash-mutation-guard.ts
- src/orchestration/agent-runtime/tools/bash-project-mutation.ts
- src/infra/diagnostics-registry.ts
- tests/unit/orchestration/agent-runtime/tools/bash-mutation-guard.test.ts
- tests/unit/orchestration/agent-runtime/tools/tools-bash-mutations-uncaptured.test.ts
- docs/adrs/adr-009-tool-execution-safety.md
- docs/product-intent/agent-methods.md

PROJECT CONTEXT PATHS: docs/adrs/adr-009-tool-execution-safety.md (paragraphs near lines 250-260; the guard is cooperative, a guard against mistakes, not hostile-process containment), docs/product-intent/agent-methods.md (PI-AGENT-017).

ASSIGNED CLAIMS (verify each with the narrowest tool you already hold before writing findings; report the check-derived evidence; add material claims this list missed):
1. Dropping a registered worktree that no longer exists from the Seatbelt profile, and using `--ro-bind-try` for it in bubblewrap, removes no protection from any tree that exists at profile build time, and the selected tree, its Git directories, and the ancestor-unlink rules stay intact.
2. No remaining code path runs a `mutates` command in the real project without the OS guard when the host guard is available; the only in-place path is the guard-unavailable fallback.
3. `--ro-bind-try` semantics: binds when the source exists, silently skips when it does not (implementer probed bubblewrap 0.12.0 in a container).
4. The new diagnostic records only ids, guard kind, and the error message (no command text or file content).

DESIGN CONTEXT:
- Design intent (fixed): use the approved intent and decisions that the runtime carries from the parent's checkpoint.
- implementation design (revisable): protectedRoots Map of path to "required" | "optional"; optional = registered worktrees other than realRoot and Git dirs; ENOENT on an optional root drops it.
- patterns: existing guard code in bash-mutation-guard.ts.
- constraints: keep the guard-unavailable in-place fallback (user decision 2026-10-23); do not keep an unguarded fallback for unexpected copy failures.
- recorded deviations: (a) ADR-009 paragraph near line 254 was also rewritten because it promised fail-open capture; (b) test assertions adjusted for the existing message format.

Check the change against the Design intent and the authorities in PROJECT CONTEXT PATHS as well as for defects. A contradiction with an authority is drift; cite its file and line. Classify each recorded deviation and each discrepancy you find as consistent with the Design intent or as drift, with evidence; a deviation from implementation design alone is not drift. Report the classification and do not decide whether a deviation is acceptable.

Use code-scope locations: <repo-relative-path> or <repo-relative-path>:<line>.
Investigate ambiguous, incomplete, or unverified evidence with targeted commands or mechanism verification before reporting it. If evidence remains unavailable, name the checks attempted, the missing proof, and the concrete failure mode. Do not pass the evidence gap to an implementer. Do not write files. Return prose findings, one block each with Title, Severity, Location, Failure, and Fix, or state No findings.

Apply the constraint rules in the reviewer protocol block to the supplied user requirements, rejected alternatives, and Deferred entries.

Failure must state a recognized principle, intended behavior, observed discrepancy, and concrete consequence. A hardening finding must name the reachable producer or requirement that triggers the risk. Preserve runtime claims that remain unresolved with an UNVERIFIED tag.

Before assessing your domain, read the project context paths listed below that bear on this change's files and domain; skip paths with no bearing on it. Mandatory elegance applies to every domain; do not defer structural judgment to another reviewer.

Required output discipline:
1. Reviewers emit prose findings, one block per finding with these parts: Title, Severity, Location, Failure, Fix. Do NOT emit JSON; the synthesizer structures your output. Use structured sections, paths only rather than file contents, and flag an ambiguity as `OPEN QUESTION:`.
2. Locations are always concrete: `path/to/file.ts:42-67`, never "in the auth module."
3. Format each Failure as four slots: `**Failure:** <Principle name>. <Intent>. <Observation>. <Reasoning>.` Keep the principle name the first token. If you cannot lead with a principle name, the finding is observational only: mark it P3 or suppress it.
4. Each Fix MUST propose the elegant alternative concretely, not just flag the issue.
5. Preserve every runtime-behavior claim tagged `UNVERIFIED`; do not resolve or discard it.
6. The supplied user requirements and Design intent bind you. Do not propose an alternative to the fixed intent. A finding that contradicts a documented rejection must explain why the rejection no longer holds, or it is suppressed.
7. Hardening findings name their trigger: a design requirement, or a file:line or named caller whose normal operation produces the failure. Otherwise cap at P3.