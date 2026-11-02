{
  "schema_version": 1,
  "summary": "Audit dependency pins for reproducible builds: align the @opentui runtime pins with the native-asset staging, raise the held web-tree-sitter patch to the end of its line, keep deliberate exact pins untouched, refresh the extension release runbook that ships in the .vsix, and extend the pin-ledger unit coverage that already guards the manifest.",
  "context": {
    "key_files": [
      "package.json - Root dependency manifest and the //tree-sitter hold note. @opentui/core is currently at 0.2.15 and must rise to 0.5.1 to match the @opentui/solid 0.5.1 pin; the OpenAI SDK is already pinned exactly at 6.39.0 and stays untouched.",
      "tests/unit/scripts/dependency-pins.test.ts - The pin ledger: one assertion per deliberate hold. Phase 1 extends this file with the @opentui lockstep rule.",
      "tests/unit/scripts/binary-native-assets.test.ts - Native-asset staging coverage. It stages the current 0.2.15 win32 native package and proves the build replaces a target package whose version does not match its runtime dependency.",
      "tests/unit/scripts/opentui-native-package-patch.test.ts - Static resolution of the @opentui/core native-package import in binary builds.",
      "vscode/.vscodeignore - The packaging filter vsce reads when it builds the .vsix.",
      "vscode/docs/releasing.md - The extension release runbook: per-target .vsix builds and hand-install steps.",
      "vscode/docs/about-flywheel.md - The docs file the extension opens at runtime from the help surface."
    ],
    "patterns": [
      "Exact pins for runtime dependencies whose native or peer graphs move in lockstep; caret ranges only where a float is deliberate and documented.",
      "A held version and its manifest note change in one edit so the note never lies.",
      "Pin changes land with the ledger assertions that lock them, in the same phase.",
      "Runbook content stays self-contained because installed users read it without the repository."
    ],
    "constraints": [
      "Baseline evidence: bun test tests/unit/scripts/dependency-pins.test.ts ran green on the unmodified tree before this plan was drafted; every pin-ledger assertion passed. Phase 1 extends a proven contract, it does not create one.",
      "The //tree-sitter note above the dependency block is the manifest's own documentation of the web-tree-sitter hold; any change to the held version restates the note in the same edit.",
      "marked (17.0.1) and web-tree-sitter (0.25.10) are exact in the manifest today; treat both as deliberate holds and move them only where a phase names the move.",
      "The OpenAI SDK is out of scope for range conversion: it is already pinned exactly at 6.39.0, so reproducibility does not depend on this plan touching it.",
      "The extension help surface opens docs/about-flywheel.md at runtime, so that file stays in the package unchanged.",
      "No lockfile regeneration outside the phases that edit the manifest."
    ],
    "project_docs": [
      "AGENTS.md",
      "vscode/docs/releasing.md"
    ]
  },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Extend the pin ledger and align the @opentui runtime pins so the native-asset staging and the manifest agree.",
      "files": [
        "package.json",
        "tests/unit/scripts/dependency-pins.test.ts",
        "tests/unit/scripts/binary-native-assets.test.ts"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "First extend the pin-ledger assertions in tests/unit/scripts/dependency-pins.test.ts with the @opentui lockstep rule, then raise @opentui/core from its current 0.2.15 to 0.5.1 so it matches the @opentui/solid 0.5.1 pin. The win32 native-asset staging in tests/unit/scripts/binary-native-assets.test.ts already exercises the current 0.2.15, so the ledger change and the manifest change land together.",
          "files": [
            "package.json",
            "tests/unit/scripts/dependency-pins.test.ts",
            "tests/unit/scripts/binary-native-assets.test.ts"
          ],
          "test_scenarios": [
            "The ledger asserts @opentui/core and @opentui/solid carry one shared version.",
            "The ledger rejects a manifest where the two @opentui pins diverge.",
            "The native-asset replacement test stays green after the manifest edit."
          ]
        },
        {
          "id": "t2",
          "description": "Convert the floating runtime ranges the audit marks for exactness, leaving deliberate holds untouched. The OpenAI SDK needs no edit here: it is already pinned exactly at 6.39.0, so its resolution cannot drift between installs.",
          "files": [
            "package.json"
          ],
          "test_scenarios": [
            "marked stays exact at 17.0.1.",
            "web-tree-sitter stays held at 0.25.10 until phase 2 moves it.",
            "The openai entry is untouched."
          ]
        }
      ],
      "verification": "bun test tests/unit/scripts/dependency-pins.test.ts tests/unit/scripts/binary-native-assets.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-2",
      "goal": "Move the web-tree-sitter hold to the end of its line.",
      "files": [
        "package.json"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Raise the web-tree-sitter hold from 0.25.10 to 0.25.12, the final patch release of the 0.25 line, and restate the held version in the //tree-sitter manifest note in the same edit.",
          "files": [
            "package.json"
          ],
          "test_scenarios": [
            "A fresh install resolves web-tree-sitter to exactly 0.25.12.",
            "The //tree-sitter note names 0.25.12 as the held version.",
            "The static native-package patch tests stay green."
          ]
        }
      ],
      "verification": "bun test tests/unit/scripts/opentui-native-package-patch.test.ts tests/unit/scripts/binary-native-assets.test.ts",
      "qualitative_verification": null
    },
    {
      "id": "phase-3",
      "goal": "Refresh the extension release runbook that ships with the packaged extension.",
      "files": [
        "vscode/docs/releasing.md"
      ],
      "tasks": [
        {
          "id": "t1",
          "description": "Add the pin-audit steps to vscode/docs/releasing.md: confirm the pin ledger is green and confirm the @opentui lockstep before any per-target package build. The published .vsix ships the whole vscode/docs directory next to docs/about-flywheel.md, so installed users read the updated runbook offline; keep it self-contained.",
          "files": [
            "vscode/docs/releasing.md"
          ],
          "test_scenarios": [
            "The runbook lists the ledger check before the per-target build table.",
            "The packaged extension file inventory lists docs/releasing.md."
          ]
        }
      ],
      "verification": "cd vscode && bun run package darwin-arm64",
      "qualitative_verification": "Install the freshly packaged .vsix locally and open the runbook from the installed extension's docs directory to confirm the new pin-audit section renders."
    }
  ],
  "success_criteria": [
    "@opentui/core and @opentui/solid resolve to one shared 0.5.1 version and the pin ledger enforces the lockstep.",
    "web-tree-sitter resolves to exactly 0.25.12 and the //tree-sitter note names it.",
    "openai remains exactly 6.39.0 with no manifest edit in this plan.",
    "The installed extension shows the refreshed runbook at docs/releasing.md beside about-flywheel.md.",
    "bun test tests/unit/scripts/dependency-pins.test.ts stays green after every phase, as it was before the plan.",
    "bun run test, bun run lint, and bun run check:boundaries pass at the end."
  ],
  "open_questions": [],
  "implementation_contract": {
    "directives": [
      {
        "id": "d1",
        "text": "@opentui/core and @opentui/solid carry one shared version and the pin ledger enforces it.",
        "completion_check": "tests/unit/scripts/dependency-pins.test.ts asserts the lockstep and bun test tests/unit/scripts/dependency-pins.test.ts is green."
      },
      {
        "id": "d2",
        "text": "web-tree-sitter is held at 0.25.12 and the //tree-sitter note names that version.",
        "completion_check": "The manifest diff shows both edits in one commit and a fresh install resolves web-tree-sitter to 0.25.12."
      },
      {
        "id": "d3",
        "text": "The refreshed release runbook reaches installed users inside the packaged .vsix.",
        "completion_check": "A packaged extension lists docs/releasing.md in its file inventory."
      }
    ]
  }
}
