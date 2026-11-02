import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { buildMutationDiffEvidence } from "../../../../src/infra/mutation-diff-evidence"
import { readMutationEvidenceFiles } from "../../../../src/infra/mutation-evidence"
import { readSessionContentRange } from "../../../../src/infra/session-content"
import { projectBlocksFromEntries } from "../../../../src/orchestration/session/conversation/conversation-block-projection"
import type { MessageEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types"
import { sessionContentFixture } from "../../../helpers/session-content"

function entry(id: string, message: MessageEntry["message"], parentId: string | null = null): MessageEntry {
  return { id, parentId, timestamp: "2026-07-02T10:00:00.000Z", kind: "message", message }
}

test("attaches the recorded mutation artifact to a resumed durable-write tool", async () => {
  const cwd = resolve("/scratch/project")
  const { stage, read } = sessionContentFixture()
  const mutation = {
    version: 1 as const,
    files: [{ path: `${cwd}/.flywheel/memory/MEMORY.md`, change: "modified" as const, unifiedDiff: "@@ -1 +1 @@\n-old\n+new" }],
    omissions: [],
  }
  const assistant = entry("call", {
    kind: "assistant",
    content: [{ type: "tool_use", id: "toolu_mem", name: "memory", input: { action: "replace", title: "Refresh a preference" } }],
  })
  const result = entry("result", { kind: "toolResult", toolUseId: "toolu_mem", content: [{ type: "text", text: "{\"success\":true}" }] }, assistant.id)
  const mutationEvidence = await buildMutationDiffEvidence(mutation, "toolu_mem", stage)
  const blocks = projectBlocksFromEntries([assistant, result], {
    executionCwd: cwd,
    toolResultMeta: new Map([["toolu_mem", { mutationEvidence }]]),
  })

  const tool = blocks[0]
  if (tool?.kind !== "tool" || !tool.mutationEvidence) throw new Error("expected tool evidence")
  expect(tool.name).toBe("memory")
  expect(tool.status).toBe("completed")
  const page = await readMutationEvidenceFiles(tool.mutationEvidence, 0, 10, read)
  if (page.kind !== "available") throw new Error("expected mutation files")
  expect(page.files).toHaveLength(1)
  expect(page.nextOffset).toBeNull()
  const file = page.files[0]
  if (file?.kind !== "display" || file.file.patch.kind !== "retained") throw new Error("expected retained patch")
  expect(file.file.path).toBe(`${cwd}/.flywheel/memory/MEMORY.md`)
  expect(tool.presentation.detail).toBe("Refresh a preference")
  expect(tool.mutationEvidence.samples[0]?.path).toBe(".flywheel/memory/MEMORY.md")
  const range = await readSessionContentRange(file.file.patch.reference, 0, 4096, read)
  if (range.kind !== "available") throw new Error("expected patch bytes")
  expect(Buffer.from(range.base64, "base64").toString()).toBe("@@ -1 +1 @@\n-old\n+new")
})
