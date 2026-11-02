import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { FrontendOutputBlockSchema, HydratedOutputBlockBodySchema } from "../../../../src/protocol/transcript-protocol-schemas.js"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { projectFrontendOutputBlocks } from "../../../../src/orchestration/app-service/frontend-output-blocks.js"
import { projectBlocksFromEntries } from "../../../../src/orchestration/session/conversation/conversation-block-projection.js"
import { extractDisplayMeta } from "../../../../src/infra/output/structured-event-tool-results.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder.js"
import { SessionChangesQuerySchema } from "../../../../src/protocol/session-changes-protocol-types.js"
import {
  hydrateDerivedOutputBlockBody,
  hydrateDerivedOutputRange,
} from "../../../../src/orchestration/app-service/transcript-queries.js"

describe("mutation transcript protocol", () => {
  it("requires explicit budgets and an initial offset on every Session Changes query", () => {
    const query = { type: "sessionChanges" as const, sessionId: "session-1", offset: 0, maxFiles: 128, maxBytes: 65536 }
    const decode = Schema.decodeUnknownSync(SessionChangesQuerySchema, { onExcessProperty: "error" })
    expect(decode(query)).toEqual(query)
    for (const field of ["offset", "maxFiles", "maxBytes"]) {
      const missing = { ...query }
      Reflect.deleteProperty(missing, field)
      expect(() => decode(missing)).toThrow()
    }
  })
  it("rejects inline applied patches on current rows and body responses", () => {
    const mutation = { version: 1, files: [], omissions: [] }
    const decodeRow = Schema.decodeUnknownSync(FrontendOutputBlockSchema, { onExcessProperty: "error" })
    expect(() => decodeRow({
      kind: "tool", id: "edit", name: "edit", presentation: { name: "Edit", detail: "" },
      status: "completed", timestamp: 1, mutation,
    })).toThrow()
    expect(() => Schema.decodeUnknownSync(HydratedOutputBlockBodySchema, { onExcessProperty: "error" })({
      blockId: "tool:edit", mutation,
    })).toThrow()
  })
  it("serves the same bounded manifest and counts in live rows, historical rows, notices, and body reads", async () => {
    const mutationEvidence = {
      version: 2 as const,
      manifest: { version: 1 as const, root: "a".repeat(64), bytes: 20_000_000, entries: 5000 },
      applied: 5000, retainedFiles: 4999, omissions: 1, notApplied: 0, added: 1, modified: 4999, removed: 0,
      addedLines: 6000, removedLines: 4000, conflictMarkers: 0, samples: [],
    }
    const blocks: AnyBlock[] = [
      { kind: "tool", id: "edit-evidence", name: "edit", presentation: { name: "Edit", detail: "5000 files" },
        status: "completed", timestamp: 1, mutationEvidence },
      { kind: "system", id: "review-evidence", message: "Saved changes", timestamp: 2, mutationEvidence },
    ]
    const history = { ...indexOutputBlocks(blocks), consistencyToken: "sequence:v1" }
    for (const row of projectFrontendOutputBlocks(blocks)) {
      expect(Schema.decodeUnknownSync(FrontendOutputBlockSchema)(
        Schema.encodeUnknownSync(FrontendOutputBlockSchema)(row))).toEqual(row)
    }
    const replayed = projectBlocksFromEntries([
      {
        kind: "message", id: "call", parentId: null, timestamp: "2026-10-16T00:00:00.000Z",
        message: { kind: "assistant", content: [{ type: "tool_use", id: "edit-evidence", name: "edit", input: {} }] },
      },
      {
        kind: "message", id: "result", parentId: "call", timestamp: "2026-10-16T00:00:01.000Z",
        message: { kind: "toolResult", toolUseId: "edit-evidence", content: [{ type: "text", text: "done" }] },
      },
      {
        kind: "message", id: "notice", parentId: "result", timestamp: "2026-10-16T00:00:02.000Z",
        message: { kind: "system", content: "Saved changes", mutationEvidence },
      },
    ], {
      executionCwd: "/workspace",
      toolResultMeta: new Map([["edit-evidence", extractDisplayMeta({ mutationEvidence }, { source: "tool.result.recorded", toolUseId: "edit-evidence" })]]),
    })
    for (const row of replayed) {
      if (row.kind !== "tool" && row.kind !== "system") throw new Error("expected evidence block")
      expect(row.mutationEvidence).toEqual(mutationEvidence)
    }
    const range = await hydrateDerivedOutputRange(history, { anchor: { kind: "tail" }, maxBlocks: 2, maxBytes: 32_768 })
    if (range.kind !== "ok") throw new Error("expected range")
    for (const [index, row] of range.blocks.entries()) {
      const wire = Schema.encodeUnknownSync(FrontendOutputBlockSchema)(row)
      expect(Schema.decodeUnknownSync(FrontendOutputBlockSchema)(wire)).toEqual(blocks[index]!)
      const blockId = index === 0 ? "tool:edit-evidence" : "system:review-evidence"
      const body = await hydrateDerivedOutputBlockBody(history, { blockId })
      expect(body).toEqual({ blockId, mutationEvidence })
      expect(Schema.decodeUnknownSync(HydratedOutputBlockBodySchema)(
        Schema.encodeUnknownSync(HydratedOutputBlockBodySchema)(body))).toEqual(body)
      expect(JSON.stringify(wire).length).toBeLessThan(1024)
    }
  })

  it("suppresses stale legacy diffs when canonical evidence is present", async () => {
    const mutationEvidence = {
      version: 2 as const,
      manifest: { version: 1 as const, root: "a".repeat(64), bytes: 128, entries: 1 },
      applied: 0, retainedFiles: 0, omissions: 1, unknownChanges: 1, notApplied: 0, added: 0, modified: 0, removed: 0,
      addedLines: 0, removedLines: 0, conflictMarkers: 0, samples: [],
    }
    const source: AnyBlock = {
      kind: "tool",
      id: "edit-1",
      name: "edit",
      presentation: { name: "Edit", detail: ".env" },
      status: "completed",
      diff: "-TOKEN=old\n+TOKEN=new",
      filetype: "text",
      mutationEvidence,
      timestamp: 1,
    }
    const history = { ...indexOutputBlocks([source]), consistencyToken: "sequence:v1" }
    const range = await hydrateDerivedOutputRange(history, {
      anchor: { kind: "tail" },
      maxBlocks: 1,
      maxBytes: 32_768,
    })
    if (range.kind !== "ok" || range.blocks[0]?.kind !== "tool") {
      throw new Error("expected edit tool range")
    }

    expect(range.blocks[0].diff).toBeUndefined()
    expect(range.blocks[0].mutationEvidence).toEqual(mutationEvidence)
    expect(await hydrateDerivedOutputBlockBody(history, { blockId: "tool:edit-1" })).toEqual({
      blockId: "tool:edit-1",
      filetype: "text",
      mutationEvidence,
    })
  })
})
