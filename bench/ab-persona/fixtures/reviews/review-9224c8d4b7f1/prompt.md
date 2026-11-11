Review this completed change.

CHANGE:
Uncommitted edits in `src/agent-skills/ship/SKILL.md`, `src/agent-skills/worktree-lifecycle/SKILL.md`, and `AGENTS.md` (run `git diff -- <path>` for each). In AGENTS.md, only the concurrent-agents hard-rule bullet, the new "Keep local `main` at `origin/main`" bullet after it, and the "Repository publication is delegated work" paragraph belong to this change; the "Every client surface ... stays mounted" paragraph is another agent's concurrent edit, so ignore it.

PROJECT CONTEXT PATHS:
AGENTS.md; docs/adrs/adr-021-design-intent-and-the-first-draft.md

ASSIGNED CLAIMS (verify each with the narrowest tool you already hold before writing findings; report the check-derived evidence; add material claims this list missed):
1. ship step 5: "the merge exit code does not identify autostash conflicts". Evidence the parent observed with Git 2.49 in a throwaway repo: `git merge --ff-only --autostash origin/main` printed "Applying autostash resulted in conflicts. Your changes are safe in the stash." and exited 0, with the conflicted file at status UU and the cleanly applied files staged.
2. ship step 5: `git diff --name-only --diff-filter=U` lists the paths left unresolved by a conflicted autostash apply.
3. ship and worktree-lifecycle text stays repository-agnostic (these are reusable skills shipped under src/agent-skills/).

DESIGN CONTEXT:
- Design intent (fixed):
  1. Purpose: Local `main` always stays at `origin/main`. Each agent that publishes brings in newer remote commits and resolves overlaps itself as part of its own commit. A separate catch-up task is never needed. If this conflicts with keeping verification strictly before publication, keeping local main current wins, and the caller re-runs its narrow check afterward.
  2. Feature set: (a) The rule, stated once in AGENTS.md (near the concurrent-agents hard rule): local main stays at the remote tip, and every committing agent integrates remote work itself, before its final verification and again at publication. (b) Ship skill step 5: replace "stop when a newer remote commit changes a selected file" with "integrate": fetch, `git merge --autostash <push target>` (fast-forward when possible), find conflicts with `git diff --name-only --diff-filter=U`, resolve each so both sides' intent survives, unstage what autostash staged, drop the autostash entry only after every file is resolved, commit and push as today; when integration changed a selected file, the report names it so the caller re-runs its narrow verification and fixes forward, never reverts. (c) Worktree case: when an agent advances the remote destination from a worktree, it brings the local checkout of that branch (found with `git worktree list`) to the new tip with the same method; in Ship (its own push) and in worktree-lifecycle (the integration step the parent owns).
  3. Key decisions: Git's native `--autostash`, not a hand-rolled per-file merge. Ship is the single owner of the integration method; other guidance points to it and does not restate it.
  4. Non-goals: no new script or tool; no ADR change; no change to whole-file staging rules.
  5. Constraints: Ship and worktree-lifecycle stay repository-agnostic; Flywheel-specific "local main" wording stays in AGENTS.md. Not a manual `checkout HEAD -- file` plus `git merge-file` (it missed a rename and briefly cleared other agents' edits). Not stopping on overlap (it left main 39 commits behind). The "never stash" rule gets one narrow exception for Git's transient `--autostash` during integration.
  6. Verification: commit-message validator, `bun run lint`, tests that pin skill text (tests/unit/workflows/built-in-skills.test.ts passed, 37/37; lint passed).
- implementation design (revisable): wording and placement within each file.
- patterns: these files are terse numbered rule lists in ASD-STE100 Simplified Technical English, no em dashes.
- constraints: as above.
- recorded deviations: none from the implementer. The parent then realigned worktree-lifecycle step 4 back to "fetch the destination and rebase onto its tip" (the implementer had replaced the rebase with Ship's merge method, which would change a feature branch from rebase to merge and orphan step 3's range-diff rule), merged ship step 3's doubled exception into one sentence, and simplified the unstage sentence in step 5.

Check the change against the Design intent and the authorities in PROJECT CONTEXT PATHS as well as for defects. A contradiction with an authority is drift; cite its file and line. Look especially for remaining contradictions inside each file (for example, rules elsewhere in ship or worktree-lifecycle that still say to stop, never stash, or that Git refuses) and between the three files. Classify each recorded deviation and each discrepancy you find as consistent with the Design intent or as drift, with evidence; a deviation from implementation design alone is not drift. Report the classification and do not decide whether a deviation is acceptable.

Use code-scope locations: <repo-relative-path> or <repo-relative-path>:<line>.
Investigate ambiguous, incomplete, or unverified evidence with targeted commands or mechanism verification before reporting it. Throwaway Git probes belong under .flywheel/scratch. Do not write files in the repository. Return prose findings, one block each with Title, Severity, Location, Failure, and Fix, or state No findings.

Before assessing your domain, read the project context paths listed below that bear on this change's files and domain; skip paths with no bearing on it. Mandatory elegance applies to every domain; do not defer structural judgment to another reviewer.

Required output discipline:
1. Reviewers emit prose findings, one block per finding with these parts: Title, Severity, Location, Failure, Fix. Do NOT emit JSON. Flag an ambiguity as `OPEN QUESTION:`.
2. Locations are always concrete.
3. Format each Failure as four slots: `**Failure:** <Principle name>. <Intent>. <Observation>. <Reasoning>.`
4. Each Fix MUST propose the elegant alternative concretely.
5. Preserve every runtime-behavior claim you cannot verify with an `UNVERIFIED` tag.
6. The Design intent binds you; never propose an alternative to it. A finding that contradicts a documented rejection must explain why the rejection no longer holds, or it is suppressed.
7. Hardening findings name their trigger; otherwise cap at P3.