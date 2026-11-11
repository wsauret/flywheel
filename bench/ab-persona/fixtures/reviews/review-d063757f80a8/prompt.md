Review this completed change.

CHANGE (uncommitted in the shared working tree; other agents have unrelated edits, so diff only these paths with `git diff -- <paths>`):
- src/orchestration/modules/remote/remote-pairing-exchange.ts (machineName: dev lane now `dev (<host>)`)
- src/orchestration/modules/remote/account-relay-service.ts (machine placement announces projectLabel = machineName(lane))
- src/protocol/modules/remote/project-creation.ts (MACHINE_PLACEMENT_LABEL renamed LEGACY_MACHINE_PLACEMENT_LABEL, kept only for a skip)
- src/protocol/modules/remote/relay-client.ts (presence callback adopts the machine placement's label into state.paired and saves it with store.putRuntime when it changed)
- docs/privacy.md (relay row adds the machine's name)
- docs/product-intent/remote-access.md (PI-REMOTE-018 updated by the parent; this is the approved intent)
- tests/unit/protocol/modules/remote/relay-client.test.ts, tests/unit/orchestration/modules/remote/remote-access.test.ts, tests/unit/orchestration/modules/remote/account-relay-service.test.ts, tests/unit/orchestration/modules/remote/terminal-remote.test.ts

PROJECT CONTEXT PATHS:
docs/product-intent/remote-access.md (PI-REMOTE-018), docs/architecture-intent/protocol.md:189, docs/architecture-intent/runtime.md:275, docs/privacy.md, docs/elegance.md

ASSIGNED CLAIMS:
1. "Every client filters the machine placement out by id, so no current or relay-admitted client renders its label as a project" (src/protocol/modules/remote/machine-picker.ts:105-116, webview/src/modules/remote/runtimes.tsx:140, src/orchestration/modules/remote/terminal-remote.ts).
2. "The relay Worker passes projectLabel through unchanged" (relay/worker/src/admission.ts:110-115).
3. "Runtimes v0.1.1 and v0.1.2 announce the legacy label; the relay admits only protocol 5" (relay/worker/src/admission.ts:120).

DESIGN CONTEXT:
- Design intent (fixed): use the approved intent and decisions that the runtime carries from the parent's checkpoint.
- implementation design (revisable): reuse the existing machine placement's projectLabel field as the carrier of the machine's name (no relay protocol change, no Worker or hosted-page deploy); the shared relay client adopts it and persists it via the existing DeviceStore.putRuntime upsert, writing only on change; failure of the store write is contained like setSelection.
- patterns: relay-client.ts selection persistence `.catch(() => {})`; field-by-field presence projection in the Worker.
- constraints: user chose plain status (relay may see the name) over an encrypted request; dev card reads `dev (<host>)`. Rejected: new presence/attach field (current Worker rejects extra attach keys as malformed; 3 deployables); attached runtime remote view (only updates the selected machine); re-pairing (strands every paired phone).
- recorded deviations: test fixtures in terminal-remote.test.ts and the relay-client picker-states test replaced the constant with a label equal to the paired machine's own label, so the client does not rename the machine; no other deviation.

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
4. Each Fix MUST propose the elegant alternative concretely.
5. Preserve every runtime-behavior claim tagged `UNVERIFIED`. A claim confirmable by a single direct read is literal state and carries a `file:line` without the tag.
6. The supplied user requirements and Design intent bind you. Where the user chose an approach, do not propose an alternative. A finding that contradicts a documented rejection must explain why the rejection no longer holds, or it is suppressed.
7. Hardening findings name their trigger: a design requirement or a `file:line`/named caller whose normal operation produces the failure. Otherwise cap at P3.