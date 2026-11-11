Review this completed change.

CHANGE (uncommitted working-tree diff; run `git diff -- <path>` for each; other agents edit other files in this tree, so review only these):
src/tui/hooks/use-subscription-spend-consent-control.ts
src/tui/hooks/use-subscription-spend-consent-modal.ts
src/tui/modals/subscription-spend-consent-modal.tsx
src/tui/modals/auth-modal.tsx
src/tui/hooks/create-modals.tsx
src/tui/components/modal-copy.ts
webview/src/client/provider-view-model.ts
webview/src/app/sheets/providers-sheet.tsx
tests/unit/tui/hooks/use-subscription-spend-consent-control.test.ts
tests/unit/tui/modals/auth-modal-paid-use-question.test.ts
tests/unit/tui/modals/auth-modal-capability-render.test.tsx
tests/unit/tui/modals/subscription-spend-consent-modal.test.tsx
webview/src/client/provider-view-model.test.ts
webview/src/app/providers-sheet-interaction-fixture.ts
webview/src/app/providers-sheet-interaction.test.ts
docs/adrs/adr-020-subscription-spend-consent.md

PROJECT CONTEXT PATHS:
docs/adrs/adr-020-subscription-spend-consent.md
docs/product-intent/interaction.md (PI-INTERACTION-067, PI-INTERACTION-062)
docs/product-intent/model-access.md (PI-MODEL-018)
docs/guides/webview-render-continuity.md
docs/adrs/adr-010-runtime-ui-protocol.md

ASSIGNED CLAIMS (verify each with the narrowest tool you already hold before writing findings; report the check-derived evidence; add material claims this list missed):
1. "Paid-use checkboxes now write one mode immediately in the terminal question, terminal Provider Settings, and shared web/phone Providers sheet." (implementer summary)
2. "Controls retain saved decisions while writing, identify the saving mode, and retain saved values with failure feedback." (implementer summary)
3. "Continue and question close paths decline only unanswered modes." (implementer summary)
4. The server accepts a single-envelope reviewed subset: `src/orchestration/subscription-spend-consent/subscription-spend-consent-service.ts:238-268`.
5. A toggle that is still in flight when the surface closes still commits (probe claim: "closing before write completion preserved accepted consent after Escape, Left, and frame x").

DESIGN CONTEXT:
- Design intent (fixed): use the approved intent and decisions that the runtime carries from the parent's checkpoint (unit U1).
- implementation design (revisable): toggle() calls commit() with reviewed=[id], accepted=[id] or []; the checked set derives from committed decisions; a per-mode saving indicator; save(), the `s` key, the footer hint, and the dead onSave prop are removed; the web sheet dispatches the same per-envelope mutation per checkbox change and drops its dirty draft and Save button.
- patterns: the free-routes row in `src/tui/modals/auth-modal.tsx` already saves on toggle with "· Saving..."; webview action owner `client.actions.run`.
- constraints: no Save key or button for paid use anywhere; closing writes nothing pending because nothing is pending; consent store and mutation shape unchanged. Rejected: a Save button or always-visible save hint; save on close. A separate unit (U2, in progress, not in this diff) will remove evidence gating (`canEnable`) from admission; do not flag `canEnable` UI states as in scope here unless this diff broke them.
- recorded deviations: (1) replaced the TUI `saving` boolean with `savingEnvelopeIds` for a per-mode indicator without a checked draft; (2) question close copy changed from "esc keep off" to "esc continue" because a previously ticked mode now stays accepted; (3) extended presentation, rendering, question, and web render-fixture tests whose old assertions were obsolete; (4) the web sheet reads committed decisions from the shared auth publication instead of a local consent cache; (5) the web fixture exposes the action completion promise instead of counting microtasks.

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
7. Hardening findings name their trigger; otherwise cap at P3.