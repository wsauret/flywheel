Review this completed change.

CHANGE: uncommitted working-tree diff of these files (run `git diff -- <file>` on each; other agents also edit this tree, so review only these files): src/tui/context/landing-highlight.ts (new, untracked: read it), src/tui/output-window/output-window.tsx, src/tui/output-blocks/tool-entry.tsx, src/tui/output-blocks/tool-row.tsx, src/tui/output-blocks/agent-group-block.tsx, src/tui/output-blocks/question-history-block.tsx, src/tui/modules/workflows/activity-block.tsx, tests/unit/tui/output-window.test.tsx, docs/product-intent/interaction.md (PI-INTERACTION-037 one sentence).

PROJECT CONTEXT PATHS: docs/product-intent/interaction.md (PI-INTERACTION-037), docs/adrs/adr-005-flywheel-design-principles.md

ASSIGNED CLAIMS:
1. The highlight starts only after the block command resolves a block index, and a new landing replaces the old target and restarts the 3000 ms timer; onCleanup clears it (output-window.tsx runCommand / highlightLanding).
2. Each card matches with the same identity `targetTimelineBlockIndex` (src/tui/output-window/output-window-projection.ts:33) uses: ToolEntry block.id, ToolRow tool.id, agent group and workflow cards block.id or block.toolUseId, question card block.toolUseId; question rows ids `${toolUseId}#qN` do not match alone.
3. Within a toolRun only the landed call lights, not its siblings.
4. The new test proves set, replace, and clear without real waits over 30 ms.

DESIGN CONTEXT:
- Design intent (fixed): use the approved intent and decisions that the runtime carries from the parent's checkpoint.
- implementation design (revisable): OutputWindow owns signal + timer; context `LandingTargetProvider` + `useLandingBackground(ids)` returns theme.backgroundElement while matched; card renderers paint their content box.
- patterns: useHoverHighlight (src/tui/hooks/use-hover-highlight.ts), transcript contexts under src/tui/context/.
- constraints: no Button primary-inverted style; no whole-timeline-row highlight; terminal only.
- recorded deviations: (1) block-renderer.tsx and tool-run-block.tsx unchanged because ToolEntry/ToolRow read the context themselves; (2) workflows/activity-block.tsx changed because workflow cards render through a client extension, not ChildActivityBlock; (3) color on each card's content column box, not BlockFrame row, so the gutter dot column stays unpainted; (4) test uses a spyOn(setTimeout) Proxy holding only the 3000 ms timer because jest.useFakeTimers broke the opentui native pump.

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
6. The supplied user requirements and Design intent bind you. Where the user chose an approach, do not propose an alternative. A finding that contradicts a documented rejection must explain why the rejection no longer holds, or it is suppressed.
7. Hardening findings name their trigger, otherwise cap at P3.