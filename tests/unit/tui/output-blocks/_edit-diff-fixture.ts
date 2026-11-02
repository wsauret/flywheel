import { TOOL_PREVIEW_LINE_LIMIT } from "../../../../src/infra/output-blocks.js"

/** A two-hunk edit diff whose second hunk holds `hunkLines` rendered lines,
 *  six past the preview limit by default, so the preview truncates it. */
export function editDiff(hunkLines = TOOL_PREVIEW_LINE_LIMIT + 6): string {
  const lines = [
    "--- a/src/sanitized-example.ts",
    "+++ b/src/sanitized-example.ts",
    "@@ -1,3 +1,3 @@",
    " const first = 1",
    "-const second = 2",
    "+const second = 3",
    "@@ -10,20 +10,20 @@",
  ]
  for (let index = 0; index < hunkLines - 3; index += 1) lines.push(` const filler${index} = ${index}`)
  return lines.join("\n")
}
