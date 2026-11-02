import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import { DEFAULT_ESTIMATE, estimateFrontendOutputBlockRows } from "../../../../src/tui/hooks/output-height-estimates.js"
import { buildMutationDiffEvidence } from "../../../../src/infra/mutation-diff-evidence.js"

function textBlock(content: string): FrontendOutputBlock {
  return { kind: "text", id: "text-1", content, timestamp: 1 }
}

describe("TUI output height estimates", () => {
  it("counts text line breaks at face value: each one is a rendered row", () => {
    const content = Array.from({ length: 80 }, (_, i) => `- item ${i}`).join("\n")
    expect(estimateFrontendOutputBlockRows(textBlock(content), false)).toBe(80)
  })

  it("estimates thinking and metadata blocks by kind instead of content rows", () => {
    const large = "row\n".repeat(200)
    const thinking: FrontendOutputBlock = { kind: "thinking", id: "thinking-1", content: large, status: "completed", timestamp: 1, completedAt: 2 }
    const group: FrontendOutputBlock = { kind: "agentGroup", containerKind: "subagent", id: "group-1", toolUseId: "group-1", totalToolCount: 0, label: "Agent", description: large, status: "completed", children: [], timestamp: 1 }

    expect(estimateFrontendOutputBlockRows(thinking, false)).toBe(4)
    expect(estimateFrontendOutputBlockRows(group, false)).toBe(DEFAULT_ESTIMATE)
  })

  it("keeps run-folding tools (exec/explore) at the flat estimate: they render as one-line group children", () => {
    const large = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n")
    const bash: FrontendOutputBlock = { kind: "tool", id: "tool-1", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "bun run test" }, status: "completed", timestamp: 1, content: large }
    const read: FrontendOutputBlock = { kind: "tool", id: "tool-6", name: "read", action: "file_read", presentation: { name: "Read", detail: "a.ts" }, status: "completed", timestamp: 1, content: large }

    expect(estimateFrontendOutputBlockRows(bash, true)).toBe(DEFAULT_ESTIMATE)
    expect(estimateFrontendOutputBlockRows(read, true)).toBe(DEFAULT_ESTIMATE)
  })

  it("estimates standalone tool content from the mounted preview only when tool outputs render", () => {
    const large = Array.from({ length: 200 }, (_, i) => `row ${i}`).join("\n")
    const subagent: FrontendOutputBlock = { kind: "tool", id: "tool-1", name: "subagent", presentation: { name: "Subagent", detail: "explorer" }, status: "completed", timestamp: 1, content: large }
    const withDiff: FrontendOutputBlock = { kind: "tool", id: "tool-7", name: "subagent", presentation: { name: "Subagent", detail: "explorer" }, status: "completed", timestamp: 1, content: "a\nb", diff: "@@ -1 +1 @@\n-a\n+b" }

    expect(estimateFrontendOutputBlockRows(subagent, false)).toBe(DEFAULT_ESTIMATE)
    // 20-line preview clamp + header/padding chrome.
    expect(estimateFrontendOutputBlockRows(subagent, true)).toBe(23)
    // Diff and content previews both mount, so they sum: 3 diff + 2 content + chrome.
    expect(estimateFrontendOutputBlockRows(withDiff, true)).toBe(8)
  })

  it("always counts file-write artifact content and diff previews", () => {
    const write: FrontendOutputBlock = { kind: "tool", id: "tool-2", name: "write", presentation: { name: "Write", detail: "a.ts" }, status: "completed", timestamp: 1, content: "a\nb\nc" }
    const edit: FrontendOutputBlock = { kind: "tool", id: "tool-3", name: "edit", presentation: { name: "Edit", detail: "b.ts" }, status: "completed", timestamp: 1, diff: "@@ -1 +1 @@\n-a\n+b" }

    expect(estimateFrontendOutputBlockRows(write, false)).toBe(6)
    expect(estimateFrontendOutputBlockRows(edit, false)).toBe(6)
  })

  it("keeps the single-row estimate for error and handoff entries", () => {
    const large = "row\n".repeat(50)
    const failed: FrontendOutputBlock = { kind: "tool", id: "tool-4", name: "bash", presentation: { name: "Bash", detail: "boom" }, status: "error", errorMessage: "boom", timestamp: 1, content: large }
    const handoff: FrontendOutputBlock = { kind: "tool", id: "tool-5", name: "handoff", presentation: { name: "Handoff", detail: "plan" }, status: "completed", timestamp: 1, content: large }

    expect(estimateFrontendOutputBlockRows(failed, true)).toBe(DEFAULT_ESTIMATE)
    expect(estimateFrontendOutputBlockRows(handoff, true)).toBe(DEFAULT_ESTIMATE)
  })

  it("keeps a collapsed memory mutation at the summary-row estimate", async () => {
    const memory: FrontendOutputBlock = {
      kind: "tool", id: "tool-8", name: "memory", presentation: { name: "Add Memory", detail: "Use Bun for scripts" }, status: "completed", timestamp: 1,
      mutationEvidence: await buildMutationDiffEvidence({ version: 1, files: [{ path: ".flywheel/memory/project.md", change: "modified", unifiedDiff: "@@ -1,2 +1,2 @@\n-a\n+b" }], omissions: [] }, "memory", async () => {}),
    }

    expect(estimateFrontendOutputBlockRows(memory, false)).toBe(DEFAULT_ESTIMATE)
    expect(estimateFrontendOutputBlockRows({ ...memory, content: "captured\noutput" }, true)).toBe(DEFAULT_ESTIMATE)
  })

  it("keeps reference-backed mutation previews stable before lazy windows arrive", () => {
    const mutationEvidence: NonNullable<Extract<FrontendOutputBlock, { kind: "tool" }>["mutationEvidence"]> = {
      version: 2, manifest: { version: 1, root: "a".repeat(64), bytes: 20_000_000, entries: 5000 },
      applied: 5000, retainedFiles: 5000, omissions: 0, notApplied: 0,
      added: 5000, modified: 0, removed: 0, addedLines: 5000, removedLines: 0, conflictMarkers: 0,
      samples: [{ kind: "applied", path: "large.ts" }],
    }
    const memory: FrontendOutputBlock = {
      kind: "tool", id: "reference", name: "memory", presentation: { name: "Memory", detail: "" },
      status: "completed", timestamp: 1, mutationEvidence,
      content: "captured\noutput", diff: "@@ -1 +1 @@\n-before\n+after",
    }
    expect(estimateFrontendOutputBlockRows(memory, true)).toBe(DEFAULT_ESTIMATE)
    expect(estimateFrontendOutputBlockRows({ ...memory, content: undefined, diff: undefined }, true)).toBe(DEFAULT_ESTIMATE)
  })

  it("keeps a collapsed review mutation at the summary-row estimate", async () => {
    const notice: FrontendOutputBlock = {
      kind: "system", id: "notice-1", message: "Updated skill: provider-quirks.", timestamp: 1,
      mutationEvidence: await buildMutationDiffEvidence({ version: 1, files: [{ path: "SKILL.md", change: "modified", unifiedDiff: "@@ -1,2 +1,2 @@\n-a\n+b" }], omissions: [] }, "review", async () => {}),
    }
    const plain: FrontendOutputBlock = { kind: "system", id: "notice-2", message: "Interrupted", timestamp: 1 }

    expect(estimateFrontendOutputBlockRows(notice, false)).toBe(DEFAULT_ESTIMATE)
    expect(estimateFrontendOutputBlockRows(plain, false)).toBe(DEFAULT_ESTIMATE)
  })

  it("counts invocation-body source lines with the first line sharing the header row", () => {
    const codeBlock = (content: string): FrontendOutputBlock => ({ kind: "tool", id: "tool-9", name: "code", presentation: { name: "Code", detail: "" }, status: "completed", timestamp: 1, invocationBody: { content, filetype: "javascript" } })

    expect(estimateFrontendOutputBlockRows(codeBlock("return 1"), false)).toBe(DEFAULT_ESTIMATE)
    expect(estimateFrontendOutputBlockRows(codeBlock(Array.from({ length: 8 }, (_, i) => `const v${i} = ${i}`).join("\n")), false)).toBe(8)
    expect(estimateFrontendOutputBlockRows(codeBlock("const a = 1\nreturn a\n"), false)).toBe(3)
  })
})
