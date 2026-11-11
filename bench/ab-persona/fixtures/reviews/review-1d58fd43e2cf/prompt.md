Review this completed change for interface design.

CHANGE: uncommitted edits in the working tree. Other agents have unrelated uncommitted edits in the same tree, so review ONLY these paths with `git diff -- <paths>`:
docs/product-intent/interaction.md (line 39 only)
src/tui/adapters/color-diff.ts
src/tui/output-blocks/diff-preview.tsx
src/tui/output-blocks/tool-entry.tsx
src/protocol/client/file-change-body.ts
webview/src/app/file-diff.tsx
tests/unit/tui/output-blocks/diff-preview.test.ts
tests/unit/tui/output-blocks/tool-preview-displayed-rows.test.ts
tests/unit/tui/output-blocks/tool-entry-evidence-publications.test.ts
(If a path's diff contains hunks plainly unrelated to diffs or previews, it is concurrent work: ignore it.)

PROJECT CONTEXT PATHS: docs/product-intent/interaction.md (PI-INTERACTION-005 near line 39), docs/guides/webview-render-continuity.md.

What changed for the user: terminal diffs (collapsed and expanded) now word-wrap. Each row is a full-width line-background box holding a fixed gutter text (line number and +/- marker) and a code text that wraps beside it, so continuation lines start under the code. A collapsed file shows at most 20 displayed rows after wrapping, clipped, with an expand note: "+N lines (click to expand)" when lines are hidden, or "... more (click to expand)" when only wrapping exceeds 20 rows. The web diff view still never wraps; it now takes collapsed rows from a server preview.

ASSIGNED CLAIMS:
1. The line background still spans the full width on wrapped rows, including continuation rows, in diff color modes "standard", theme, and syntax/write presentation (no marker column in syntax mode).
2. Gutter width varies per hunk (per-hunk maxDigits in color-diff renderHunk); does a file with two hunks of different digit widths now misalign code columns between hunks, and was that already true before?
3. Selection and copy: whole-line copy equals the old single-text copy; partial drags map to visible cells. Both texts selectable.
4. The note text and its placement match the non-diff preview pattern (PreviewViewport) and the product intent wording.
5. A collapsed file whose single long line wraps beyond 20 rows still offers its expansion control in the file heading and the tool header chevron.

Check the change against the Design intent (carried in your context from the parent's checkpoint) and the authorities in PROJECT CONTEXT PATHS. Classify each discrepancy as consistent with the Design intent or as drift, with evidence. Recorded deviations: (1) onCut renamed onOverflow, kept for the tool header chevron. (2) Wrap-only clip note "... more (click to expand)". (6) The overflow note appears after first layout.

You may render components in a scratch probe with the OpenTUI test renderer (`bun --env-file=.env.test` for scripts importing src/; put scripts in your scratchpad) to observe frames. Do not write repository files. Do not run `bun run test`, lint, or integration suites.

Return prose findings, one block per finding: Title, Severity, Location (path:line), Failure (`**Failure:** <Principle name>. <Intent>. <Observation>. <Reasoning>.`), Fix (concrete). Or state No findings. Preserve UNVERIFIED claims. The Design intent binds you; never propose an alternative to it.