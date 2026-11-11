Review this completed change.

CHANGE: uncommitted edits (run `git diff -- scripts/bundle-asset-patch.ts scripts/binary-native-assets.ts scripts/build-binary.ts tests/unit/scripts/bundle-asset-patch.test.ts tests/unit/scripts/binary-native-assets.test.ts`). Only these five files are in scope; other dirty files belong to concurrent work.

PROJECT CONTEXT PATHS: AGENTS.md; docs/architecture-intent/distribution.md (ARCH-DISTRIBUTION-001, -005); docs/architecture-intent/runtime.md (ARCH-RUNTIME-011); docs/elegance.md

ASSIGNED CLAIMS:
1. "The bundled OpenTUI worker is byte-identical to node_modules/@opentui/core/parser.worker.js and imports only node builtins, so staging the node_modules copy under the canonical name is equivalent to shipping the bundle output."
2. "unrewrittenAssetBindings catches every relative file-asset binding Bun emits, so a future unpatched file asset fails the build."
3. "Source runs also stage parser.worker.js through the shared copyNativeAssets (scripts/dev.ts) but never use it."

DESIGN CONTEXT:
- Design intent (fixed): use the approved intent and decisions that the runtime carries from the parent's checkpoint.
- implementation design (revisable): add js to assetBindingPattern; OPENTUI_PARSER_WORKER_FILE staged by copyNativeAssets and required by verifyNativeAssets; canonicalAssetNames includes it; build fails on any unrewritten relative `var X_default = "./..."` binding via exported unrewrittenAssetBindings.
- constraints: Not embedding the worker in the binary, because it needs one-off build logic, breaks the binary-entries one-list contract, costs 4.8x bytes, and has an unproven Windows bunfs path. Not a launcher env var, because direct flywheel-bin launches stay broken. Not the hashed file name, because verification needs a fixed name.
- recorded deviations: kept the existing `patchCount === 0` check instead of replacing it, because it catches a Bun output-format change that the new guard (same `var X_default = "./..."` shape) would miss.

Check the change against the Design intent and the authorities as well as for defects. Classify each recorded deviation and discrepancy as consistent with the Design intent or as drift, with evidence. Do not decide acceptance. Use code-scope locations (<path>:<line>). Investigate ambiguous evidence with targeted commands. Do not write files. Return prose findings (Title, Severity, Location, Failure as `<Principle name>. <Intent>. <Observation>. <Reasoning>.`, Fix) or state No findings. User requirements and Design intent bind you; hardening findings name their trigger or cap at P3; preserve UNVERIFIED runtime claims. Read the context paths that bear on the change first.