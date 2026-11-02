{
  "schema_version": 1,
  "summary": "Refactor Flywheel’s prompt assets in three ordered phases: establish an infra-owned universal system-prompt loader and binary fallback without leaking workflow assets into infra, fold the lean elegance and proportionality doctrine into that universal core, then remove conventions.md and place reviewer and research instructions only in their referenced role protocols. The work preserves project/user/bundled overlay behavior, compiled-binary embedding, prompt provenance, and plan-review’s routing vocabulary while adding regression tests and prompt-dump checks for every acceptance criterion.",
  "context": {
    "key_files": [
      "src/workflows/loader.ts -- Current definition loaders plus the whole-file helper and wrappers that must be separated by ownership.",
      "src/workflows/register.ts -- Current startup registration and project/user/bundled whole-file precedence.",
      "src/orchestration/agent-runtime/shared/system-prompt.ts -- Single prompt-part builder; for subagent prompts it appends the universal core after the persona instructions, so moving the core cannot change subagent prompt ordering.",
      "src/workflows/queue/prompt-assembly.ts -- Current workflow-worker-only conventions injection and the step/reference/handoff/learnings assembly that must otherwise remain stable.",
      "scripts/build-manifest.ts -- Current single-root generator for workflow assets, conventions, and system prompt binary fallbacks.",
      "scripts/build-binary.ts -- Temporarily populates and restores the checked-in manifest during standalone binary builds.",
      "src/workflows/agents/manifest.ts -- Current empty development manifest for personas and workflow assets; it must stop owning universal system-prompt fallback and later lose conventions.",
      "src/workflows/conventions.md -- Source to split into universal elegance doctrine, reviewer protocol, research protocol, and deletions.",
      "src/workflows/steps/references/reviewer-protocol.md -- Canonical inclusion point and reviewer dispatch paste block for role-specific review rules.",
      "src/workflows/steps/references/research-protocol.md -- Existing more-precise fanout and documentarian protocol that should remain canonical.",
      "src/workflows/steps/flywheel/plan-review.md -- Operational consumer of the catalog’s exact leading principle names.",
      "scripts/dump-prompt.ts -- Production-shaped chat, subagent, and step prompt inspection surface with per-layer sizes.",
      "tests/unit/scripts/manifest.test.ts -- Existing binary-manifest generation coverage.",
      "tests/unit/orchestration/agent-runtime/shared/system-prompt-assembler.test.ts -- Existing cross-prompt-kind system-prompt composition coverage.",
      "tests/unit/workflows/workflow-prompt-hygiene.test.ts -- Existing content-level workflow instruction regression suite."
    ],
    "patterns": [
      "Whole-file overlays use first-hit precedence: project `.flywheel/`, user definitions root, bundled source, then an embedded manifest fallback only when filesystem resolution is empty.",
      "Checked-in manifests are empty in development; `scripts/build-binary.ts` temporarily writes embedded content before bundling and restores original content in `finally`.",
      "`buildSystemPromptParts` is the single ordered runtime prompt surface; prompt-part order varies by prompt kind, so moving the core file does not disturb per-kind composition.",
      "Workflow step references use authored `{{ref:name}}` inclusions expanded by `resolveStepBody`, so reviewer and research doctrine can remain progressive role-specific assets.",
      "Tests use Bun’s built-in runner through repository scripts; `scripts/dump-prompt.ts` is the established behavioral inspection tool for prompt composition and layer sizes.",
      "Ownership moves keep import churn low; wide import fanouts may migrate incrementally behind a temporary re-export."
    ],
    "constraints": [
      "User feature description (verbatim, authoritative): Refactor Flywheel's prompt-asset layering so universal agent doctrine lives in one runner-wide home and role-specific content lives only where the role consumes it. Three phases, in order.\n\n## Background (verified facts)\n\n- `src/workflows/system-prompt.md` is the universal runner core: `src/workflows/register.ts:88` loads it via `loadSystemPrompt(wholeFileRoots)` (three-tier resolution: project `.flywheel/` -> user definitions dir -> bundled source, with `src/workflows/agents/manifest.ts` as the compiled-binary fallback), and `src/orchestration/agent-runtime/shared/system-prompt.ts` puts it as the first part of EVERY prompt (chat, step-worker, subagent) in `buildSystemPromptParts`.\n- `src/workflows/conventions.md` is loaded the same way (`register.ts:85`, `loadConventions` in `src/workflows/loader.ts:296`) but is injected ONLY into workflow step task instructions (`src/workflows/queue/prompt-assembly.ts:78`). Chat and subagents never see it. This is a defect: reviewer personas are told to lead findings with names \"from the elegance catalog\" (`src/workflows/steps/references/reviewer-protocol.md:24`) but reviewer subagents never receive the catalog; implementer subagents who write the code never see it either.\n- `scripts/dump-prompt.ts --sizes` prints per-layer prompt sizes; use it to verify before/after (e.g. `bun run scripts/dump-prompt.ts step flywheel.plan-create --sizes`, `chat --sizes`, `subagent reviewer-code-quality --sizes`).\n- `scripts/build-manifest.ts` generates the compiled-in manifest (`src/workflows/agents/manifest.ts` exports `conventionsText`, `systemPromptText`, `stepDefinitions`, `workflowDefinitions`, `workflowAssets`); it must be updated for any asset move/deletion.\n\n## Phase 1: Move runner-universal asset machinery to infra\n\nThe whole-file layered-asset loading currently in `src/workflows/loader.ts` (`loadFirstDefinitionFile`, `loadSystemPrompt`, `loadConventions`, `defaultUserDefinitionsRoot` as applicable) serves runner-universal assets, not workflow-domain ones. Create an infra home (suggested: `src/infra/agent-assets/`) that owns:\n\n- the generic three-tier whole-file resolution helper (fs-only, no src/ imports — infra-legal),\n- `system-prompt.md` itself (moved from `src/workflows/system-prompt.md`),\n- the loaded `systemPrompt` export currently on `src/workflows/register.ts:88`.\n\n`src/workflows/loader.ts` keeps step/workflow/reference/skill loading and imports the generic resolution helper from infra. Update `src/orchestration/agent-runtime/shared/system-prompt.ts:14` (imports `systemPrompt` from `workflows/register.js`) and any other consumers. Consider whether `src/workflows/agents/personas/` also belongs in the shared home — personas are loaded by orchestration (`runtime-assembly.ts:74-78`) for chat subagents too; move them only if the move stays mechanical, otherwise record it as a follow-up. Update `scripts/build-manifest.ts` and the manifest module for the new paths. Run `bun run check:boundaries` after moves. Do NOT create re-export shims; update every import.\n\n## Phase 2: Fold the universal core of conventions into the system prompt\n\nAppend to the (now infra-homed) system-prompt.md a lean version of conventions.md's universal core:\n\n- the elegance principle (\"maximize elegance\", deliberate-decision bar),\n- the decision checklist (8 items),\n- the anti-pattern catalog (Universal Principles, Structural, Data Flow, Abstraction, Plan-Specific tables) — these names are load-bearing routing vocabulary: `src/workflows/steps/flywheel/plan-review.md:114-121` matches finding Failure paragraphs against them verbatim, and reviewer-protocol.md:24 tells reviewers to lead with them,\n- \"Symptoms vs. structure\",\n- the Proportionality section (referenced by name as \"proportionality rule\" in plan-review.md, code-review.md, and reviewer-protocol.md).\n\nKeep it tight; do not import the prose padding. After this, chat, step workers, AND subagents all carry the catalog (verify with dump-prompt: the reviewer subagent prompt must now contain the anti-pattern catalog).\n\n## Phase 3: Delete conventions.md and rehome the role-specific remainder\n\nDelete `src/workflows/conventions.md`, `loadConventions` (`loader.ts:296-298`), the `conventions` export (`register.ts:85`), `conventionsText` in the manifest, and the conventions injection in `src/workflows/queue/prompt-assembly.ts:78` (and its mention in the `buildStepTaskInstructions` doc comment). Rehome the remaining sections:\n\n- \"Output Rules\" (word caps, severity ladder P1/P2/P3, reference format `path:42-67`), \"False-Positive Suppression\", and \"Finding Quality: Lead with the Failure\" (four-slot format) -> merge into `src/workflows/steps/references/reviewer-protocol.md`, deduplicating with the four-slot summary already in its dispatch paste block (one canonical statement of the format; the paste block may reference it briefly). Only steps that dispatch reviewers pull this ref.\n- \"Research Agent Behavior\" and \"Dispatch Patterns\" (explorer fanout, model inheritance, input context) -> mostly pure deletion: `src/workflows/steps/references/research-protocol.md` already states facet fanout and documentarian mode more precisely (this currently duplicates inside plan-create's assembled prompt ~70 lines apart). Preserve into research-protocol.md only what it lacks (check: \"Model inheritance\" — implementation subagents inherit parent model, never set model; \"Pass file paths not content / under 100 lines\"), then delete the rest.\n- \"Spec Quality Bar\" -> pure deletion; `src/workflows/steps/flywheel/plan-create.md` already carries a richer version (\"Spec Quality Bar gate\").\n\nAlso fix stale cross-references in the same unit:\n- `src/workflows/steps/flywheel/implement.md:223`, `src/workflows/steps/debug/fix.md:57`: \"the 3-strike error protocol from conventions\" -> \"from your system prompt\" (the ERROR PROTOCOL lives in system-prompt.md:53-58, which every worker receives). `src/workflows/steps/get-stuff-done/implement.md:152` mentions \"3-strike debugging budget\" — align phrasing if it references conventions.\n- Any other reference to \"conventions\" as a document inside `src/workflows/steps/**` (grep for it) that would dangle after deletion.\n\n## Constraints\n\n- Do not touch AGENTS.md content (its overlap with the catalog is a separate editorial task).\n- Do not change `renderWorkPostamble` / handoff rules in this run (known separate defect, out of scope).\n- Do not add per-prompt-kind gating for the elegance core; it is intentionally universal.\n- `bun run lint`, `bun run test`, `bun run check:boundaries` must pass. There are other agents working in this tree: never discard or stash unrelated changes; if a global gate is blocked by unrelated work, run the narrowest validation for touched files.\n\n## Acceptance criteria\n\n1. `bun run scripts/dump-prompt.ts chat --sizes` and `subagent reviewer-code-quality --sizes` show the system prompt core grown by roughly the elegance-core size; the reviewer prompt text contains the anti-pattern catalog names (e.g. \"Forwarding Chain\", \"Premature Abstraction\").\n2. `bun run scripts/dump-prompt.ts step flywheel.plan-create` output contains exactly ONE statement of explorer facet fanout and ONE \"documentarian mode\" instruction (currently three).\n3. `src/workflows/conventions.md` no longer exists; `grep -r \"conventions\" src/workflows/steps/` has no reference to a conventions document; `loadConventions`/`conventionsText` symbols are gone.\n4. Step task instructions for non-review steps (e.g. `flywheel.implement`, ship steps) no longer contain reviewer output rules / false-positive suppression / finding-quality text.\n5. plan-review's redesign routing catalog names (plan-review.md:114-121) still all appear in the system prompt core verbatim.\n6. All validation green: `bun run lint`, `bun run test`, `bun run check:boundaries`.",
      "Existing solution: reuse the current first-hit whole-file semantics rather than introducing a second resolver; preserve the current project > user > source > embedded fallback behavior in its new infra owner.",
      "Integration risk: the compiled binary currently has one temporary manifest. The new infra manifest is generated during the build; because its content is deterministic and regenerated on every build, it does not need the populate-and-restore lifecycle the workflow manifest uses.",
      "Considered: moving the entire existing manifest module into infra. Rejected because: Layering Violation — that would make infra own workflow definitions and step-reference payloads consumed only by the workflow domain; split the universal fallback from the workflow manifest instead.",
      "Considered: moving `src/workflows/agents/personas/` into infra in this run. Rejected because: Shotgun Surgery — source-mode metadata, runtime overlays, installer materialization, prompt dumping, manifest collection, and release packaging all encode that location, so the move is not mechanical and is a separate follow-up ownership refactor.",
      "The temporary duplication after phase 2 is intentional and short-lived: the new system core is universal while conventions remains step-only until phase 3 removes it; phase 3 regression tests must prove the final prompt has one copy.",
      "The current ADRs already require `infra <- workflows <- orchestration`, explicit prompt provenance, and direct import updates, so this refactor conforms to their present-tense claims without changing an ADR assertion.",
      "Do not modify AGENTS.md, `renderWorkPostamble`, handoff rules, or add prompt-kind gating. Preserve unrelated concurrent work and use scoped validation if an unrelated change blocks a global gate.",
      "This is prompt composition and build-asset work with no rendered TUI behavior; installed-binary tmux UAT is not applicable. The production-shaped `dump-prompt` script is the direct affected-surface verification."
    ],
    "project_docs": [
      "docs/adrs/README.md",
      "docs/adrs/adr-002-context-engineering-and-inspectability.md",
      "docs/adrs/adr-003-agent-as-environment-operator.md",
      "docs/adrs/adr-005-flywheel-design-principles.md",
      "docs/adrs/adr-007-agent-runtime-process-placements.md",
      "docs/plans/user-editable-definitions.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Move runner-universal whole-file asset ownership and the system prompt into infra while preserving overlay precedence and compiled-binary behavior.",
      "files": [
        "src/infra/agent-assets/loader.ts",
        "src/infra/agent-assets/system-prompt.ts",
        "src/infra/agent-assets/system-prompt.md",
        "src/infra/agent-assets/manifest.ts",
        "src/workflows/system-prompt.md",
        "src/workflows/loader.ts",
        "src/workflows/register.ts",
        "src/workflows/agents/manifest.ts",
        "src/orchestration/agent-runtime/shared/system-prompt.ts",
        "src/orchestration/agent-runtime/shared/runtime-assembly.ts",
        "scripts/build-manifest.ts",
        "scripts/build-binary.ts",
        "tests/unit/infra/agent-assets-loader.test.ts",
        "tests/unit/scripts/manifest.test.ts",
        "tests/unit/workflows/definitions/project-local.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "First add infra-level tests for first-hit whole-file resolution and its project, user, bundled-source, and empty-result cases. Then move the generic filesystem-only resolver into `src/infra/agent-assets/loader.ts`, importing `defaultUserDefinitionsRoot` from `src/workflows/loader.ts` to avoid duplicating the user-root path logic; move `system-prompt.md` to the same infra domain; and add an infra-owned `systemPrompt` module that applies project `.flywheel/`, user definitions, moved bundled source, then compiled fallback precedence. Keep `register.ts` exporting `systemPrompt` as a thin re-export of the infra module so the many existing imports keep working, and keep the conventions wrapper temporarily in the workflow loader by calling the generic infra resolver until phase 3. Before edits, run and record the `core system prompt` sizes from the three requested chat, step, and reviewer-subagent dump commands as the comparison baseline.",
          "files": [
            "src/infra/agent-assets/loader.ts",
            "src/infra/agent-assets/system-prompt.ts",
            "src/infra/agent-assets/system-prompt.md",
            "src/workflows/system-prompt.md",
            "src/workflows/loader.ts",
            "src/workflows/register.ts",
            "src/orchestration/agent-runtime/shared/system-prompt.ts",
            "src/orchestration/agent-runtime/shared/runtime-assembly.ts",
            "tests/unit/infra/agent-assets-loader.test.ts",
            "tests/unit/workflows/definitions/project-local.test.ts"
          ],
          "test_scenarios": [
            "The generic resolver returns the first existing file from ordered roots, falls through absent project and user roots to the bundled root, and returns an empty string when no root contains the requested asset.",
            "The loaded universal system prompt preserves project `.flywheel/` over user over moved bundled-source precedence, with compiled text used only when filesystem resolution is empty.",
            "Chat, step-worker, subagent, and compaction prompt construction all continue to place the moved system prompt first through the same `buildSystemPromptParts` path.",
            "`src/workflows/loader.ts` continues to load step, workflow, reference, skill, and temporary conventions assets, and continues to own the shared user-root function that the infra resolver imports.",
            "Existing `systemPrompt` imports from `workflows/register.js` continue to resolve through the compatibility re-export."
          ]
        },
        {
          "id": "t2",
          "description": "First update manifest tests to require separate generated outputs for universal agent assets and workflow assets. Then split binary fallback generation so `src/infra/agent-assets/manifest.ts` contains only `systemPromptText`, while `src/workflows/agents/manifest.ts` continues to contain personas, step definitions, workflow definitions, workflow references, and, until phase 3, `conventionsText`. Update `scripts/build-binary.ts` to populate the infra manifest during the build; a restore step is unnecessary for the infra manifest because its generated content is deterministic and the next build overwrites it. Update generator comments and required source paths for the moved system prompt.",
          "files": [
            "src/infra/agent-assets/manifest.ts",
            "src/workflows/agents/manifest.ts",
            "scripts/build-manifest.ts",
            "scripts/build-binary.ts",
            "tests/unit/scripts/manifest.test.ts"
          ],
          "test_scenarios": [
            "Manifest generation embeds the moved infra `system-prompt.md` as `systemPromptText` in the infra manifest and does not embed it in `workflowAssets`.",
            "The workflow manifest still embeds personas, grouped steps, references, workflow YAML, and temporary `conventionsText`, and its relative workflow asset paths remain unchanged.",
            "The binary build restores the workflow manifest after bundling; the generated infra manifest is left populated in the working tree for inspection.",
            "A missing moved system-prompt source is rejected as a required universal asset, while dangling workflow step references continue to fail workflow-manifest validation.",
            "No workflow definition, workflow reference, or persona payload is copied into the infra manifest."
          ]
        }
      ],
      "verification": "bun run test:verbose && bun run check:boundaries",
      "qualitative_verification": "Inspect the cumulative phase diff and prompt-size baseline: the runtime imports the universal prompt directly from infra, the workflow layer imports only the generic infra resolver, both manifests have one clear content owner, and no persona source was moved."
    },
    {
      "id": "phase-2",
      "goal": "Make the elegance catalog and proportionality doctrine universal by folding their lean canonical form into the infra-owned system prompt.",
      "files": [
        "src/infra/agent-assets/system-prompt.md",
        "tests/unit/orchestration/agent-runtime/shared/system-prompt-assembler.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "First extend system-prompt assembly tests with the routing vocabulary and prompt-kind coverage. Then append a compact doctrine section to the infra-owned `system-prompt.md`: the maximize-elegance and deliberate-decision bar; all eight decision-checklist items; the Universal Principles plus Structural, Data Flow, Abstraction, and Plan-Specific anti-pattern tables; Symptoms vs. structure; and Proportionality. While folding the tables in, tighten verbose catalog names for concision (for example `Forwarding Chain` becomes `Needless Indirection` and `Premature Abstraction` becomes `Early Abstraction`), and do not copy reviewer output/severity/finding rules, research dispatch instructions, the spec quality bar, or prose padding.",
          "files": [
            "src/infra/agent-assets/system-prompt.md",
            "tests/unit/orchestration/agent-runtime/shared/system-prompt-assembler.test.ts"
          ],
          "test_scenarios": [
            "Chat, step-worker, and reviewer-subagent system prompts all contain the elegance principle, the eight checklist entries, Symptoms vs. structure, and Proportionality.",
            "Every redesign-routing name listed in `src/workflows/steps/flywheel/plan-review.md` under Universal Principles, Structural, Data Flow, Abstraction, and Plan-Specific appears in the universal system prompt in its tightened form.",
            "Reviewer-only headings such as `False-Positive Suppression` and `Finding Quality: Lead with the Failure`, research-agent fanout/documentarian instructions, and the spec quality bar do not appear in the universal core.",
            "The system prompt remains the first labeled prompt part and appears exactly once for each prompt kind.",
            "The chat and reviewer-subagent `core system prompt` size increases from the phase-1 baseline by the same approximate doctrine size, without a new prompt-kind gate."
          ]
        }
      ],
      "verification": "bun run test:verbose && bun run scripts/dump-prompt.ts chat --sizes && bun run scripts/dump-prompt.ts subagent reviewer-code-quality --sizes && bun run scripts/dump-prompt.ts subagent reviewer-code-quality",
      "qualitative_verification": "Compare the size rows with the phase-1 baseline and inspect the reviewer dump to confirm the anti-pattern tables and routing names are present in the universal core, with no reviewer-only or research-only remainder added there."
    },
    {
      "id": "phase-3",
      "goal": "Delete conventions.md and place each role-specific remainder only in the reviewer or research reference that consumes it.",
      "files": [
        "src/workflows/conventions.md",
        "src/workflows/loader.ts",
        "src/workflows/register.ts",
        "src/workflows/agents/manifest.ts",
        "src/workflows/queue/prompt-assembly.ts",
        "src/workflows/steps/references/reviewer-protocol.md",
        "src/workflows/steps/references/research-protocol.md",
        "src/workflows/steps/flywheel/implement.md",
        "src/workflows/steps/debug/fix.md",
        "src/workflows/steps/get-stuff-done/implement.md",
        "scripts/build-manifest.ts",
        "scripts/dump-prompt.ts",
        "tests/unit/scripts/manifest.test.ts",
        "tests/unit/workflows/definitions/project-local.test.ts",
        "tests/unit/workflows/definitions/prompt-assembly.test.ts",
        "tests/unit/workflows/inline-step-prompt.test.ts",
        "tests/unit/workflows/workflow-prompt-hygiene.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "First add prompt-hygiene assertions for research protocol deduplication. The conventions Output Rules, P1/P2/P3 ladder, reference format, False-Positive Suppression, and four-slot Finding Quality contract are near-duplicates of guidance reviewer subagents already receive through `reviewer-protocol.md`, so delete them with the file rather than rehoming them. In `research-protocol.md`, retain its existing precise facet-fanout and documentarian rules exactly once, add only the missing model-inheritance rule and scoped file-path/phase-excerpt/under-100-lines input guidance, and do not recreate deleted conventions prose elsewhere.",
          "files": [
            "src/workflows/steps/references/reviewer-protocol.md",
            "src/workflows/steps/references/research-protocol.md",
            "tests/unit/workflows/inline-step-prompt.test.ts",
            "tests/unit/workflows/workflow-prompt-hygiene.test.ts"
          ],
          "test_scenarios": [
            "Reviewer dispatch guidance is unchanged by this phase; no conventions content is merged into `reviewer-protocol.md`.",
            "The deleted reviewer sections do not reappear in any step reference or worker prompt.",
            "The assembled `flywheel.plan-create` prompt contains exactly one facet-fanout statement and exactly one documentarian-mode instruction.",
            "Research protocol tells implementation subagents to inherit the parent model without setting one, confines cheaper configured models to research agents, and tells research dispatchers to pass paths rather than file content and phase-only excerpts under 100 lines where possible.",
            "Plan-create’s existing richer Spec Quality Bar remains the only spec-quality guidance; no replacement is added to a shared reference."
          ]
        },
        {
          "id": "t2",
          "description": "First add worker-prompt tests proving non-review steps receive no reviewer doctrine. Delete `conventions.md`, `loadConventions`, the workflow `conventions` export, `conventionsText`, its manifest generation, and the conventions import/injection and doc-comment wording in worker prompt assembly. Remove the conventions diagnostic sublayer from `dump-prompt.ts`. Preserve step body, reference expansion, handoff postamble, available-agent rendering, learnings, and user-context assembly unchanged.",
          "files": [
            "src/workflows/conventions.md",
            "src/workflows/loader.ts",
            "src/workflows/register.ts",
            "src/workflows/agents/manifest.ts",
            "src/workflows/queue/prompt-assembly.ts",
            "scripts/build-manifest.ts",
            "scripts/dump-prompt.ts",
            "tests/unit/scripts/manifest.test.ts",
            "tests/unit/workflows/definitions/project-local.test.ts",
            "tests/unit/workflows/definitions/prompt-assembly.test.ts",
            "tests/unit/workflows/workflow-prompt-hygiene.test.ts"
          ],
          "test_scenarios": [
            "`src/workflows/conventions.md` is absent and repository searches find no `loadConventions`, `conventionsText`, workflow `conventions` export, conventions import, or `task: conventions.md` diagnostic label.",
            "A `flywheel.implement` worker prompt and a ship-step worker prompt do not contain reviewer output rules, false-positive suppression, finding-quality prose, research fanout prose, or the deleted spec quality bar.",
            "Reviewer-dispatching steps still receive reviewer protocol through `{{ref:reviewer-protocol}}`, and research-dispatching steps still receive research protocol through their existing references.",
            "Worker prompt assembly still renders available subagents, the expanded step body, the registered handoff postamble, bounded learnings, step instructions, loop item, and context bundle in their existing order.",
            "Generated workflow manifests retain personas, steps, references, and workflows but contain neither `conventionsText` nor the deleted conventions asset."
          ]
        },
        {
          "id": "t3",
          "description": "Update stale step wording in the same unit: change `flywheel/implement.md` and `debug/fix.md` to source the 3-strike error protocol from the system prompt, and align `get-stuff-done/implement.md` so its debugging-budget wording identifies the same universal source without introducing another copy of the protocol. Search all `src/workflows/steps/**` content and remove only references that name conventions as a document; leave unrelated uses of the ordinary word “conventions” intact.",
          "files": [
            "src/workflows/steps/flywheel/implement.md",
            "src/workflows/steps/debug/fix.md",
            "src/workflows/steps/get-stuff-done/implement.md",
            "tests/unit/workflows/workflow-prompt-hygiene.test.ts"
          ],
          "test_scenarios": [
            "`flywheel.implement` and `debug.fix` direct workers to the 3-strike error protocol in the system prompt.",
            "`get-stuff-done.implement` uses aligned system-prompt wording for its three-strike debugging budget without duplicating the protocol steps.",
            "A scoped content search under `src/workflows/steps/` finds no reference to conventions as a document or source after deletion.",
            "Ordinary project/code convention wording in unrelated step instructions remains unchanged."
          ]
        }
      ],
      "verification": "bun run test:verbose && bun run scripts/dump-prompt.ts step flywheel.plan-create && bun run scripts/dump-prompt.ts step flywheel.implement && bun run scripts/dump-prompt.ts step ship.commit",
      "qualitative_verification": "Inspect the plan-create dump for exactly one facet-fanout statement and one documentarian-mode instruction; inspect implement and ship dumps for absence of reviewer-only doctrine; and use scoped repository search to confirm the deleted file and symbols have no remaining references."
    }
  ],
  "success_criteria": [
    "`bun run scripts/dump-prompt.ts chat --sizes`, `bun run scripts/dump-prompt.ts step flywheel.plan-create --sizes`, and `bun run scripts/dump-prompt.ts subagent reviewer-code-quality --sizes` show the same universal core layer for all runner kinds, increased from the recorded phase-1 baseline by approximately the appended elegance doctrine size.",
    "The raw reviewer-code-quality subagent dump contains the tightened routing catalog names, including `Needless Indirection` and `Early Abstraction`.",
    "The raw `flywheel.plan-create` step dump contains exactly one explorer facet-fanout statement and exactly one documentarian-mode instruction.",
    "`src/workflows/conventions.md` does not exist; scoped repository search finds no `loadConventions`, `conventionsText`, conventions export/import, conventions prompt sublayer, or reference to conventions as a document under `src/workflows/steps/`.",
    "Raw `flywheel.implement` and ship-step dumps contain no reviewer output rules, false-positive suppression, or finding-quality text, while reviewer-dispatching steps still include the canonical reviewer protocol.",
    "The compiled-manifest generator embeds `systemPromptText` only in the infra manifest, keeps workflow/persona/reference payloads in the workflow manifest, and the binary build restores the checked-in workflow manifest after bundling.",
    "`bun run lint` exits 0.",
    "`bun run test` exits 0.",
    "`bun run check:boundaries` exits 0.",
    "No instance of the rejected whole-manifest-in-infra shape: workflow definitions, workflow references, and persona payloads remain outside the infra manifest."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "Every chat, step-worker, subagent, and compaction prompt receives the same infra-owned universal system prompt first, including the complete plan-review routing catalog with no prompt-kind gate.",
        "completion_check": "`tests/unit/orchestration/agent-runtime/shared/system-prompt-assembler.test.ts` covers all prompt kinds and catalog names; the chat and reviewer-subagent dump commands show the same grown `core system prompt` layer."
      },
      {
        "id": "d2",
        "text": "Reviewer output/finding doctrine and research dispatch doctrine are absent from generic worker preambles; near-duplicate conventions content is deleted rather than rehomed.",
        "completion_check": "`tests/unit/workflows/inline-step-prompt.test.ts`, `tests/unit/workflows/definitions/prompt-assembly.test.ts`, and `tests/unit/workflows/workflow-prompt-hygiene.test.ts` assert exact fanout/documentarian counts, canonical reviewer format, and absence from implement/ship worker prompts."
      },
      {
        "id": "d3",
        "text": "Compiled binaries preserve the moved universal prompt and all workflow assets through separate owner-aligned manifests, with the workflow manifest restored after bundling.",
        "completion_check": "`tests/unit/scripts/manifest.test.ts` verifies the split generated outputs, and `scripts/build-binary.ts` shows the populate/restore lifecycle for the workflow manifest path."
      }
    ]
  }
}