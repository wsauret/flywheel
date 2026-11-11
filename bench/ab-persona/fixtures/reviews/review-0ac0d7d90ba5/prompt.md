Review this completed change.

CHANGE:
- src/tui/hooks/composer-attachments.ts (new `pasteParts`, rewritten `claimPasteText`); see `git diff -- src/tui/hooks/composer-attachments.ts`
- tests/unit/tui/hooks/prompt-attachments.test.ts (two new tests); see `git diff -- tests/unit/tui/hooks/prompt-attachments.test.ts`
- docs/product-intent/interaction.md PI-INTERACTION-031 (approved intent update). The same file also has an unrelated PI-INTERACTION-017 edit from concurrent work; ignore it.

PROJECT CONTEXT PATHS:
docs/product-intent/interaction.md (PI-INTERACTION-031), docs/elegance.md

ASSIGNED CLAIMS (verify each with the narrowest tool you already hold before writing findings; report the check-derived evidence; add material claims this list missed):
- "A single path, including one with a real unescaped space, behaves exactly as before" (pasteParts returns ["", text] unless 2+ candidates all pass isAbsolute).
- "Each attachPastedPath starts before the single insertText; this is safe because attachPastedPath awaits before any settle."
- "Ordinals advance per marker because each pending entry is added before the next marker is computed."

DESIGN CONTEXT:
- Design intent (fixed): use the approved intent and decisions that the runtime carries from the parent's checkpoint.
- implementation design (revisable): split the paste with a regex into separators and candidates; reuse pathText per candidate; one marker, token, and pending entry per image candidate; one insertText.
- patterns: existing pathText / findImagePath / attachPastedPath / settle machinery in the same file.
- constraints: change stays in composer-attachments.ts; no quoted-path forms; no non-image attachments from drops; markers must appear synchronously.
- recorded deviations: (1) whitespace after the last path stays in place ("[Image #2] "), unlike a single path whose trailing space folds into the marker or restored text; (2) attachPastedPath now starts before insertText instead of after it.

Check the change against the Design intent and the authorities in PROJECT CONTEXT PATHS as well as for defects. A contradiction with an authority is drift; cite its file and line. Classify each recorded deviation and each discrepancy you find as consistent with the Design intent or as drift, with evidence; a deviation from implementation design alone is not drift. Report the classification and do not decide whether a deviation is acceptable.

Use code-scope locations: <repo-relative-path> or <repo-relative-path>:<line>.
Investigate ambiguous, incomplete, or unverified evidence with targeted commands or mechanism verification before reporting it. If evidence remains unavailable, name the checks attempted, the missing proof, and the concrete failure mode. Do not pass the evidence gap to an implementer. Do not write files. Return prose findings, one block each with Title, Severity, Location, Failure, and Fix, or state No findings.

Apply the constraint rules in the reviewer protocol block to the supplied user requirements, rejected alternatives, and Deferred entries.

Failure must state a recognized principle, intended behavior, observed discrepancy, and concrete consequence. A hardening finding must name the reachable producer or requirement that triggers the risk. Preserve runtime claims that remain unresolved with an UNVERIFIED tag.

Before assessing your domain, read the project context paths listed below that bear on this change's files and domain; skip paths with no bearing on it. Mandatory elegance applies to every domain; do not defer structural judgment to another reviewer.

Required output discipline:
1. Reviewers emit prose findings, one block per finding with these parts: Title, Severity, Location, Failure, Fix. Do NOT emit JSON; the synthesizer structures your output. Use structured sections, paths only rather than file contents, and flag an ambiguity as `OPEN QUESTION:`.
2. Locations are always concrete: `path/to/file.ts:42-67`, never "in the auth module."
3. Format each Failure as four slots: `**Failure:** <Principle name>. <Intent>. <Observation>. <Reasoning>.` Keep the principle name the first token. If you cannot lead with a principle name, mark it P3 or suppress it.
4. Each Fix MUST propose the elegant alternative concretely.
5. Preserve every runtime-behavior claim tagged `UNVERIFIED`.
6. The supplied user requirements and Design intent bind you. Do not propose an alternative to a user choice. A finding that contradicts a documented rejection must explain why the rejection no longer holds, or it is suppressed.
7. Hardening findings name their trigger; otherwise cap at P3.