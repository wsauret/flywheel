import { describe, expect, it } from "bun:test"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { hydrateDerivedOutputRange, hydrateDerivedOutputBlockBody } from "../../../../src/orchestration/app-service/transcript-queries.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder.js"

/** Unified diff whose hunk content lines are the only lines the client renders;
 *  the file and `@@` headers are structural and must not be counted. */
function editDiff(hunkLines: number): Extract<AnyBlock, { kind: "tool" }> {
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
  return {
    kind: "tool",
    id: "edit-1",
    name: "edit",
    presentation: { name: "Edit", detail: "src/sanitized-example.ts" },
    status: "completed",
    diff: lines.join("\n"),
    filetype: "typescript",
    timestamp: 1,
  }
}

async function editWireBlock(hunkLines: number) {
  const range = await hydrateDerivedOutputRange(
    { ...indexOutputBlocks([editDiff(hunkLines)]), consistencyToken: "sequence:v1" },
    { anchor: { kind: "tail" }, maxBlocks: 4, maxBytes: 32_768 },
  )
  if (range.kind !== "ok") throw new Error("expected an edit range")
  const [block] = range.blocks
  if (block?.kind !== "tool") throw new Error("expected an edit tool block")
  return block
}

describe("bounded file diff protocol", () => {
  it("ships an edit diff whose hunk lines exactly fill the preview budget whole", async () => {
    const block = await editWireBlock(20)

    expect(block.diff).toBe(editDiff(20).diff)
    expect(block.diffOmission).toBeUndefined()
  })

  it("serves a complete interrupted file proposal as its cold-history body", async () => {
    const proposedDiff = { files: [{ id: "file", path: "src/new.ts", action: "add" as const, hunks: [] }] }
    const source: AnyBlock = {
      kind: "tool", id: "write-1", name: "write", presentation: { name: "Write", detail: "src/new.ts" },
      status: "interrupted", timestamp: 1, fileChangeKind: "create", proposedDiff,
    }

    expect(await hydrateDerivedOutputBlockBody(indexOutputBlocks([source]), { blockId: "tool:write-1" }))
      .toEqual({ blockId: "tool:write-1", proposedDiff })
  })
})
