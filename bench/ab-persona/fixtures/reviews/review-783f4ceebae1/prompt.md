Review this completed change.

CHANGE (working tree; other agents edit this tree concurrently, so judge only these files and use `git diff -- <file>` or read new files directly):
- New: docs/architecture-intent/README.md and its 15 domain files; docs/guides/elegance.md; docs/terminology.md; scripts/check-intent-corpora.ts; tests/unit/scripts/check-intent-corpora.test.ts.
- Changed: AGENTS.md; src/orchestration/modules/development/definitions/skills/flywheel-design/SKILL.md; scripts/check-terminology.ts; scripts/check-doc-coherence.ts; scripts/lint-parallel.ts; package.json (lint:intent); docs/product-intent/README.md and appended statements in docs/product-intent/*.md; README.md; docs/architecture.md; src/orchestration/agent-runtime/compaction/stale-tool-result-masker.ts.
- About 480 other files had ADR-NNN citations in comments retargeted to ARCH-/PI-/UPD- IDs. A per-batch check already reviewed those; sample about 15 of them across src/, tests/, webview/, vscode/ (`rg -n "ARCH-[A-Z]+-[0-9]{3}" src | head -200` finds them) and confirm the cited statement owns the claim.
- Not yet done, by plan: docs/adrs/ is still present and will be deleted in the same commit, after which `bun run scripts/check-intent-corpora.ts` must pass. Run it now and ignore failures inside docs/adrs/ itself. A separate adjudication of 81 contradicted statements and product-intent clarifications is running; do not re-adjudicate those.

PROJECT CONTEXT PATHS: AGENTS.md; docs/architecture-intent/README.md; docs/product-intent/README.md

ASSIGNED CLAIMS:
1. scripts/check-intent-corpora.ts enforces: statement ID format and uniqueness in both corpora; README domain links match domain files; no inline code or path tokens in architecture statements; every cited ARCH/PI/UPD ID resolves; no ADR-NNN or docs/adrs reference outside its exemptions (archived plans, research, benchmark fixtures and results, the output-seam corpus fixture, the plugin package, and the stale-tool-result masker and its test).
2. Its unit test covers each rule and stays hermetic (temp dirs removed).
3. `bun run lint:intent` is wired into `bun run lint` through scripts/lint-parallel.ts.
4. scripts/check-terminology.ts reads docs/terminology.md as the lexicon, scans docs/architecture-intent/, and no longer reads docs/adrs/.
5. AGENTS.md keeps every rule it had before (compare with `git show HEAD:AGENTS.md`), now short and tagged with existing IDs, with no rule's meaning changed.
6. The stale-tool-result masker change only adds "docs/product-intent/" to its protected reference paths.

DESIGN CONTEXT:
- Design intent (fixed): use the approved intent and decisions that the runtime carries from the parent's checkpoint.
- implementation design (revisable): one lint script for both corpora; exemption lists in the lint; elegance guide copies ADR-005 rubric sections verbatim and replaces rule sections with ID citations; glossary copies ADR-016 lexicon verbatim.
- patterns: other doc lints under scripts/check-*.ts registered in scripts/lint-parallel.ts.
- constraints: no history prose in the corpora; architecture statements never name code identifiers; user-visible strings never show statement IDs.
- recorded deviations: lint scans `git ls-files --cached --others --exclude-standard` because new files are untracked; check-terminology adds allowPaths for plugin and daemon prose inside architecture-intent files and does not scan architecture-intent workflows.md with workflow-only terms; AGENTS.md section 8 table dropped its "Why it's wrong" column; two AGENTS.md rules got new statements ARCH-SUBSTRATE-045 and ARCH-STRUCTURE-042.

Check the change against the Design intent and the authorities in PROJECT CONTEXT PATHS as well as for defects. A contradiction with an authority is drift; cite its file and line. Classify each recorded deviation and each discrepancy you find as consistent with the Design intent or as drift, with evidence; a deviation from implementation design alone is not drift. Report the classification and do not decide whether a deviation is acceptable.

Use code-scope locations: <repo-relative-path> or <repo-relative-path>:<line>.
Investigate ambiguous, incomplete, or unverified evidence with targeted commands or mechanism verification before reporting it. If evidence remains unavailable, name the checks attempted, the missing proof, and the concrete failure mode. Do not pass the evidence gap to an implementer. Do not write files. Return prose findings, one block each with Title, Severity, Location, Failure, and Fix, or state No findings.

Apply the constraint rules in the reviewer protocol block to the supplied user requirements, rejected alternatives, and Deferred entries.

Failure must state a recognized principle, intended behavior, observed discrepancy, and concrete consequence. A hardening finding must name the reachable producer or requirement that triggers the risk. Preserve runtime claims that remain unresolved with an UNVERIFIED tag.

Before assessing your domain, read the project context paths listed below that bear on this change's files and domain; skip paths with no bearing on it. Mandatory elegance applies to every domain; do not defer structural judgment to another reviewer.

Required output discipline:
1. Reviewers emit prose findings, one block per finding with these parts: Title, Severity, Location, Failure, Fix. Do NOT emit JSON; the synthesizer structures your output. Use structured sections, paths only rather than file contents, and flag an ambiguity as `OPEN QUESTION:`.
2. Locations are always concrete: `path/to/file.ts:42-67`, never "in the auth module."
3. Format each Failure as four slots: `**Failure:** <Principle name>. <Intent>. <Observation>. <Reasoning>.` If you cannot lead with a principle name, the finding is observational only: mark it P3 or suppress it.
4. Each Fix MUST propose the elegant alternative concretely, not just flag the issue.
5. Preserve every runtime-behavior claim tagged `UNVERIFIED`.
6. The supplied user requirements and Design intent bind you. Where the user chose an approach, do not propose an alternative.
7. Hardening findings name their trigger; otherwise cap at P3.