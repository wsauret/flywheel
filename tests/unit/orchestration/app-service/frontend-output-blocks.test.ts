import { describe, expect, it } from "bun:test"
import type { AnyBlock, ToolEntry } from "../../../../src/infra/output-blocks.js"
import { compactGroupChild, projectFrontendOutputBlock } from "../../../../src/orchestration/app-service/frontend-output-blocks.js"
import { hydrateDerivedOutputBlockBody } from "../../../../src/orchestration/app-service/transcript-queries.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder.js"
import { rowPresentation, SHELL_MUTATION_RUNNING } from "../../../../src/protocol/client/file-change-body.js"
import type { MutationEvidence } from "../../../../src/infra/mutation-evidence.js"
import { buildMutationDiffEvidence } from "../../../../src/infra/mutation-diff-evidence.js"

function child(id: string): ToolEntry {
  return { kind: "tool", id, name: "read", presentation: { name: "Read", detail: `${id}.ts` }, status: "completed", timestamp: 1 }
}

function agentGroup(children: ToolEntry[], totalToolCount: number, containerKind: "subagent" | "workflow" = "subagent"): AnyBlock {
  return {
    kind: "agentGroup",
    containerKind,
    id: "agent-1",
    toolUseId: "tu-agent-1",
    label: "Explorer",
    description: "Searching",
    agentType: "explorer",
    status: "active",
    children,
    totalToolCount,
    timestamp: 1,
  }
}

