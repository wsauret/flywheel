import { expect, it } from "bun:test"
import { summaryLine } from "../../../src/infra/summary-line.js"

it.each([
  ["Implemented M04 in the requested worktree. Added the shared label.", "Implemented M04 in the requested worktree"],
  ["## Result\n\n**Summary:** Fixed the card. Tests pass.", "Summary: Fixed the card"],
  ["Read model-access.md and src/app.ts. Fixed the bug.", "Read model-access.md and src/app.ts"],
  ["Handled examples, e.g. dotted paths. Tests pass.", "Handled examples, e.g. dotted paths"],
  ["Done.", "Done"],
  ["Done", "Done"],
  ["## Result", "Result"],
  ["", ""],
  ["Fixed it!\nMore detail.", "Fixed it!"],
  ["## Result\n\nImplemented the shared\nworkflow card. Added tests.", "Implemented the shared workflow card"],
  ["**Summary:** Implemented the shared\nworkflow card.\n\n## Tests\nPassed.", "Summary: Implemented the shared workflow card"],
  ["Clean: no findings\n\nEvidence:\n- src/a.ts:1 ok.", "Clean: no findings"],
  ["## Result\nAll 3 checks passed\n\n- lint: ok\n- test: ok.", "All 3 checks passed"],
  ["Findings:\n- P1 broken. Fix it.", "P1 broken"],
])("selects the opening result sentence from %s", (input, expected) => {
  expect(summaryLine(input)).toBe(expected)
})