describe("projectFrontendOutputBlock", () => {
  it.each(["modified", "added", "omitted"] as const)("keeps bounded %s evidence on compact children without generating per-file change arrays", (change) => {
    const evidence: MutationEvidence = {
      version: 2, manifest: { version: 1, root: "a".repeat(64), bytes: 20_000_000, entries: 5000 },
      applied: 5000, retainedFiles: change === "omitted" ? 0 : 5000,
      omissions: change === "omitted" ? 5000 : 0, notApplied: 0,
      added: change === "modified" ? 0 : 5000, modified: change === "modified" ? 5000 : 0, removed: 0,
      addedLines: 5000, removedLines: 0, conflictMarkers: 0,
      samples: [{ kind: "applied", path: "a.ts" }, { kind: "applied", path: "b.ts" }, { kind: "applied", path: "c.ts" }],
    }
    const rows = [
      { ...child("memory"), name: "memory", presentation: { name: "Memory", detail: "" }, mutationEvidence: evidence },
      { ...child("shell"), name: "bash", declaresMutation: true as const, mutationEvidence: evidence },
    ].map(compactGroupChild)
    const wire = { children: rows }
    expect(wire.children[0]?.presentation.detail).toBe("a.ts, b.ts, c.ts, and 4997 more files (open Session Changes)")
    expect(rowPresentation(wire.children[1]!, false)).toEqual({
      name: change === "added" ? "Write" : "Edit", detail: "a.ts, b.ts, c.ts, and 4997 more files (open Session Changes)",
    })
    for (const row of wire.children) {
      expect(row.mutationEvidence).toBe(evidence)
      expect(Object.hasOwn(row, "mutationChanges")).toBe(false)
      expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(4096)
    }
  })

  it.each(["y".repeat(4096), "界".repeat(1024)])("defers oversized standalone output without losing its retained body", async (content) => {
    const block: ToolEntry = { ...child("bash"), name: "bash", content }
    const wire = projectFrontendOutputBlock(block)
    expect(wire).toEqual({ ...child("bash"), name: "bash", contentOmittedLines: 1 })
    expect(block.content).toBe(content)
    expect(await hydrateDerivedOutputBlockBody(indexOutputBlocks([block]), { blockId: `tool:${block.id}` })).toEqual({ blockId: `tool:${block.id}`, content })
    const small = { ...block, content: "short output" }
    expect(projectFrontendOutputBlock(small)).toBe(small)
  })

  it("ships only the image count on user rows and leaves plain text rows unchanged", () => {
    const plain = { kind: "userMessage" as const, id: "u1", content: "[Image #1]", timestamp: 1, pending: false, injected: false }
    expect(projectFrontendOutputBlock(plain)).toBe(plain)
    expect(projectFrontendOutputBlock({ ...plain, images: [{ mediaType: "image/png", data: "aGk=" }] })).toEqual({
      ...plain, imageCount: 1,
    })
  })
  it("ships the newest call instead of child rows while preserving the true count", () => {
    const children = Array.from({ length: 12 }, (_, i) => child(`c${i}`))
    children[11] = { ...children[11]!, sentence: { name: "Read", detail: "c11.ts" } }
    const wire = projectFrontendOutputBlock(agentGroup(children, 12))
    if (wire.kind !== "agentGroup") throw new Error("expected agent group")
    expect(wire.children).toEqual([])
    expect(wire).toMatchObject({ activity: { name: "Read", detail: "c11.ts" } })
    expect(wire.totalToolCount).toBe(12)
    expect(wire.agentType).toBe("explorer")
  })

  it("ships no tool rows of a workflow card, which draws its plan instead", () => {
    const children = Array.from({ length: 3 }, (_, i) => child(`c${i}`))
    const wire = projectFrontendOutputBlock(agentGroup(children, 3, "workflow"))
    if (wire.kind !== "agentGroup") throw new Error("expected agent group")
    expect(wire.children).toEqual([])
    expect(wire.totalToolCount).toBe(3)
  })

  it("ships no child rows even for a short run", () => {
    const children = [child("c0"), child("c1")]
    const wire = projectFrontendOutputBlock(agentGroup(children, 2))
    if (wire.kind !== "agentGroup") throw new Error("expected agent group")
    expect(wire.children).toEqual([])
  })

  it("does not inspect children older than the newest call", () => {
    const children = Array.from({ length: 500 }, (_, i) => child(`c${i}`))
    for (let index = 0; index < children.length - 1; index++) {
      Object.defineProperty(children, index, { get: () => { throw new Error("read an undisclosed child") } })
    }
    const wire = projectFrontendOutputBlock(agentGroup(children, 500))
    if (wire.kind !== "agentGroup") throw new Error("expected agent group")
    expect(wire.children).toEqual([])
    expect(wire.totalToolCount).toBe(500)
  })

  it.each(["modified", "added"] as const)("ships each %s child as the compact row both clients render, without its bodies", async (change) => {
    const heavy: ToolEntry = {
      ...child("c0"), name: "bash", presentation: { name: "Bash", detail: "git diff" },
      content: "x".repeat(20_000), invocationBody: { content: "git diff", filetype: "sh" }, diff: "@@", filetype: "diff",
      contentOmittedLines: 3, invocationBodyOmittedBytes: 9, exitCode: 0,
    }
    const memory: ToolEntry = {
      ...child("c1"), name: "memory", presentation: { name: "Memory", detail: "" },
      mutationEvidence: await buildMutationDiffEvidence({ version: 1, files: [{ path: "notes.md", change: "modified", unifiedDiff: "@@ -1 +1 @@\n-a\n+b" }], omissions: [] }, "memory", async () => {}),
    }
    const shellMutation: ToolEntry = {
      ...child("c2"), name: "bash", presentation: { name: "Bash", detail: "python3 reshape.py" }, content: "reshaped", exitCode: 0, declaresMutation: true,
      mutationEvidence: await buildMutationDiffEvidence({ version: 1, files: [{ path: "src/a.ts", change, unifiedDiff: "@@ -1 +1 @@\n-a\n+b" }], omissions: [] }, "shell", async () => {}),
    }
    const wire = { children: [heavy, memory, shellMutation].map(compactGroupChild) }
    expect(wire.children[0]).toEqual({ kind: "tool", id: "c0", name: "bash", presentation: { name: "Bash", detail: "git diff" }, status: "completed", timestamp: 1, exitCode: 0 })
    // A row whose detail came from its mutation keeps that detail, stated once.
    expect(wire.children[1]).toEqual({ kind: "tool", id: "c1", name: "memory", presentation: { name: "Memory", detail: "notes.md" }, status: "completed", timestamp: 1, mutationEvidence: memory.mutationEvidence })
    const presentation = { name: change === "added" ? "Write" : "Edit", detail: "src/a.ts" }
    expect(wire.children[2]).toEqual({ kind: "tool", id: "c2", name: "bash", presentation: { name: "Bash", detail: "src/a.ts" }, status: "completed", timestamp: 1, exitCode: 0, declaresMutation: true, mutationEvidence: shellMutation.mutationEvidence })
    expect(rowPresentation(wire.children[2]!)).toEqual(presentation)
    expect(rowPresentation({ ...wire.children[2]!, presentation: { name: "Bash", detail: "src/a.ts" } })).toEqual(presentation)
  })

  it("keeps a shell mutation's command, so a client names it running and then settled from its own status", () => {
    const running: ToolEntry = { ...child("c3"), name: "bash", presentation: { name: "Bash", detail: "python3 reshape.py" }, status: "pending", declaresMutation: true }
    const row = compactGroupChild(running)
    expect(row.presentation).toEqual({ name: "Bash", detail: "python3 reshape.py" })
    expect(rowPresentation(row, false)).toEqual({ name: "Edit", detail: SHELL_MUTATION_RUNNING })
    // A row the card stops resending settles on the client, which still holds the command.
    expect(rowPresentation({ ...row, status: "completed" }, false)).toEqual({ name: "Bash", detail: "python3 reshape.py" })
  })

  it("passes non-group blocks through unchanged", () => {
    const block: AnyBlock = { kind: "text", id: "t1", content: "hello", timestamp: 1 }
    expect(projectFrontendOutputBlock(block)).toBe(block)
  })
})
